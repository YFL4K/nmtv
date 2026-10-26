/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import {
  setSettingSwitch,
  setSettingTooltip,
  updateSettingPreservingPanel,
} from '@/lib/artplayer-setting';
import { getSearchConcurrency } from '@/lib/concurrency';
import {
  AnimeOption,
  extractEpisodeNumber,
  extractSeasonFromTitle,
  getDanmakuBySelectedAnime,
  matchAnime,
} from '@/lib/danmaku.client';
import {
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  savePlayRecord,
  saveSkipConfig,
} from '@/lib/db.client';
import {
  AUTO_LEVEL,
  buildQualityOptions,
  decideDownshift,
  describeLevel,
  describeQualityPreference,
  loadPreferredQualityHeight,
  MAX_LEVEL,
  MAX_QUALITY_HEIGHT,
  pickHighestLevelIndex,
  pickLevelIndex,
  resolveLevelHeight,
  savePreferredQualityHeight,
} from '@/lib/hls-quality';
import { describeHlsError, PlaybackRecovery } from '@/lib/playback-recovery';
import { getDefaultPlaybackSaveInterval } from '@/lib/playback-settings';
import {
  getWarmupConcurrency,
  shouldThrottlePrefetch,
} from '@/lib/prefetch-scheduler';
import { matchesFullSearchTitle } from '@/lib/search-title';
import { SearchResult } from '@/lib/types';
import {
  getRequestTimeout,
  getVideoResolutionFromM3u8,
  processImageUrl,
} from '@/lib/utils';
import {
  CACHE_CONCURRENCY_PRESETS,
  clearVideoCache,
  getSegmentProbe,
  loadCacheSettings,
  saveCacheSettings,
  UNLIMITED_HORIZON_SECONDS,
} from '@/lib/video-cache';
import {
  getNextEpisodePrefetcher,
  getVideoPrefetcher,
  PrefetchStats,
} from '@/lib/video-prefetcher';

import { triggerGlobalError } from '@/components/GlobalErrorIndicator';

import { wrapArtplayerPluginDanmuku } from './danmuku-live-font-size';
import {
  bindDeferredProgressSeek,
  PROGRESS_PREVIEW_END,
  PROGRESS_PREVIEW_MOVE,
  ProgressPreviewMove,
} from './deferred-progress-seek';
import { useVideoActions } from './hooks/useVideoActions';
import { useWakeLock } from './hooks/useWakeLock';
import { bindMobileGestures } from './mobile-gestures';
import {
  applyHlsBufferPlan,
  calculateSourceScore,
  createCustomHlsLoader,
  createDanmakuInitialConfig,
  DANMAKU_DENSITY_LABELS,
  DANMAKU_VISIBLE_RESTORE_DELAY_MS,
  formatTime,
  getDanmakuDensity,
  pickDanmakuSettings,
  planCurrentHlsBuffer,
  saveDanmakuSettings,
  setDanmakuDensity,
  SkipConfig,
} from './play-utils';
import { clearPlayerNotices, pushPlayerNotice } from './player-notice';
import { PreviewThumbnailer } from './preview-thumbnailer';

/** 进度条悬停预览浮层的实时状态 */
export interface PlayPreviewState {
  visible: boolean;
  /** 悬停对应的时间点（秒） */
  time: number;
  /** 相对进度条宽度的百分比水平位置（0-100） */
  left: number;
  /** 已抽取的预览图 dataURL；加载中 / 失败为 null */
  image: string | null;
}

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

/**
 * 同一集内最多自动换源次数（P1-5）。
 *
 * 换满仍未成功就停下来提示用户手动选源：如果所有源都挂了，
 * 无上限的自动换源只会把候选列表扫成死循环（A→B→C→A...）。
 */
const MAX_AUTO_SOURCE_SWITCHES = 3;

/**
 * seek 之后这段时间内的 `waiting` 不计入「网络卡顿」（毫秒）。
 *
 * 拖动进度条会让 hls.js 立刻 flush 前向缓冲并重新取分片，落地分片还没到就会
 * 抛一次 `waiting`——它说明的是「刚跳过去、还在下载」，跟带宽够不够无关。
 * 若把它算成卡顿，拖一次进度条就等于报告一次「网络波动」，会把画质一路降到底。
 */
const STALL_GRACE_AFTER_SEEK_MS = 4_000;

/**
 * ABR 换档之后这段时间内的 `waiting` 同样不计入卡顿。
 *
 * hls.js 换档时会 flush 缓冲并重新下载当前片段，这段时间的缓冲停顿是换档
 * 本身造成的，不能反过来当成「带宽还不够」的证据继续往下压档位。
 */
const STALL_GRACE_AFTER_LEVEL_SWITCH_MS = 3_000;

/**
 * 生成只读的设置说明行。
 *
 * Artplayer 的 setting 行默认是可点击选项；说明文字不应被选中，
 * 因此关掉指针事件并隐藏左侧的勾选图标，只作为静态列表展示。
 */
function buildReadonlySettingRows(items: string[]) {
  return items.map((html) => ({
    html,
    mounted: (item: HTMLElement) => {
      item.style.pointerEvents = 'none';
      item.style.justifyContent = 'center';

      const icon = item.querySelector<HTMLElement>(
        '.art-setting-item-left-icon'
      );
      if (icon) icon.style.display = 'none';

      // 说明文字居中展示，而不是沿用设置项的左侧对齐
      const left = item.querySelector<HTMLElement>('.art-setting-item-left');
      if (left) {
        left.style.flex = '1';
        left.style.justifyContent = 'center';
      }
      const text = item.querySelector<HTMLElement>(
        '.art-setting-item-left-text'
      );
      if (text) {
        text.style.width = '100%';
        text.style.textAlign = 'center';
      }
      const right = item.querySelector<HTMLElement>('.art-setting-item-right');
      if (right) right.style.display = 'none';
    },
  }));
}

/** 「画质」设置项的 name，`setting.update` 靠它定位 */
const QUALITY_SETTING_NAME = '画质';

/** 「视频缓存」设置项的 name */
const CACHE_SETTING_NAME = '视频缓存';

/** 「弹幕源」设置项的 name */
const DANMAKU_SETTING_NAME = '弹幕源';

/** 自动加载弹幕的常驻提示文案 */
const DANMAKU_LOADING_NOTICE_TEXT = '正在自动加载弹幕…';

/** 手动选择弹幕源时的常驻提示文案 */
const DANMAKU_MANUAL_LOADING_NOTICE_TEXT = '正在加载弹幕…';

/**
 * 下一集预热的覆盖时长（秒）。
 *
 * 这是唯一还保留时间上限的地方：预热只是为了"切过去不卡"，没必要把整集
 * 都拉下来。当前集的预取已改为不设上限（缓存到片尾）；用户真切过去之后，
 * 当前集预取器会接管，按无限视野继续往后铺。
 */
const NEXT_EPISODE_HORIZON_SECONDS = 420;

/**
 * 会话级的「上次播放的影片」标记（`source:id`）。
 *
 * 换片通常是回列表再进播放页，`usePlayEngine` 会整页重新挂载，ref 里的
 * 上一次播放位置拿不到；只能靠会话存储判断「上一部片是不是另一部」，
 * 否则新影片开始播放时，上一部片的缓存会一直留在本地。
 */
const LAST_CACHE_VIDEO_KEY = 'moontv:last-cache-video';

/** 首次进入播放页时提示一次帮助入口 */
const HELP_TIP_SEEN_KEY = 'moontv:help-tip-seen';

function readLastCacheVideoKey(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_CACHE_VIDEO_KEY);
  } catch {
    return null;
  }
}

function writeLastCacheVideoKey(videoKey: string): void {
  try {
    window.sessionStorage.setItem(LAST_CACHE_VIDEO_KEY, videoKey);
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用，仅影响换片清理，忽略即可。
  }
}

/**
 * 组装「视频缓存」设置项的 tooltip 文案。
 *
 * `hitRate` 为 null 表示还没有任何片段请求，因此没有命中率可展示。
 */
function buildCacheTooltip(
  stats: PrefetchStats,
  hitRate: number | null
): string {
  switch (stats.state) {
    case 'disabled':
      return stats.message || '已关闭';
    case 'parsing':
      return '解析播放列表中...';
    case 'error':
      return stats.message || '缓存不可用';
    case 'idle':
      return '未开始';
    default:
      break;
  }

  if (stats.total === 0) return '未开始';

  const coverPart =
    stats.coverTo > 0 ? ` · 已覆盖 ${formatTime(stats.coverTo)}` : '';
  // 个别分片坏掉不会终止整轮，但要让用户知道有缺口，而不是以为缓存完整。
  const failedPart = stats.failed > 0 ? ` · ${stats.failed} 段失败` : '';
  const hitPart =
    hitRate === null ? '' : ` · 命中 ${Math.round(hitRate * 100)}%`;
  return `${stats.cached}/${stats.total} 段${coverPart}${failedPart}${hitPart}`;
}

/**
 * 播放页引擎。
 *
 * 负责播放页的全部核心逻辑：源加载/优选、剧集切换、ArtPlayer 生命周期、
 * 弹幕自动匹配、去广告、跳过片头片尾、播放记录、键盘快捷键与状态清理等。
 *
 * 返回一个包含渲染所需状态/回调的对象，供 {@link PlayClient} 组合展示。
 */
export function usePlayEngine() {
  const searchParams = useSearchParams();

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<
    'searching' | 'preferring' | 'fetching' | 'ready'
  >('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在搜索播放源...');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);
  const [isDanmakuPluginReady, setIsDanmakuPluginReady] = useState(false);
  const [isDanmakuLoading, setIsDanmakuLoading] = useState(false);
  /** 弹幕加载来源：自动匹配 / 手动选择，决定加载提示文案 */
  const [danmakuLoadingKind, setDanmakuLoadingKind] = useState<
    'auto' | 'manual'
  >('auto');

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<SkipConfig>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  const restartPrefetchForSkipRef = useRef<(() => void) | null>(null);
  /** 已提示过的缓存停止原因（状态 + 文案），避免同一原因反复闪现 */
  const cacheNoticeRef = useRef<string | null>(null);
  /** 进入播放页时是否已就「缓存已开启」提示过（切集不重复） */
  const cacheEnabledNoticeShownRef = useRef(false);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
    restartPrefetchForSkipRef.current?.();
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);
  // 预缓存窗口续跑的时间间隔控制（播放自然推进时定期检查窗口余量）
  const lastPrefetchCheckRef = useRef(0);
  // —— 弱网自动降档 ——
  // 最近 2 分钟内的卡顿时间戳；反复卡顿时把 ABR 上限压一档，宁可糊一点不要一直转圈
  const stallTimesRef = useRef<number[]>([]);
  // 记录已提示过的降档状态，避免 notice 反复弹
  const downshiftNoticeRef = useRef<string | null>(null);
  // 最近一次 seek / ABR 换档的时间戳：用于把「seek、换档引起的重新缓冲」
  // 与「播放中真的网络跟不上」区分开，见 STALL_GRACE_AFTER_* 常量。
  const lastSeekAtRef = useRef(0);
  const lastLevelSwitchAtRef = useRef(0);

  const [isBlockAdChanged, setIsBlockAdChanged] = useState(false);
  /**
   * 「去广告」开关。
   *
   * 开启后从点播播放列表中剔除广告分片，识别依据：
   *  - SCTE-35 `#EXT-X-CUE-OUT` / `#EXT-X-CUE-IN` 广告窗；
   *  - 广告特征 URL（`/ad/`、`preroll`、`guanggao` 等）；
   *  - 被长内容夹住的 15–30s 中插短块。
   * 不连续标记、KEY、MAP 全部保留，因此不会产生旧实现那种时间轴空洞。
   *
   * 使用 v2 key：旧 key 对应"只删 `#EXT-X-DISCONTINUITY`"的旧实现，
   * 不再沿用旧值。
   */
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad_v2');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 视频预缓存（Cache Storage）。
  // 预取器与播放状态完全解耦：视频暂停、页面切后台时仍会继续把前向片段写进缓存。
  // 进度不走 React state——它会以 250ms 的节奏回调，走 state 会让整页高频重渲染，
  // 这里直接更新 ArtPlayer 的设置项 tooltip。
  const prefetcherRef = useRef(getVideoPrefetcher());
  const cacheClearPromiseRef = useRef<Promise<void> | null>(null);
  /** 上次触发缓存清理时的播放位置：影片标识 + 集数 */
  const previousCacheEpisodeRef = useRef<{
    videoKey: string;
    episodeIndex: number;
  } | null>(null);

  // 下一集预热（落地路线第 3 步）。独立实例，避免打断当前集的队列。
  // `nextWarmupKeyRef` 记录"已经为哪一集的哪个档位预热过"，防止重复排队。
  const nextWarmupKeyRef = useRef<string | null>(null);

  // 弹幕源选择相关
  const [selectedDanmakuSource, setSelectedDanmakuSource] = useState<
    string | null
  >(null);
  const [selectedDanmakuAnime, setSelectedDanmakuAnime] =
    useState<AnimeOption | null>(null);
  const [selectedDanmakuEpisode, setSelectedDanmakuEpisode] = useState<
    number | undefined
  >(undefined);
  const [showDanmakuSelector, setShowDanmakuSelector] = useState(false);
  /** 手动选择弹幕源的版本号：即使重复选中同一番剧/集数也重新走一遍加载流程 */
  const [danmakuSelectNonce, setDanmakuSelectNonce] = useState(0);
  const [showCacheManager, setShowCacheManager] = useState(false);
  const selectedDanmakuSourceRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 同步 ref
  useEffect(() => {
    selectedDanmakuSourceRef.current = selectedDanmakuSource;
  }, [selectedDanmakuSource]);

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  const [videoDoubanId, setVideoDoubanId] = useState(0);
  // 当前源和ID
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');

  // 集数相关
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);

  // 自动匹配弹幕设置
  const [autoDanmakuEnabled, setAutoDanmakuEnabled] = useState(false);
  const [preferredDanmakuPlatform, setPreferredDanmakuPlatform] =
    useState('bilibili1');

  const [currentTooltip, setCurrentTooltip] = useState('');
  const [selectedState, setSelectedState] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const savedAuto = localStorage.getItem('autoDanmakuEnabled');
    if (savedAuto !== null) {
      setAutoDanmakuEnabled(JSON.parse(savedAuto));
    }

    const savedPlatform = localStorage.getItem('preferredDanmakuPlatform');
    if (savedPlatform) {
      setPreferredDanmakuPlatform(savedPlatform);
    }
  }, []);

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);

  // 用户手动/自动选择弹幕番剧后，加载对应集的弹幕
  useEffect(() => {
    if (!selectedDanmakuAnime || !detail) return;

    const currentEpisodeTitle = detail?.episodes_titles?.[currentEpisodeIndex];
    if (!currentEpisodeTitle) return;

    let matchedEpisode: any = null;
    /** 是否为用户手动选择：与切集自动加载一致，先隐藏旧弹幕、显示加载提示 */
    let isManualSelect = false;

    /** ① 用户手动选择某一集（权重大最高） */
    if (selectedDanmakuEpisode !== undefined && selectedState) {
      matchedEpisode =
        selectedDanmakuAnime.episodes[selectedDanmakuEpisode - 1];
      isManualSelect = true;
      setSelectedState(false);
    } else if (autoDanmakuEnabled) {
      /** ② 自动匹配模式：直接使用第 0 集 */
      matchedEpisode = selectedDanmakuAnime.episodes[0];
    }

    if (!matchedEpisode) return;

    const episodeIndex = selectedDanmakuAnime.episodes.indexOf(matchedEpisode);
    const episodeNumber = episodeIndex + 1;

    // 更新 tooltip（走 DOM setter，不触发面板重建）
    setTimeout(() => {
      setSettingTooltip(
        artPlayerRef.current,
        DANMAKU_SETTING_NAME,
        matchedEpisode.episodeTitle
      );
    }, 100);

    // 加载弹幕 URL
    (async () => {
      try {
        const url = await getDanmakuBySelectedAnime(
          selectedDanmakuAnime,
          episodeNumber,
          'xml'
        );
        const inst = danmukuPluginInstanceRef.current;

        // 插件未就绪时无法加载，避免手动选择后一直停留在「加载中」
        if (!inst) {
          if (isManualSelect) setIsDanmakuLoading(false);
          return;
        }

        // 与当前已加载的弹幕源相同：无需重新加载，直接恢复可见性
        if (url === lastDanmakuUrlRef.current) {
          if (isManualSelect) {
            setIsDanmakuLoading(false);
            scheduleDanmakuVisibleRestore();
          }
          return;
        }

        // 手动选择时与切集自动加载一致：先隐藏旧弹幕并提示加载
        if (isManualSelect) beginManualDanmakuLoad();

        console.log('动态更新弹幕源:', url);
        inst.config({ danmuku: url });

        // 切集/手动选择时弹幕已隐藏，load() 内部会在远端返回后 reset 并写入
        // 新队列，完成后再恢复可见性，因此这里不需要额外 reset（避免重复清屏卡顿）
        inst
          .load()
          .then(() => {
            if (lastDanmakuUrlRef.current === url) {
              if (isManualSelect) setIsDanmakuLoading(false);
              scheduleDanmakuVisibleRestore();
            }
          })
          .catch((e: unknown) => {
            console.error('加载弹幕失败:', e);
            if (lastDanmakuUrlRef.current === url) {
              // 加载失败时清空旧集弹幕再恢复，避免恢复后显示错误内容
              try {
                inst.reset?.();
              } catch (_) {
                // 忽略：插件版本差异
              }
              if (isManualSelect) setIsDanmakuLoading(false);
              scheduleDanmakuVisibleRestore();
            }
          });

        lastDanmakuUrlRef.current = url;
        setCurrentTooltip(matchedEpisode.episodeTitle);
      } catch (e) {
        console.error('获取弹幕 URL 失败:', e);
        // 手动选择失败时同样要恢复弹幕，避免一直处于隐藏状态
        if (isManualSelect) {
          setIsDanmakuLoading(false);
          scheduleDanmakuVisibleRestore();
        }
      }
    })();
  }, [
    currentEpisodeIndex,
    selectedDanmakuAnime,
    selectedDanmakuEpisode,
    danmakuSelectNonce,
  ]);

  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  // 切集/换片时清空"已试过的源"与"自动换源次数"：
  // 某个源只是这一集挂了，不代表下一集也挂，不该把惩罚带到下一集。
  useEffect(() => {
    const previous = previousCacheEpisodeRef.current;
    const videoKey = `${currentSource}:${currentId}`;
    const hasVideoIdentity = Boolean(currentSource && currentId);
    // 换片一般会整页重新挂载，此时 previous 还是空的，
    // 用会话里记下的上一部片补出「换片」这个事实；
    // 连会话记忆都没有（新标签页/新会话）说明本次播放与之前无从比对，
    // 同样按换片处理，顺手清掉上一次会话残留的缓存。
    const previousVideoKey =
      previous !== null ? previous.videoKey : readLastCacheVideoKey();
    previousCacheEpisodeRef.current = {
      videoKey,
      episodeIndex: currentEpisodeIndex,
    };
    if (hasVideoIdentity) writeLastCacheVideoKey(videoKey);
    // 切集、换片或换源立即中止旧下载，是否删除已落盘缓存由清理开关单独决定。
    prefetcherRef.current.stop();
    getNextEpisodePrefetcher().stop();
    // 集号变了要清（保留新的当前集与下一集预热）；
    // 换了一部影片（源或 id 变了）时，上一部片的缓存没有任何复用价值，
    // 即便集号恰好相同也必须清掉。
    const isDifferentEpisode =
      previous !== null && previous.episodeIndex !== currentEpisodeIndex;
    const isDifferentVideo = previousVideoKey !== videoKey;
    if (
      hasVideoIdentity &&
      (isDifferentEpisode || isDifferentVideo) &&
      loadCacheSettings().autoClearOnEpisodeChange
    ) {
      const previousClear = cacheClearPromiseRef.current;
      const stopped = Promise.all([
        prefetcherRef.current.stopAndWait(),
        getNextEpisodePrefetcher().stopAndWait(),
      ]);
      // 新当前集可能正是已预热的下一集，同时保留它之后一集的预热。
      const episodePrefix = videoKey;
      const keepEpisodeKeys = [
        `${episodePrefix}:${currentEpisodeIndex}`,
        `${episodePrefix}:${currentEpisodeIndex + 1}`,
      ];
      const clearing = (async () => {
        await previousClear;
        await stopped;
        await clearVideoCache(keepEpisodeKeys);
      })().catch((error) => {
        console.error('切集/换片自动清理缓存失败:', error);
      });
      cacheClearPromiseRef.current = clearing;
      void clearing.finally(() => {
        if (cacheClearPromiseRef.current === clearing) {
          cacheClearPromiseRef.current = null;
        }
      });
    }
    triedSourcesRef.current = new Set();
    autoSwitchCountRef.current = 0;
    // 切集/换源后"下一集"的目标变了，旧的预热队列立刻作废。
    // 已经落盘的分片不受影响（缓存键与集数无关），不会白费。
    nextWarmupKeyRef.current = null;
    getNextEpisodePrefetcher().stop();
  }, [currentEpisodeIndex, currentSource, currentId]);

  // 视频播放地址
  const [videoUrl, setVideoUrl] = useState('');

  // 总集数
  const totalEpisodes = detail?.episodes?.length || 0;

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量，默认 0.7
  const lastVolumeRef = useRef<number>(0.7);
  // 上次使用的播放速率，默认 1.0
  const lastPlaybackRateRef = useRef<number>(1.0);
  const lastFullscreenRef = useRef<boolean>(false);
  const lastFullscreenWebRef = useRef<boolean>(false);
  // 弹幕插件配置：默认配置叠加本地持久化的用户设置，保证刷新后自动恢复
  const danmakuConfigRef = useRef<any>(createDanmakuInitialConfig());

  // 换源相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 自动换源的候选列表（P1-5）：必须走 ref，因为读取它的是注册在
  // ArtPlayer 创建时（早于后续渲染）的 HLS 错误回调。
  useEffect(() => {
    availableSourcesRef.current = availableSources;
  }, [availableSources]);

  // 当前集数的播放地址。监听器（timeupdate/seeked/pause）是在创建播放器
  // 那一刻注册的，闭包里的 videoUrl 会随切集而过期；预取必须按实时地址走，
  // 否则会把上一集的片段写进缓存，白烧带宽。
  const currentVideoUrlRef = useRef<string>('');
  useEffect(() => {
    currentVideoUrlRef.current = videoUrl;
  }, [videoUrl]);

  // 保存优选时的测速结果，避免EpisodeSelector重复测速
  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<
    Map<string, { quality: string; loadSpeed: string; pingTime: number }>
  >(new Map());

  // 换源加载状态
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [videoLoadingStage, setVideoLoadingStage] = useState<
    'initing' | 'sourceChanging' | 'optimizing'
  >('initing');

  // 播放进度保存相关
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(0);

  const artPlayerRef = useRef<any>(null);
  const artRef = useRef<HTMLDivElement | null>(null);
  /** ArtPlayer 根节点，供把返回/标题 portal 进播放器（全屏也能看见） */
  const [playerHost, setPlayerHost] = useState<HTMLElement | null>(null);
  const danmukuPluginInstanceRef = useRef<any>(null); // 弹幕插件实例

  // ---- 进度条悬停预览 ----
  const previewThumbnailerRef = useRef<PreviewThumbnailer | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);
  const [preview, setPreview] = useState<PlayPreviewState | null>(null);
  const lastDanmakuUrlRef = useRef<string>(''); // 上一次加载的弹幕 URL
  const pendingDanmakuVisibleRestoreRef = useRef<boolean | null>(null); // 切集后待恢复的弹幕可见状态

  // ---- P1-5 / P1-6 相关 ----
  /** 当前 HLS 实例的错误恢复状态机（换源/重建时销毁重建） */
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  /** 最近一次渲染的 availableSources，供早于本轮渲染注册的回调读取 */
  const availableSourcesRef = useRef<SearchResult[]>([]);
  /** 最近一次渲染的 handleSourceChange，供 HLS 错误回调读取（避免闭包过期） */
  const handleSourceChangeRef = useRef<
    | ((
        newSource: string,
        newId: string,
        newTitle: string,
        options?: { auto?: boolean }
      ) => Promise<void>)
    | null
  >(null);
  /** 本集内已经尝试过的源（`source:id`），防止自动换源来回横跳 */
  const triedSourcesRef = useRef<Set<string>>(new Set());
  /** 本集内已自动换源次数 */
  const autoSwitchCountRef = useRef<number>(0);
  /** 当前期望的画质高度，null 表示自动 */
  const preferredHeightRef = useRef<number | null>(
    loadPreferredQualityHeight()
  );
  const isEpisodeSwitchingRef = useRef(false); // 标记当前是否为切集切换
  const danmakuVisibleRestoreTimerRef = useRef<NodeJS.Timeout | null>(null); // 延迟恢复弹幕可见性的定时器

  // Wake Lock（屏幕常亮）
  const { requestWakeLock, releaseWakeLock } = useWakeLock();

  // 切换集数时临时隐藏弹幕，待弹幕获取成功后恢复
  const hideDanmakuDuringEpisodeSwitch = () => {
    if (danmakuVisibleRestoreTimerRef.current) {
      clearTimeout(danmakuVisibleRestoreTimerRef.