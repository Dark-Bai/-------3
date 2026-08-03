import { useMemo, useState } from "react";
import { Panel, type PanelZoomProps } from "../Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type FinBoardStock } from "@/lib/api";
import { fmtPct } from "@/lib/format";
import { useFin } from "./FinContext";
import { PeriodTabs } from "./PeriodTabs";
import { SkeletonRows } from "./SkeletonRows";
import { TNUM, fmtYi, prefixCode } from "./utils";

type Tab = "profit" | "growth";
const RANK_COLORS = ["#fbbf24", "#fb7185", "#22d3ee"]; // 前三名 amber/rose/cyan

/** 个股盈利榜 TOP20: 净利额 | 增速 双 Tab, 行内相对值底条, 点击载入公司 */
export function FinStockRankPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [tab, setTab] = useState<Tab>("profit");
  const [retry, setRetry] = useState(0);
  const { select, period } = useFin();
  const { data, error, loading } = usePolling(() => api.financeBoard(period), 1800000, [retry, period]);

  const rows = useMemo(() => {
    const stocks = data?.stocks ?? [];
    if (tab === "profit") return stocks.slice(0, 20);
    // 增速 Tab: 同比降序, 亏损企业(增速失真)置底
    const profit = stocks.filter((s) => s.netProfit > 0).sort((a, b) => b.profitYoY - a.profitYoY);
    const loss = stocks.filter((s) => s.netProfit <= 0);
    return [...profit, ...loss].slice(0, 20);
  }, [data, tab]);

  const maxV = Math.max(...rows.map((s) => (tab === "profit" ? s.netProfit : Math.max(s.profitYoY, 0))), 1);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="个股盈利榜"
      icon="≣"
      accent="#fb7185"
      right={
        <div className="flex items-center gap-2 text-[10px]">
          <PeriodTabs />
          <span className="h-3 w-px bg-slate-700" />
          {(
            [
              { key: "profit", label: "净利额" },
              { key: "growth", label: "增速" },
            ] as { key: Tab; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex h-[22px] items-center border-b-2 px-2 ${
                tab === t.key ? "border-cyan-400 text-cyan-300" : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {!data ? (
        loading ? (
          <SkeletonRows rows={14} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px]">
            <button className="h-full w-full text-slate-500" onClick={() => setRetry((r) => r + 1)}>
              数据获取失败，点击重试{error ? `(${error})` : ""}
            </button>
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[11px] text-slate-600">当前非财报密集披露期</div>
      ) : (
        <div className="h-full overflow-y-auto py-0.5">
          {rows.map((s, i) => (
            <RankRow key={s.code} s={s} rank={i + 1} tab={tab} maxV={maxV} onPick={() => select(prefixCode(s.code), s.name)} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function RankRow({
  s,
  rank,
  tab,
  maxV,
  onPick,
}: {
  s: FinBoardStock;
  rank: number;
  tab: Tab;
  maxV: number;
  onPick: () => void;
}) {
  const barV = tab === "profit" ? Math.max(s.netProfit, 0) : Math.max(s.profitYoY, 0);
  const barColor = tab === "profit" ? "#fb7185" : s.profitYoY >= 0 ? "#fb7185" : "#34d399";
  const loss = s.netProfit <= 0;
  return (
    <button
      onClick={onPick}
      className="relative flex h-[20px] w-full items-center gap-1.5 border-b border-slate-800/60 px-2.5 text-left hover:bg-slate-800/40"
    >
      {/* 行内相对值底条(4% 透明度) */}
      <span
        className="absolute bottom-0 left-0 top-0"
        style={{ width: `${(barV / maxV) * 100}%`, background: barColor, opacity: 0.04 }}
      />
      <span
        className="w-[14px] shrink-0 text-[9px]"
        style={{ color: rank <= 3 ? RANK_COLORS[rank - 1] : "#64748b", fontVariantNumeric: "tabular-nums" }}
      >
        {rank}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200">{s.name}</span>
      {tab === "profit" ? (
        <>
          <span className="w-[56px] shrink-0 text-right text-[12px] font-semibold text-slate-200" style={TNUM}>
            {fmtYi(s.netProfit)}
          </span>
          <span className={`w-[52px] shrink-0 text-right text-[10px] ${s.profitYoY >= 0 ? "text-rose-400" : "text-emerald-400"}`} style={TNUM}>
            {fmtPct(s.profitYoY, 1)}
          </span>
          <span className="w-[62px] shrink-0 text-right text-[9px] text-slate-500" style={TNUM}>
            ROE {s.roe.toFixed(1)}%
          </span>
        </>
      ) : (
        <>
          <span
            className={`w-[56px] shrink-0 text-right text-[12px] font-semibold ${s.profitYoY >= 0 ? "text-rose-400" : "text-emerald-400"}`}
            style={TNUM}
          >
            {fmtPct(s.profitYoY, 1)}
          </span>
          <span className="w-[52px] shrink-0 text-right text-[10px] text-slate-400" style={TNUM}>
            {fmtYi(s.netProfit)}
          </span>
          <span className="w-[62px] shrink-0 text-right text-[9px] text-slate-500" style={TNUM}>
            {loss ? (s.profitYoY > 0 ? "扭亏" : "亏损") : `ROE ${s.roe.toFixed(1)}%`}
          </span>
        </>
      )}
    </button>
  );
}
