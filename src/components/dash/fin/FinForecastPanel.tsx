import { useState } from "react";
import { Panel, type PanelZoomProps } from "../Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type FinForecastItem } from "@/lib/api";
import { TNUM, fmtYi, forecastTone } from "./utils";
import { useFin } from "./FinContext";
import { SkeletonRows } from "./SkeletonRows";
import { prefixCode } from "./utils";

const CHIP_CLS = {
  good: "border-rose-400/60 bg-rose-400/10 text-rose-300",
  bad: "border-emerald-400/60 bg-emerald-400/10 text-emerald-300",
  neutral: "border-slate-500/60 bg-slate-500/10 text-slate-400",
} as const;

/** 明细行: 固定列 日期 w40 | 名称 flex | chip w34 | 净利区间 w140 右对齐 | 同比 w120 右对齐, 行高 18px */
function Row({ it }: { it: FinForecastItem }) {
  const { select } = useFin();
  const tone = forecastTone(it.type);
  const mid = (it.yoyLow + it.yoyHigh) / 2;
  const yoyCls = mid > 0 ? "text-rose-400" : mid < 0 ? "text-emerald-400" : "text-slate-400";
  return (
    <button
      onClick={() => select(prefixCode(it.code), it.name)}
      className="flex h-[18px] w-full items-center gap-1.5 border-b border-slate-800/60 px-2 text-left hover:bg-slate-800/40"
    >
      <span className="w-[40px] shrink-0 whitespace-nowrap text-[9px] text-slate-500" style={TNUM}>
        {it.date.slice(5)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-200">{it.name}</span>
      <span
        className={`flex w-[34px] shrink-0 items-center justify-center gap-0.5 rounded border px-0.5 text-[8.5px] leading-[12px] ${CHIP_CLS[tone]}`}
      >
        {it.type === "首亏" && <span className="inline-block h-[3px] w-[3px] rounded-full bg-amber-400" />}
        {it.type}
      </span>
      <span className="w-[140px] shrink-0 truncate text-right text-[11px] text-slate-300" style={TNUM}>
        {fmtYi(it.profitLow)}~{fmtYi(it.profitHigh)}
      </span>
      <span className={`w-[120px] shrink-0 text-right text-[10px] ${yoyCls}`} style={TNUM}>
        {it.yoyLow > 0 ? "+" : ""}
        {it.yoyLow.toFixed(1)}%~{it.yoyHigh > 0 ? "+" : ""}
        {it.yoyHigh.toFixed(1)}%
      </span>
    </button>
  );
}

/** 业绩预告: 3px 贴头堆叠统计条(rose/emerald/slate) + 统计数字入标题栏 + 固定列紧凑表(公告日倒序) */
export function FinForecastPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [retry, setRetry] = useState(0);
  const { period } = useFin();
  const { data, error, loading } = usePolling(() => api.financeForecast(period), 1800000, [retry, period]);

  const stats = data?.stats;
  const hasItems = (data?.items.length ?? 0) > 0;
  const total = stats ? stats.good + stats.bad + stats.neutral : 0;

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="业绩预告"
      icon="⚡"
      accent="#fbbf24"
      right={
        stats &&
        hasItems && (
          <div className="flex items-center gap-2 text-[10px]" style={TNUM}>
            <span className="text-rose-400">预喜 {stats.good}▲</span>
            <span className="text-emerald-400">预悲 {stats.bad}▼</span>
            <span className="text-slate-500">未定 {stats.neutral}</span>
          </div>
        )
      }
    >
      {!data ? (
        loading ? (
          <SkeletonRows rows={8} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px]">
            <button className="h-full w-full text-slate-500" onClick={() => setRetry((r) => r + 1)}>
              数据获取失败，点击重试{error ? `(${error})` : ""}
            </button>
          </div>
        )
      ) : !hasItems ? (
        <div className="flex h-full items-center justify-center text-[11px] text-slate-600">当前非业绩预告密集披露期</div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {/* 3px 贴头堆叠条: 预喜 rose / 预悲 emerald / 未定 slate */}
          <div className="flex h-[3px] w-full shrink-0">
            {stats!.good > 0 && <div className="h-full bg-rose-400" style={{ width: `${(stats!.good / total) * 100}%` }} />}
            {stats!.bad > 0 && <div className="h-full bg-emerald-400" style={{ width: `${(stats!.bad / total) * 100}%` }} />}
            {stats!.neutral > 0 && (
              <div className="h-full bg-slate-600" style={{ width: `${(stats!.neutral / total) * 100}%` }} />
            )}
          </div>
          {/* 明细表 */}
          <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
            {data.items.map((it) => (
              <Row key={`${it.date}-${it.code}`} it={it} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
