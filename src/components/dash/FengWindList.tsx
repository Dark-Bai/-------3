import { useState } from "react";
import { useStockDetail } from "./StockDetailContext";
import type { FengFrontData, FengWind } from "@/lib/api";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 评分颜色: 越强越红 */
function scoreColor(score: number) {
  if (score >= 75) return "#c0392b";
  if (score >= 50) return "#d4943a";
  return "#8b7a5e";
}

/** 涨跌幅颜色: 涨红 / 跌绿 */
function pctColor(v: number) {
  if (v > 0) return "#c0392b";
  if (v < 0) return "#2e8b57";
  return "#8b7a5e";
}

function fmtPct(v?: number) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtSeal(v?: number) {
  if (!v) return "—";
  return `${(v / 1e8).toFixed(1)}亿`;
}

/** 维度堆叠条: 5 段按 dims 比例分布 */
function DimsBar({ dims }: { dims: FengWind["dims"] }) {
  const total = dims.limitUp + dims.ladder + dims.capital + dims.theme + dims.news || 1;
  const segs = [
    { v: dims.limitUp, c: "#c0392b", t: "涨停" },
    { v: dims.ladder, c: "#e0a437", t: "连板" },
    { v: dims.capital, c: "#2e8b57", t: "资金" },
    { v: dims.theme, c: "#3a6ea5", t: "题材" },
    { v: dims.news, c: "#7a5ea0", t: "新闻" },
  ];
  return (
    <div className="flex h-1 w-full overflow-hidden rounded-full bg-[#e0d5c0]/40" title={segs.map((s) => `${s.t}${Math.round((s.v / total) * 100)}%`).join(" · ")}>
      {segs.map((s, i) => (
        <div key={i} style={{ width: `${(s.v / total) * 100}%`, background: s.c }} />
      ))}
    </div>
  );
}

/** 风口卡片: 头部概览 + 点击展开明细(龙头/梯队/新闻) */
function FengWindCard({ wind, rank, open, onToggle }: { wind: FengWind; rank: number; open: boolean; onToggle: () => void }) {
  const { openStockDetail } = useStockDetail();
  const color = scoreColor(wind.score);

  return (
    <div className="overflow-hidden rounded border border-[#e0d5c0]/50 bg-[#faf6ee]">
      <button
        type="button"
        onClick={onToggle}
        className="block w-full px-2 py-1.5 text-left transition-colors hover:bg-[#ede4d4]"
      >
        <div className="flex items-center gap-2">
          <span className={`w-4 shrink-0 text-[11px] font-bold ${rank <= 3 ? "text-[#c0392b]" : "text-[#a8987e]"}`}>
            {rank}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#4a3b28]">{wind.name}</span>
          <span className="shrink-0 text-[12px] font-bold" style={{ color }}>
            {wind.score}
          </span>
          <span className="shrink-0 text-[10px] text-[#8b7a5e]" style={TNUM}>
            {wind.limitUpCount}涨停
          </span>
          <span className="shrink-0 text-[10px] text-[#8b7a5e]" style={TNUM}>
            {wind.maxConsecutive}连板
          </span>
          <span className={`shrink-0 text-[10px] transition-transform ${open ? "rotate-180" : ""} text-[#a8987e]`}>▾</span>
        </div>
        <div className="mt-1 pl-6">
          <DimsBar dims={wind.dims} />
        </div>
      </button>

      {open && (
        <div className="border-t border-[#e0d5c0]/50 px-2 py-2">
          {/* 龙头股 */}
          <div className="mb-2 text-[10px] font-semibold text-[#6b5b3e]">龙头股</div>
          {wind.leaders.length ? (
            <div className="space-y-0.5">
              {wind.leaders.map((ld, i) => (
                <button
                  key={`${ld.code}-${i}`}
                  type="button"
                  onClick={() => openStockDetail(ld.code, ld.name)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-[#ede4d4]"
                >
                  <span className="w-14 shrink-0 text-[10px] text-[#a8987e]" style={TNUM}>{ld.code}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#4a3b28]">{ld.name}</span>
                  <span className="shrink-0 text-[10px] text-[#8b7a5e]" style={TNUM}>{ld.price ? ld.price.toFixed(2) : "—"}</span>
                  <span className="w-12 shrink-0 text-right text-[10px]" style={{ ...TNUM, color: pctColor(ld.pct) }}>
                    {fmtPct(ld.pct)}
                  </span>
                  <span className="w-10 shrink-0 text-right text-[10px] text-[#8b7a5e]" style={TNUM}>{fmtSeal(ld.seal)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-[#a8987e]">暂无龙头数据</div>
          )}

          {/* 涨停梯队 */}
          {wind.ladders.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] font-semibold text-[#6b5b3e]">涨停梯队</div>
              <div className="flex flex-wrap gap-1">
                {wind.ladders.map((l) => (
                  <span key={l.days} className="rounded border border-[#e0d5c0]/60 bg-[#ede4d4] px-1.5 py-0.5 text-[10px] text-[#6b5b3e]" style={TNUM}>
                    {l.days}板 × {l.count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 相关新闻 */}
          {wind.news.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] font-semibold text-[#6b5b3e]">相关新闻</div>
              <div className="space-y-1">
                {wind.news.map((n, i) => (
                  <div key={i} className="rounded border-l-2 border-[#d4943a]/50 px-1.5 py-0.5">
                    <div className="truncate text-[10px] text-[#4a3b28]">{n.title}</div>
                    {n.stocks.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                        {n.stocks.slice(0, 3).map((s) => (
                          <button
                            key={`${s.code}-${i}`}
                            type="button"
                            onClick={() => openStockDetail(s.code, s.name)}
                            className="text-[10px] text-[#3a6ea5] hover:underline"
                          >
                            {s.name}
                            <span style={{ color: pctColor(s.rate) }}> {fmtPct(s.rate)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 风口榜列表: 加载/错误/空态 + 可展开卡片; refreshing 时叠加"刷新中"指示, 数据保持不闪空 */
export function FengWindList({ data, loading, error, refreshing }: { data?: FengFrontData; loading: boolean; error: boolean; refreshing?: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const windList = data?.windList || [];

  if (loading && !windList.length) {
    return <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">风口加载中…</div>;
  }
  if (error && !windList.length) {
    return <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">风口数据暂不可用</div>;
  }
  if (!windList.length) {
    return <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">暂无风口数据</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-1 flex items-center justify-between px-0.5 text-[10px] text-[#a8987e]">
        <span className="flex items-center gap-1.5">
          {refreshing && <RefreshingChip />}
          <span>{windList.length} 个风口</span>
        </span>
        {data && <span style={TNUM}>权重 {Object.values(data.weights).join("/")}</span>}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {windList.map((w, i) => (
          <FengWindCard
            key={w.name}
            wind={w}
            rank={i + 1}
            open={expanded === w.name}
            onToggle={() => setExpanded((cur) => (cur === w.name ? null : w.name))}
          />
        ))}
      </div>
    </div>
  );
}

/** 刷新中指示器: 脉冲圆点 + 文案, 用户感知数据正在后台更新 */
function RefreshingChip() {
  return (
    <span className="inline-flex items-center gap-1 text-[#3a6ea5]">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#3a6ea5]/60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#3a6ea5]" />
      </span>
      刷新中
    </span>
  );
}