import { Panel, type PanelZoomProps } from "./Panel";
import { FengWeights } from "./FengWeights";
import { FengWindList } from "./FengWindList";
import { useFengWeights } from "@/hooks/useFengWeights";
import { useFengFront } from "@/lib/api";

/** 市场板块实时热点 — 风口榜: 卡片渲染 + 点击展开龙头/梯队/新闻 */
export function SectorPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const fengWeights = useFengWeights();
  // 携带当前权重到后端计算最终评分, 15s 轮询
  const { data, loading, error, refreshing } = useFengFront("", fengWeights.weights);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="市场板块实时热点"
      icon="▤"
      accent="#d4943a"
      right={<FengWeights {...fengWeights} />}
    >
      <div className="h-full min-h-0 p-1.5">
        <FengWindList data={data ?? undefined} loading={loading} error={!!error} refreshing={refreshing} />
      </div>
    </Panel>
  );
}