import { memo, type ComponentType } from "react";
import { type PanelZoomProps } from "@/components/dash/Panel";
import { usePanelZoom } from "@/hooks/usePanelZoom";


export type PanelRowDef = {
  defaultH: number;
  panels: {
    id: string;
    component: ComponentType<{ className?: string } & PanelZoomProps>;
    defaultW: number;
    mobileH: string;
    /** 跨行数(默认 1): 用于合并上下行形成大型整体模块 */
    rowSpan?: number;
    /** 跨列数(默认 1) */
    colSpan?: number;
    /** 显式起始列(默认按行内累计); 跨行面板需显式指定以对齐 */
    colStart?: number;
  }[];
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

/** 一屏式大屏: 基于 CSS Grid 排版, 支持跨行(rowSpan)/跨列(colSpan)合并,
 *  使大型整体模块(如中央 PHILIA)可纵向跨越相邻行。 */
export function DashboardLayout({ rows }: { rows: PanelRowDef[] }) {
  const { isZoomed, toggle: toggleZoom } = usePanelZoom(rows);

  // 列宽模板: 取列数最多的一行的 defaultW 作为各列宽度(fr 自动扣除 gap)
  const widestRow = rows.reduce((a, b) => (b.panels.length > a.panels.length ? b : a), rows[0]);
  const colWidths = widestRow.panels.map((p) => p.defaultW);
  const rowHeights = rows.map((r) => r.defaultH);

  // 计算每个面板的 grid 位置(行优先; 列按 colStart/colSpan 定位)
  let rowCursor = 1;
  const cells: {
    key: string;
    gridRow: string;
    gridColumn: string;
    panelId: string;
    component: ComponentType<PanelCompProps>;
  }[] = [];
  for (const row of rows) {
    let colCursor = 1;
    for (const panel of row.panels) {
      const rowSpan = panel.rowSpan ?? 1;
      const colStart = panel.colStart ?? colCursor;
      const colSpan = panel.colSpan ?? 1;
      cells.push({
        key: panel.id,
        gridRow: `${rowCursor} / ${rowCursor + rowSpan}`,
        gridColumn: `${colStart} / ${colStart + colSpan}`,
        panelId: panel.id,
        component: panel.component,
      });
      colCursor = colStart + colSpan;
    }
    rowCursor += 1;
  }

  return (
    <main
      className="grid min-h-0 flex-1 gap-[3px] p-[3px]"
      style={{
        gridTemplateColumns: colWidths.map((w) => `${w}fr`).join(" "),
        gridTemplateRows: rowHeights.map((h) => `${h}fr`).join(" "),
        gridAutoFlow: "row",
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          className="min-h-0 min-w-0"
          style={{ gridRow: cell.gridRow, gridColumn: cell.gridColumn } as React.CSSProperties}
        >
          <MemoPanel
            component={cell.component}
            className="h-full"
            panelId={cell.panelId}
            isZoomed={isZoomed(cell.panelId)}
            onToggleZoom={toggleZoom}
          />
        </div>
      ))}
    </main>
  );
}