import { Panel, type PanelZoomProps } from "./Panel";

/** 市场板块实时热点 — 预留空面板，数据内容已清空 */
export function SectorPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  return (
    <Panel
      className={className}
      {...zoomProps}
      title="市场板块实时热点"
      icon="▤"
      accent="#d4943a"
    >
      <div className="flex h-full min-h-0 flex-col items-center justify-center">
        <div className="text-center text-[11px] text-[#a8987e]">
          预留位置<br />待替换新功能
        </div>
      </div>
    </Panel>
  );
}
