/**
 * PHILIA 自动轮询 hook(模块级单例)
 *
 * 规则:
 *  - 轮询时段: 每日 09:14:00(含) 至 15:01:00(不含)
 *  - 轮询频率: 每 POLL_INTERVAL_MIN(2) 分钟触发一次 onTick
 *  - 防漂移: 以"距下一个 2 分钟边界的毫秒数"自校正调度, 而非固定 setInterval, 避免时间漂移累积
 *  - 防并发: 上一轮 onTick 仍在途时跳过本轮触发(避免 LLM 分析重叠重复计费)
 *  - 跨页/跨实例去重: 用 Web Locks(ifAvailable)持有独占锁到本轮结束, 全局同一时刻仅一个标签页/实例调 LLM;
 *             极老浏览器回退 localStorage 时间戳去重
 *  - 单例: 开关/状态/定时器为模块级共享。主面板与悬浮小窗(同一 children 被渲染两份)共用同一份轮询状态,
 *          避免"小窗显示轮询中、主面板不同步"的错位; 也只有一份定时器, 不会重复触发。
 *  - 时段校准: 每 30s 复核一次是否处于轮询时段(收盘后自动停、次日开盘自动恢复)
 *  - 状态记忆: 用户开关持久化到 localStorage, 页面刷新后保持
 *  - 首轮调度: 开启后仅排到下一个本地时钟整分边界(偶数分钟)触发。不做挂载立即补拉、也不在开启瞬间补拉,
 *          保证轮询节奏始终以本地时钟整分为准, 与用户进入/开启程序的时刻无关
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

/** 轮询时段(分钟): 09:14(含) 至 15:01(不含) */
const POLL_START_MIN = 9 * 60 + 14;
const POLL_END_MIN = 15 * 60 + 1;
/** 轮询间隔(分钟): 每 2 分钟一次 */
const POLL_INTERVAL_MIN = 2;
/** 时段校准周期: 30s */
const WINDOW_CHECK_MS = 30 * 1000;
/** 开关状态持久化 key */
const LS_KEY = "dash:philia-poll";
/** 跨标签页轮询去重锁 key: 记录最近一次开始轮询的时间戳, 避免多开页面各自调 LLM 导致调用倍增 */
const POLL_LOCK_KEY = "dash:philia-poll-lock";

/** 是否刚有其他标签页开始过轮询(在 POLL_INTERVAL_MIN 周期内) */
function isPollLockedByOther(): boolean {
  try {
    const raw = localStorage.getItem(POLL_LOCK_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < POLL_INTERVAL_MIN * 60 * 1000;
  } catch {
    return false;
  }
}

/** 记录本标签页最近一次开始轮询的时间戳(供其他标签页去重) */
function acquirePollLock(): void {
  try {
    localStorage.setItem(POLL_LOCK_KEY, String(Date.now()));
  } catch {
    /* 隐私/配额受限时忽略 */
  }
}

/** 当前时刻是否处于轮询时段(含起始 09:14, 不含结束 15:01) */
export function inPhiliaPollWindow(d = new Date()): boolean {
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= POLL_START_MIN && m < POLL_END_MIN;
}

/** 距下一个 POLL_INTERVAL_MIN 分钟边界还有多少毫秒(对齐边界、避免漂移) */
function msUntilNextSlot(): number {
  const now = new Date();
  // 对齐到 interval 分钟的整数边界(如每 2 分钟: 偶数分钟点火)
  const offset = now.getMinutes() % POLL_INTERVAL_MIN;
  const secs = (POLL_INTERVAL_MIN - offset) * 60 - now.getSeconds();
  return secs * 1000 - now.getMilliseconds();
}

/** 读取持久化的开关状态(默认关闭) */
function loadPersisted(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
}

/* ---------- 模块级单例共享状态 ---------- */
let sharedEnabled = loadPersisted();
let sharedActive = inPhiliaPollWindow();
let sharedLastTick = 0;
let sharedTransition = false;

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** 最新注册的 onTick(各实例的 pollRefresh 行为一致, 仅最新生效, 避免重复调 LLM) */
let activeOnTick: (() => void) | null = null;
/** 单例在途标记: 上一轮未结束时跳过本轮 */
let inFlightS = false;
/** 单例定时器是否已启动(全局仅一份) */
let timerStarted = false;

/** 执行一轮轮询(带 Web Locks 去重, 锁持有到本轮结束) */
function runPollOnce(): void {
  const doPoll = () => {
    inFlightS = true;
    sharedLastTick = Date.now();
    notify();
    Promise.resolve()
      .then(() => activeOnTick?.())
      .catch(() => {
        /* 轮询失败静默, 由调用方保持当前内容稳定 */
      })
      .finally(() => {
        inFlightS = false;
        notify();
      });
  };
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") {
    navigator.locks
      .request(POLL_LOCK_KEY, { ifAvailable: true }, (lock) => {
        if (!lock) return undefined; // 未拿到锁: 其他标签页/实例在轮询, 本轮跳过
        return Promise.resolve().then(doPoll); // 返回 promise 以持有锁直到本轮结束
      })
      .catch(() => {
        /* 锁请求异常不应阻断后续调度 */
      });
  } else if (!isPollLockedByOther()) {
    // 无 Web Locks 环境(极老浏览器)回退: 用 localStorage 时间戳去重
    acquirePollLock();
    doPoll();
  }
}

/** 启动单例定时器(全局仅一次): 时段校准 + 对齐 2 分钟边界的主调度 */
function startTimer(): void {
  if (timerStarted) return;
  timerStarted = true;

  // 每 30s 校准一次是否处于轮询时段
  setInterval(() => {
    sharedActive = inPhiliaPollWindow();
    notify();
  }, WINDOW_CHECK_MS);

  const schedule = () => {
    setTimeout(tick, msUntilNextSlot());
  };
  const tick = () => {
    // 仅在轮询时段内触发, 且上一轮在途时跳过(防并发)
    if (sharedEnabled && inPhiliaPollWindow() && !inFlightS) runPollOnce();
    schedule();
  };
  schedule();
}

export interface PhiliaPollingState {
  /** 用户开关状态(持久化) */
  enabled: boolean;
  /** 是否处于轮询时段 */
  inWindow: boolean;
  /** 是否正在主动轮询(开启且处于时段内) */
  active: boolean;
  /** 最近一次轮询触发的时间戳(用于展示) */
  lastTick: number;
  /** 开关刚切换的过渡标记(用于视觉反馈) */
  transition: boolean;
  /** 切换开关状态 */
  toggle: () => void;
}

export function usePhiliaPolling(onTick: () => void): PhiliaPollingState {
  // 注册最新 onTick(各实例共享, 仅最新生效, 避免重复调 LLM)
  useEffect(() => {
    activeOnTick = onTick;
  }, [onTick]);

  // 启动单例定时器(仅首次挂载生效)
  useEffect(() => {
    startTimer();
  }, []);

  // 订阅模块级共享状态(每个实例读到同一份值)
  const enabled = useSyncExternalStore(subscribe, () => sharedEnabled, () => sharedEnabled);
  const active = useSyncExternalStore(subscribe, () => sharedActive, () => sharedActive);
  const lastTick = useSyncExternalStore(subscribe, () => sharedLastTick, () => sharedLastTick);
  const transition = useSyncExternalStore(subscribe, () => sharedTransition, () => sharedTransition);

  const toggle = useCallback(() => {
    sharedEnabled = !sharedEnabled;
    try {
      localStorage.setItem(LS_KEY, sharedEnabled ? "1" : "0");
    } catch {
      /* 隐私/配额受限时忽略 */
    }
    sharedTransition = true;
    notify();
    window.setTimeout(() => {
      sharedTransition = false;
      notify();
    }, 900);
    // 开启后不立即补拉(否则会以"用户此刻"为准), 而是由定时器在下一次本地时钟整分边界(偶数分钟)触发,
    // 保证轮询节奏始终以本地时钟整分为准, 与用户进入/开启程序的时刻无关。
    if (sharedEnabled && !timerStarted) startTimer();
  }, []);

  return { enabled, active, lastTick, transition, inWindow: active, toggle };
}