import { Panel, type PanelZoomProps } from "./Panel";
import { FengWeights } from "./FengWeights";
import { FengWindList } from "./FengWindList";
import { useFengWeights } from "@/hooks/useFengWeights";
import { useFengFront } from "@/lib/api";

/** 市场板块实时热点 — 风口榜: 卡片渲染 + 点击展开龙头/梯队/新闻 */
export function SectorPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const fengWeights = useFengWeights();
  // 携带当前权重到后端计算最终评分, 15s 轮询; refresh 供手动主动刷新
  const { data, loading, error, refreshing, refresh } = useFengFront("", fengWeights.weights);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="市场板块实时热点"
      icon="▤"
      accent="#d4943a"
      right={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="主动刷新风口榜"
            className="flex h-5 w-5 items-center justify-center rounded border border-[#d4943a]/40 text-[11px] text-[#d4943a] transition-colors hover:bg-[#d4943a]/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className={`inline-block ${refreshing ? "animate-spin" : ""}`}>⟳</span>
          </button>
          <FengWeights {...fengWeights} />
        </div>
      }
    >
      <div className="h-full min-h-0 p-1.5">
        <FengWindList data={data ?? undefined} loading={loading} error={!!error} refreshing={refreshing} />
      </div>
    </Panel>
  );
}