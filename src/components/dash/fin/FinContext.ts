import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface FinCompany {
  code: string; // sh600519 形式
  name: string;
}

interface FinCtx {
  company: FinCompany;
  recent: FinCompany[];
  select: (code: string, name: string) => void;
  /** 宏观面板报告期(当期=披露中, 上一期=全市场完整数据) */
  period: string;
  setPeriod: (p: string) => void;
  periods: { value: string; label: string }[];
}

const DEFAULT_COMPANY: FinCompany = { code: "sh600519", name: "贵州茅台" };

/** 按当前月份回推最近报告期(与服务端口径一致) */
function currentPeriod(d = new Date()): string {
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  if (m <= 3) return `${y - 1}-09-30`;
  if (m <= 6) return `${y}-03-31`;
  if (m <= 9) return `${y}-06-30`;
  return `${y}-09-30`;
}

function prevPeriod(p: string): string {
  const y = p.slice(0, 4);
  const md = p.slice(4); // "-06-30"
  const prevMd: Record<string, string> = { "-03-31": "-12-31", "-06-30": "-03-31", "-09-30": "-06-30", "-12-31": "-09-30" };
  return `${md === "-03-31" ? Number(y) - 1 : y}${prevMd[md] ?? "-09-30"}`;
}

function periodLabel(p: string): string {
  const q: Record<string, string> = { "-03-31": "Q1", "-06-30": "Q2", "-09-30": "Q3", "-12-31": "Q4" };
  return `${p.slice(2, 4)}${q[p.slice(4)] ?? ""}`;
}

const CUR = currentPeriod();
const PREV = prevPeriod(CUR);
const PERIOD_OPTIONS = [
  { value: CUR, label: `${periodLabel(CUR)}·披露中` },
  { value: PREV, label: `${periodLabel(PREV)}·全市场` },
];

const FinContext = createContext<FinCtx>({
  company: DEFAULT_COMPANY,
  recent: [],
  select: () => {},
  period: CUR,
  setPeriod: () => {},
  periods: PERIOD_OPTIONS,
});

const LS_KEY = "fin:recent";
const MAX_RECENT = 6;

function loadRecent(): FinCompany[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (Array.isArray(v))
      return v.filter((x) => x && typeof x.code === "string" && typeof x.name === "string").slice(0, MAX_RECENT);
  } catch { /* 忽略损坏数据 */ }
  return [];
}

/** 公司选择状态(finCompany 与 finTrend 共享): 默认贵州茅台, 最近查看存 localStorage */
export function FinProvider({ children }: { children: ReactNode }) {
  const [company, setCompany] = useState<FinCompany>(DEFAULT_COMPANY);
  const [recent, setRecent] = useState<FinCompany[]>(loadRecent);
  const [period, setPeriod] = useState(CUR);

  const select = useCallback((code: string, name: string) => {
    setCompany({ code, name });
    setRecent((rs) => {
      const next = [{ code, name }, ...rs.filter((r) => r.code !== code)].slice(0, MAX_RECENT);
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* 隐私模式/配额满时忽略 */ }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ company, recent, select, period, setPeriod, periods: PERIOD_OPTIONS }),
    [company, recent, select, period]
  );
  // .ts 文件不可用 JSX, 用 createElement 挂载 Provider
  return createElement(FinContext.Provider, { value }, children);
}

export function useFin() {
  return useContext(FinContext);
}
