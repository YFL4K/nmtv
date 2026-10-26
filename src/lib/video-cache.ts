/**
 * 视频片段本地缓存层。
 *
 * 职责边界：Cache Storage 读写 + IndexedDB 元数据 + LRU 淘汰 + 设置持久化。
 * 不做任何与播放器状态相关的判断，因此可以在视频暂停、页面切到后台时继续工作。
 *
 * 关于「为什么不用 Service Worker」：
 *   1. 代码里本来就在替换 hls.js 的 loader（做去广告），叠加 cache-first 零注册成本；
 *   2. next-pwa 的 dest 是 public，会在生产构建时覆盖手写的 public/sw.js，scope 会冲突；
 *   3. 跨域片段经 SW 拦截拿到的是 opaque response，cache.put 存不了内容。
 */

import {
  type MediaProfile,
  MEDIA_PROFILE_HEAD_BYTES,
  parseMediaProfileHead,
  probeSegmentProfile,
  readResponseHeadBytes,
  rememberSegmentProfile,
} from './segment-media-probe';
import { type SegmentByteRange } from './video-byte-range';

/** 片段响应体的 Cache Storage 桶名 */
export const VIDEO_CACHE_NAME = 'moontv-video-v1';

const META_DB = 'moontv-video-meta';
const META_VERSION = 1;
const META_STORE = 'segments';

export const CACHE_SETTINGS_KEY = 'video_cache_settings';

export interface SegmentMeta {
  /** Cache Storage 中的 key（同源代理 URL 或源站绝对 URL） */
  key: string;
  /** 剧集标识 `${source}:${id}:${episodeIndex}`，用于按集淘汰 */
  episodeKey: string;
  /** 影片标题，用于缓存面板展示 */
  title?: string;
  /** 影视源说明文字，用于缓存面板展示 */
  source?: string;
  /** 片段序号（1 基，便于排查） */
  index: number;
  /** 片段在视频中的实际起止时间（秒），旧缓存可能没有 */
  startTime?: number;
  endTime?: number;
  /** 字节数 */
  bytes: number;
  /** 预取时的实际耗时(ms)，用于给 hls.js 合成 LoaderStats，避免 ABR 高估带宽 */
  costMs: number;
  /** 最后访问时间戳，LRU 依据 */
  lastAccess: number;
}

/**
 * 前向缓存"不设上限"的哨兵值。
 *
 * 传 0 表示一直往后铺，直到播放列表最后一个分片；播放推进时只做增量续跑，
 * 暂停、页面切到后台都不会让队列停下来。真正的兜底交给字节上限
 * （`maxBytesPerEpisode` / `maxTotalBytes`）与 LRU 淘汰，而不是时间。
 */
export const UNLIMITED_HORIZON_SECONDS = 0;

/** 缓存并发档位：只提供低/中/高三档，不开放任意数值 */
export type CacheConcurrencyMode = 'low' | 'medium' | 'high';

/**
 * 档位与分片并发数的对应关系（设置界面与调度器共用同一份定义）。
 *
 * 取值依据（采集站 HLS 的实际分布：分片 0.5–5 MB，偶尔到 8–12 MB；
 * 1080p 常见码率 2.5–6 Mbps，分片 4–10 s）：
 *
 * - 预取只需追上播放码率（1080p ≈ 0.6 MB/s），2 路就能覆盖实时预取，
 *   所以低档取 2，给弱网/省流留一档不抢带宽的选择；
 * - 中档 4 路是日常默认：按单分片 3 MB、单请求 ~0.6 s 计，
 *   4 路 ≈ 20 MB/s，一部 40 分钟、2.25 GB 的 1080p 约 2 分钟补齐视野，
 *   同时不会让播放器的 hls 请求排在大量预取后面；
 * - 高档 8 路用于批量预热：8 路足以跑满 50–100 Mbps 的家用带宽，
 *   再往上只是把 0.5–5 MB 的小分片堆成排队，收益递减而尾延迟变差。
 */
export const CACHE_CONCURRENCY_PRESETS: Record<CacheConcurrencyMode, number> = {
  low: 2,
  medium: 4,
  high: 8,
};

export interface CacheSettings {
  /** 总开关 */
  enabled: boolean;
  /** 切换集数或换片时清理缓存，保留当前集与下一集预热 */
  autoClearOnEpisodeChange: boolean;
  /** 分片下载并发数，由 concurrencyMode 决定（2 / 4 / 8），只读派生值 */
  concurrency: number;
  /** 并发档位 */
  concurrencyMode: CacheConcurrencyMode;
  /**
   * 前向缓存目标时长（秒）。
   *
   * `UNLIMITED_HORIZON_SECONDS`（0）= 不设时间上限，缓存到片尾。
   */
  horizonSeconds: number;
  /** 单集最大占用（字节） */
  maxBytesPerEpisode: number;
  /** 全部缓存最大占用（字节） */
  maxTotalBytes: number;
  /** 直连失败时是否允许同源代理兜底；同时决定缓存键格式以兼容旧缓存 */
  useProxy: boolean;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  autoClearOnEpisodeChange: false,
  concurrency: CACHE_CONCURRENCY_PRESETS.low,
  concurrencyMode: 'low',
  // 默认不设时间上限：暂停后一直往后缓存，直到片尾或触发字节上限淘汰
  horizonSeconds: UNLIMITED_HORIZON_SECONDS,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 3 * 1024 * 1024 * 1024,
  useProxy: true,
};

function clampNumber(
  value: unknown,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* 设置读写                                                             */
/* ------------------------------------------------------------------ */

export function loadCacheSettings(): CacheSettings {
  if (typeof window === 'undefined') return DEFAULT_CACHE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(CACHE_SETTINGS_KEY);
    if (!raw) return DEFAULT_CACHE_SETTINGS;
    return normalizeCacheSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_CACHE_SETTINGS;
  }
}

/** 把任意并发数收敛到最接近的预设档位 */
export function closestConcurrencyMode(value: number): CacheConcurrencyMode {
  const modes: CacheConcurrencyMode[] = ['low', 'medium', 'high'];
  let best: CacheConcurrencyMode = modes[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const mode of modes) {
    const distance = Math.abs(CACHE_CONCURRENCY_PRESETS[mode] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = mode;
    }
  }
  return best;
}

/**
 * 解析并发档位。
 *
 * 旧版本支持"自定义并发"，存量配置里可能是 `concurrencyMode: 'custom'`
 * 加一个 `customConcurrency`（也可能是更早的只存 `concurrency`）。
 * 现在只保留三档预设，这些历史值一律按最接近的档位收敛，
 * 保证升级后不会因为字段缺失回落到 1 路。
 */
function normalizeConcurrencyMode(
  raw: Record<string, unknown>
): CacheConcurrencyMode {
  const mode = raw.concurrencyMode;
  if (mode === 'low' || mode === 'medium' || mode === 'high') return mode;
  if (mode !== undefined && mode !== 'custom') {
    return DEFAULT_CACHE_SETTINGS.concurrencyMode;
  }
  const legacy = clampNumber(
    raw.customConcurrency ?? raw.concurrency,
    1,
    Number.MAX_SAFE_INTEGER
  );
  return legacy === undefined
    ? DEFAULT_CACHE_SETTINGS.concurrencyMode
    : closestConcurrencyMode(legacy);
}

/** 对可能不可信的配置做字段级校验，避免脏数据导致配额失控 */
export function normalizeCacheSettings(input: unknown): CacheSettings {
  if (!input || typeof input !== 'object') return DEFAULT_CACHE_SETTINGS;
  const raw = input as Record<string, unknown>;

  const settings: CacheSettings = { ...DEFAULT_CACHE_SETTINGS };

  if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled;
  if (typeof raw.autoClearOnEpisodeChange === 'boolean') {
    settings.autoClearOnEpisodeChange = raw.autoClearOnEpisodeChange;
  }
  if (typeof raw.useProxy === 'boolean') settings.useProxy = raw.useProxy;

  // 并发只能来自三档预设，写入端的 concurrency 字段被忽略并重新派生。
  settings.concurrencyMode = normalizeConcurrencyMode(raw);
  settings.concurrency = CACHE_CONCURRENCY_PRESETS[settings.concurrencyMode];

  const horizon = clampNumber(raw.horizonSeconds, 0, 7200);
  if (horizon !== undefined) {
    // 0 是「无限」哨兵，必须原样保留；其余值低于 1 分钟没有意义，抬到 60s
    settings.horizonSeconds =
      horizon === 0
        ? UNLIMITED_HORIZON_SECONDS
        : Math.max(60, Math.round(horizon));
  }

  const perEpisode = clampNumber(
    raw.maxBytesPerEpisode,
    50 * 1024 * 1024,
    8 * 1024 ** 3
  );
  if (perEpisode !== undefined)
    settings.maxBytesPerEpisode = Math.round(perEpisode);

  const total = clampNumber(
    raw.maxTotalBytes,
    100 * 1024 * 1024,
    20 * 1024 ** 3
  );
  if (total !== undefined) settings.maxTotalBytes = Math.round(total);

  if (settings.maxBytesPerEpisode > settings.maxTotalBytes) {
    settings.maxBytesPerEpisode = settings.maxTotalBytes;
  }

  return settings;
}

export function saveCacheSettings(next: Partial<CacheSettings>): CacheSettings {
  const merged = normalizeCacheSettings({ ...loadCacheSettings(), ...next });
  try {