import { Panel, type PanelZoomProps } from "./Panel";
import { PhiliaBlankPanel } from "./PhiliaBlankPanel";

/** 界面中央大型整体模块: 由"上部空白模块" + "原 philia 模块"纵向合并而成。
 *  跨两行(rowSpan=2)占据原「商品·美债」区域与 philia 区域, 形成统一大块。
 *  标题栏复用 Panel 组件, 位置与风格与「A股关键指数」等系统面板一致;
 *  body 由上空白 + 下空白组成统一空白区, 预留后续内容空间 */
export function PhiliaPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  return (
    <Panel className={className} {...zoomProps} title="PHILIA" icon="◈" accent="#d4943a">
      <div className="flex h-full flex-col">
        {/* 上部空白模块(合并自原「商品·美债」区域, 预留内容空间) */}
        <PhiliaBlankPanel />
        {/* 下部空白(预留) */}
        <div className="min-h-0 flex-1" />
      </div>
    </Panel>
  );
}