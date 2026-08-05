import { Panel, type PanelZoomProps } from "./Panel";
import { LeaderPoolChip } from "./LeaderPoolChip";
import { MarketReviewSection } from "./MarketReviewSection";

/**
 * 界面中央大型整体模块: 由"上部空白模块" + "原 philia 模块"纵向合并而成。
 * 标题栏复用 Panel 组件; 主体为「龙头情绪复盘」——由 MarketReviewSection 内的
 * 「启动 AI 综合分析」按钮触发, 一次性生成今日龙头核心/情绪周期/机会/风险 4 模块。
 * 综合分析视图已被龙头复盘取代, 仅保留启动键与龙头池。
 */
export function PhiliaPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  return (
    <Panel
      className={className}
      {...zoomProps}
      title="PHILIA"
      icon="◈"
      accent="#d4943a"
      right={
        <div className="ml-auto flex items-center gap-1.5">
          <LeaderPoolChip />
        </div>
      }
    >
      <div className="flex h-full flex-col">
        <MarketReviewSection />
      </div>
    </Panel>
  );
}