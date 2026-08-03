import { memo, useMemo, type ComponentType } from "react";
import { type PanelZoomProps } from "@/components/dash/Panel";
import { usePanelZoom } from "@/hooks/usePanelZoom";
import { isTv } from "@/lib/tv";

export type PanelRowDef = {
  defaultH: number;
  panels: { id: string; component: ComponentType<{ className?: string } & PanelZoomProps>; defaultW: number; mobileH: string }[];
};

type PanelCompProps = { className?: string } & PanelZoomProps;

/** 面板组件的 memo 包装: 某个面板放大/还原时, 其他面板的 props 不变,
 *  跳过重渲染(电视弱 CPU 上整屏 reconcile 是缩放卡顿的主因);
 *  面板内部的数据订阅(useQuotes/usePolling)不受 memo 影响, 照常更新 */
const MemoPanel = memo(function MemoPanel({
  component: C,
  ...props
}: { component: ComponentType<PanelCompProps> } & PanelCompProps) {
  return <C {...props} />;
});

/** 一屏式大屏: 行高与列宽按缩放状态动态分配 */
export function DashboardLayout({ rows }: { rows: PanelRowDef[] }) {
  const { isZoomed, toggle: toggleZoom, layout } = usePanelZoom(rows);

  // TV: 缩放走全屏浮层(Panel.tsx), 兄弟面板尺寸保持默认不变 — 整屏重排在老电视上是卡顿主因
  const defaultLayout = useMemo(
    () => ({ rowHeights: rows.map((r) => r.defaultH), rowWidths: rows.map((r) => r.panels.map((p) => p.defaultW)) }),
    [rows]
  );
  const effLayout = isTv ? defaultLayout : layout;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-1 p-1" style={{ gap: '3px', padding: '3px' }}>
      {rows.map((row, rowIdx) => (
        <div
          key={rowIdx}
          className="flex min-h-0 flex-col gap-1 transition-all duration-300 lg:h-[var(--row-h)] lg:flex-row"
          style={{ "--row-h": `${effLayout.rowHeights[rowIdx] * 100}%` } as React.CSSProperties}
        >
          {row.panels.map((panel, panelIdx) => {
            return (
              <div
                key={panel.id}
                className={`min-h-0 w-full transition-all duration-300 ${panel.mobileH} lg:h-full lg:w-[var(--panel-w)]`}
                style={{ "--panel-w": `${effLayout.rowWidths[rowIdx][panelIdx] * 100}%` } as React.CSSProperties}
              >
                <MemoPanel
                  component={panel.component}
                  className="h-full"
                  panelId={panel.id}
                  isZoomed={isZoomed(panel.id)}
                  onToggleZoom={toggleZoom}
                />
              </div>
            );
          })}
        </div>
      ))}
    </main>
  );
}
