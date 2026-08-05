import type { PanelZoomProps } from "./Panel";

/**
 * 外围指数组件: 按需求已完全清空所有指数数据及相关内容, 并移除边框样式。
 * 保留面板占位以保证布局稳定, 界面显示简洁。
 */
export function CommodityTreasuryPanel({ className = "" }: { className?: string } & PanelZoomProps) {
  return <div className={`min-h-0 ${className}`} />;
}