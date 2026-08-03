/** 财报窗口共享小工具 */

export const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 元 → 千分位亿(财报榜单主列): 269900000000 → "2,699亿"; 不足亿 → 万 */
export const fmtYi = (y: number) => {
  if (!Number.isFinite(y) || y === 0) return "—";
  const abs = Math.abs(y);
  if (abs >= 1e8) return `${(y / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}亿`;
  if (abs >= 1e4) return `${(y / 1e4).toFixed(0)}万`;
  return y.toFixed(0);
};

/** 报告期标签: "2025-09-30"/"2025Q3" → "25Q3"(趋势图刻度/日历期次) */
export const quarterLabel = (s: string) => {
  const m = s.match(/(\d{4})-(\d{2})-/);
  if (m) {
    const q = ({ "03": "Q1", "06": "Q2", "09": "Q3", "12": "Q4" } as Record<string, string>)[m[2]];
    if (q) return `${m[1].slice(2)}${q}`;
  }
  const m2 = s.match(/(\d{4})\s*Q([1-4])/i);
  if (m2) return `${m2[1].slice(2)}Q${m2[2]}`;
  return s;
};

/** 裸 6 位代码补市场前缀: 6/9→sh, 0/2/3→sz, 4/8→bj; 已带前缀原样返回 */
export const prefixCode = (code: string) => {
  const s = code.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    const c = s[0];
    return (c === "6" || c === "9" ? "sh" : c === "4" || c === "8" ? "bj" : "sz") + s;
  }
  return s;
};

/** 预告类型配色: 预喜=rose / 预悲=emerald / 不确定=slate(A股红涨绿跌) */
export const FORECAST_GOOD = new Set(["预增", "略增", "扭亏", "减亏"]);
export const FORECAST_BAD = new Set(["预减", "略减", "首亏", "增亏"]);
export const forecastTone = (type: string): "good" | "bad" | "neutral" =>
  FORECAST_GOOD.has(type) ? "good" : FORECAST_BAD.has(type) ? "bad" : "neutral";
