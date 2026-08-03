import { Panel, type PanelZoomProps } from "./Panel";

/** 大宗商品（已清空，待填充） */
export function CommodityPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  return (
    <Panel className={className} {...zoomProps} title="大宗商品" icon="◆" accent="#f5c542">
      <div className="flex h-full flex-col items-center justify-center text-[#a8987e]">
      </div>
    </Panel>
  );
}