import { Panel, type PanelZoomProps } from "./Panel";

/** 美债国债（已清空，待填充） */
export function TreasuryPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  return (
    <Panel className={className} {...zoomProps} title="美债国债市场" icon="◧" accent="#a78bfa">
      <div className="flex h-full flex-col items-center justify-center text-[#a8987e]">
      </div>
    </Panel>
  );
}