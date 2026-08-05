/**
 * PHILIA 自动轮询 hook
 *
 * 规则:
 *  - 轮询时段: 每日 09:14:00(含) 至 15:01:00(不含)
 *  - 轮询频率: 每 1 分钟触发一次 onTick
 *  - 防漂移: 以"距下一个整分钟边界的毫秒数"自校正调度, 而非固定 setInterval, 避免时间漂移累积
 *  - 防并发: 上一轮 onTick 仍在途时跳过本轮触发(避免 LLM 分析重叠重复计费)
 *  - 时段校准: 每 30s 复核一次是否处于轮询时段(收盘后自动停、次日开盘自动恢复)
 *  - 状态记忆: 用户开关持久化到 localStorage, 页面刷新后保持
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** 轮询时段(分钟): 09:14(含) 至 15:01(不含) */
const POLL_START_MIN = 9 * 60 + 14;
const POLL_END_MIN = 15 * 60 + 1;
/** 时段校准周期: 30s */
const WINDOW_CHECK_MS = 30 * 1000;
/** 开关状态持久化 key */
const LS_KEY = "dash:philia-poll";

/** 当前时刻是否处于轮询时段(含起始 09:14, 不含结束 15:01) */
export function inPhiliaPollWindow(d = new Date()): boolean {
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= POLL_START_MIN && m < POLL_END_MIN;
}

/** 距下一个整分钟边界还有多少毫秒(用于对齐边界、避免漂移) */
function msUntilNextMinute(): number {
  const now = new Date();
  return (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
}

/** 读取持久化的开关状态(默认关闭) */
function loadPersisted(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "1";
  } catch {
    return false;
  }
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
  const [enabled, setEnabled] = useState<boolean>(loadPersisted);
  const [inWindow, setInWindow] = useState<boolean>(() => inPhiliaPollWindow());
  const [lastTick, setLastTick] = useState<number>(0);
  const [transition, setTransition] = useState<boolean>(false);

  const onTickRef = useRef(onTick);
  const inFlight = useRef<boolean>(false);

  // 始终持有最新的 onTick, 避免闭包过期
  useEffect(() => {
    onTickRef.current = onTick;
  });

  // 持久化开关状态: 页面刷新后记忆
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, enabled ? "1" : "0");
    } catch {
      /* 隐私/配额受限时忽略 */
    }
  }, [enabled]);

  // 每 30s 校准一次是否处于轮询时段
  useEffect(() => {
    setInWindow(inPhiliaPollWindow());
    const t = setInterval(() => setInWindow(inPhiliaPollWindow()), WINDOW_CHECK_MS);
    return () => clearInterval(t);
  }, []);

  // 主调度: 对齐整分钟边界的自校正定时器
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;

    const schedule = () => {
      timer = setTimeout(tick, msUntilNextMinute());
    };

    const tick = () => {
      if (dead) return;
      // 仅在轮询时段内触发, 且上一轮在途时跳过(防并发)
      if (inPhiliaPollWindow() && !inFlight.current) {
        inFlight.current = true;
        setLastTick(Date.now());
        Promise.resolve()
          .then(() => onTickRef.current())
          .catch(() => {
            /* 轮询失败静默, 由调用方保持当前内容稳定 */
          })
          .finally(() => {
            inFlight.current = false;
          });
      }
      schedule();
    };

    // 开启且处于时段内: 立即补拉一次; 否则待下一整分钟边界再评估
    if (inPhiliaPollWindow()) tick();
    else schedule();

    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  const toggle = useCallback(() => {
    setEnabled((v) => !v);
    setTransition(true);
    window.setTimeout(() => setTransition(false), 900);
  }, []);

  return { enabled, inWindow, active: enabled && inWindow, lastTick, transition, toggle };
}