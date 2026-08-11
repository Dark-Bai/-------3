import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { isTv } from "@/lib/tv";

/**
 * 统一报价中心(MarketHub)
 *  所有面板显示用的价格/涨跌幅的唯一来源:
 *  面板通过 useQuote/useQuotes 订阅需要的代码, 中心以单一轮询循环(5s)
 *  批量拉取全集并分发同一快照 — 同一只股票在所有面板永远同帧。
 *  领域数据(成分股/榜单/资金流)仍走各自端点, 仅展示价格统一从这里读。
 */

export interface HubQuote {
  /** 证券名称(供 代码→名称 解析) */
  name?: string;
  price: number;
  pct: number;
  /** 万元(仅股票有) */
  amount?: number;
  /** 换手率 %(仅股票有) */
  turnover?: number;
  updated: number;
}

// TV 模式降频: 电视弱 CPU 上全站同帧重渲染开销大, 轮询减半
const POLL_MS = isTv ? 10000 : 5000;

const entries = new Map<string, HubQuote>();
const refCounts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let timer: number | null = null;
let flushTimer: number | null = null;

const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getVersion() {
  return version;
}

const num = (v: unknown) => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

// 报价轮询在途标记: setInterval 触发时若上一轮尚未完成则跳过,
// 防止慢请求/排队时每 5s 无条件再发, 形成请求堆积与渲染风暴(冷启动卡死根因之一)
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!refCounts.size) return;
    const codes = [...refCounts.keys()];
    const rs = await Promise.allSettled([api.quotes(codes)]);
    const now = Date.now();
    let changed = false;
    for (const r of rs) {
      if (r.status !== "fulfilled") continue;
      for (const [code, q] of Object.entries(r.value)) {
        const next: HubQuote = {
          name: typeof q.name === "string" ? q.name : undefined,
          price: num(q.price),
          pct: num(q.pct),
          amount: q.amount != null ? num(q.amount) : undefined,
          turnover: q.turnover != null ? num(q.turnover) : undefined,
          updated: now,
        };
        const old = entries.get(code);
        if (!old || old.price !== next.price || old.pct !== next.pct || old.amount !== next.amount || old.turnover !== next.turnover) {
          entries.set(code, next);
          changed = true;
        }
      }
    }
    if (changed) emit();
    // TV 调试角标读取: 上次报价心跳时间与是否有变化(定位"面板不更新"是轮询死了还是行情静止)
    (window as unknown as { __hubStatus?: { t: number; changed: boolean } }).__hubStatus = { t: Date.now(), changed };
  } finally {
    ticking = false;
  }
}

function onVisibility() {
  if (!document.hidden) tick();
}

function ensureLoop() {
  if (timer != null) return;
  timer = window.setInterval(() => {
    if (!document.hidden) tick();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisibility);
}

function maybeStopLoop() {
  if (refCounts.size === 0 && timer != null) {
    clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

/** 新代码注册后防抖立即补拉(节流 ≥4s, 防冷启动多面板同时注册时的补拉风暴直冲上游) */
let lastFlush = 0;
function scheduleFlush() {
  if (flushTimer != null || document.hidden) return;
  const wait = Math.max(500, 4000 - (Date.now() - lastFlush));
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    lastFlush = Date.now();
    tick();
  }, wait);
}

/** 注册一批代码(引用计数), 卸载时释放 */
function useCodes(codes: string[]) {
  const key = codes.join(",");
  useEffect(() => {
    const uniq = [...new Set(key ? key.split(",") : [])].filter(Boolean);
    for (const c of uniq) refCounts.set(c, (refCounts.get(c) || 0) + 1);
    ensureLoop();
    scheduleFlush();
    return () => {
      for (const c of uniq) {
        const n = (refCounts.get(c) || 1) - 1;
        if (n <= 0) {
          refCounts.delete(c);
          entries.delete(c);
        } else {
          refCounts.set(c, n);
        }
      }
      maybeStopLoop();
    };
  }, [key]);
}

/** 订阅单个代码的实时报价(同一快照源; entry 引用仅在该代码数据变化时更新) */
export function useQuote(code: string, enabled = true): HubQuote | null {
  useCodes(enabled ? [code] : []);
  return useSyncExternalStore(subscribe, () => (enabled ? entries.get(code) ?? null : null));
}

/** 订阅一批代码的实时报价表(同一快照源) */
export function useQuotes(codes: string[]): Record<string, HubQuote> {
  useCodes(codes);
  const v = useSyncExternalStore(subscribe, getVersion);
  const key = codes.join(",");
  return useMemo(() => {
    const result: Record<string, HubQuote> = {};
    for (const c of codes) {
      const e = entries.get(c);
      if (e) result[c] = e;
    }
    return result;
    // codes 内容变化(key)或中心数据更新(v)时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v]);
}
