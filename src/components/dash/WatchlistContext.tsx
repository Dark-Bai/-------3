/**
 * 自选股共享状态: codes 列表 + 增删/排序, localStorage 持久化。
 * WatchlistPanel(卡片区) 与 MiniWatchlistPanel(mini自选) 共用同一份列表:
 *  - 任意一处搜索添加 → 从头部插入, 两个面板同步出现
 *  - 两个面板各自独立维护渲染顺序(卡片顺序 / mini 顺序), 互不影响
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/** 自选股持久化 key */
const WATCH_KEY = "dash:watchlist";
/** 默认示例自选(首次进入无数据时预置, 便于开箱即用) */
const DEFAULT_WATCH = ["sh600519", "sz300750", "sh601318"];

function loadWatch(): string[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length) {
      return arr.filter((c) => typeof c === "string" && /^(sh|sz|bj)\d{6}$/.test(c));
    }
  } catch { /* 损坏则用默认 */ }
  return [...DEFAULT_WATCH];
}

interface WatchlistContextValue {
  codes: string[];
  /** 搜索添加: 从头部插入(新加的排最前) */
  addCode: (code: string) => void;
  removeCode: (code: string) => void;
  /** 卡片拖动排序: 只影响自选股卡片顺序 */
  moveCode: (from: string, to: string) => void;
}

const WatchlistContext = createContext<WatchlistContextValue>({
  codes: [],
  addCode: () => {},
  removeCode: () => {},
  moveCode: () => {},
});

export function WatchlistProvider({ children }: { children: ReactNode }) {
  const [codes, setCodes] = useState<string[]>(loadWatch);
  useEffect(() => {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(codes)); } catch { /* ignore */ }
  }, [codes]);

  const addCode = useCallback((code: string) => {
    if (!/^(sh|sz|bj)\d{6}$/.test(code)) return;
    setCodes((cur) => (cur.includes(code) ? cur : [code, ...cur])); // 从头部添加
  }, []);

  const removeCode = useCallback((code: string) => {
    setCodes((cur) => cur.filter((c) => c !== code));
  }, []);

  const moveCode = useCallback((from: string, to: string) => {
    setCodes((cur) => {
      const i = cur.indexOf(from), j = cur.indexOf(to);
      if (i < 0 || j < 0 || i === j) return cur;
      const next = [...cur];
      next.splice(i, 1);
      next.splice(j, 0, from);
      return next;
    });
  }, []);

  return (
    <WatchlistContext.Provider value={{ codes, addCode, removeCode, moveCode }}>
      {children}
    </WatchlistContext.Provider>
  );
}

export function useWatchlist() {
  return useContext(WatchlistContext);
}
