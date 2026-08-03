import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardFlow } from "@/lib/api";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 流入红色系 / 流出绿色系(按排名渐变) */
const REDS = ["#b8533a", "#f43f5e", "#fca5a5", "#fb923c", "#fdba74", "#e11d48", "#fecdd3", "#fda4af", "#fcd34d", "#fbbf24"];
const GREENS = ["#4a6b3f", "#10b981", "#6ee7b7", "#059669", "#a7f3d0", "#4ade80", "#22c55e", "#86efac", "#16a34a", "#15803d"];

// 午休压缩点上下午刻度相邻, 用两端锚定防重叠; 首尾刻度防出界
const X_TICKS: [number, string, "start" | "middle" | "end"][] = [
  [0, "09:30", "middle"],
  [59, "10:30", "middle"],
  [119, "11:30", "end"],
  [120, "13:00", "start"],
  [179, "14:00", "middle"],
  [239, "15:00", "end"],
];

/** 图例区最大高度(legend 模式, 超出滚动) */
const LEGEND_H = 64;

/** 端点标签模式预留的右侧标签宽度 */
const END_LABEL_W = 86;

/** 板块实时资金流向图(分钟级累计主力净流入, 东财口径)
 *  progress: 0..1 播放进度(重放用), 1 = 全天
 *  labelMode: "end" 端点标签+标线(默认) / "legend" 图下方图例 */
export function BoardFlowChart({ flows, progress = 1, labelMode = "end" }: { flows: BoardFlow[]; progress?: number; labelMode?: "end" | "legend" }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      if (r.width > 60 && r.height > 60) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chart = useMemo(() => {
    const series = flows.filter((f) => f.points.length > 2);
    if (!series.length) return null;
    const { w: W, h: H } = size;
    const chartH = Math.max(H - (labelMode === "legend" ? LEGEND_H : 0), 80);
    const labelW = labelMode === "end" ? END_LABEL_W : 0;
    const n = Math.max(...series.map((s) => s.points.length));
    // 重放进度: 只绘制前 idx 个点
    const idx = Math.max(1, Math.min(n - 1, Math.floor(progress * (n - 1))));
    // 纵坐标按当前已播放的数据动态缩放,播放结束时再切回全天范围
    const visiblePoints = series.flatMap((s) => (progress < 1 ? s.points.slice(0, idx + 1) : s.points));
    const visibleV = visiblePoints.map((p) => p.v);
    let min = Math.min(...visibleV, 0);
    let max = Math.max(...visibleV, 0);
    const pad = (max - min) * 0.04 || 1;
    min -= pad;
    max += pad;
    const X = (i: number) => 34 + (i / Math.max(n - 1, 1)) * (W - 40 - labelW);
    const Y = (v: number) => 8 + (1 - (v - min) / (max - min)) * (chartH - 26);
    // 颜色: 流入侧按名次取红, 流出侧取绿
    let ri = 0;
    let gi = 0;
    const lines = series.map((s) => {
      const color = s.netIn >= 0 ? REDS[ri++ % REDS.length] : GREENS[gi++ % GREENS.length];
      const seg = s.points.slice(0, idx + 1);
      const pts = seg.map((p, i) => `${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
      const last = seg[seg.length - 1];
      return { s, color, pts, lastY: Y(last.v), lastV: last.v };
    });
    // Y 刻度: 4 档
    const ticks = [0.2, 0.4, 0.6, 0.8].map((f) => {
      const v = max - f * (max - min);
      return { v, y: Y(v) };
    });
    // 端点标签(end 模式): 按 y 排序后在可视区内均匀分布, 间距不足自动压缩, 不被裁剪
    let labels: { line: (typeof lines)[number]; labelY: number }[] = [];
    if (labelMode === "end") {
      labels = [...lines].sort((a, b) => a.lastY - b.lastY).map((l) => ({ line: l, labelY: l.lastY }));
      const TOP = 10, BOTTOM = chartH - 18;
      const gap = labels.length > 1 ? Math.min(11, (BOTTOM - TOP) / (labels.length - 1)) : 11;
      let sy = Math.max(labels.length ? labels[0].labelY : TOP, TOP);
      sy = Math.min(sy, BOTTOM - gap * (labels.length - 1));
      sy = Math.max(sy, TOP);
      for (const l of labels) { l.labelY = sy; sy += gap; }
    }
    return { W, chartH, labelW, X, Y, lines, labels, ticks, idx, cursorT: (series.find((s) => s.points.length > idx)?.points[idx])?.t ?? "" };
  }, [flows, size, progress, labelMode]);

  return (
    <div ref={boxRef} className="flex h-full min-h-0 w-full flex-col">
      {chart ? (
        <>
          <svg width={chart.W} height={chart.chartH} className="block shrink-0">
            {/* 网格与零轴 */}
            {chart.ticks.map((t, i) => (
              <g key={i}>
                <line x1={34} y1={t.y} x2={chart.W - chart.labelW - 6} y2={t.y} stroke="#e0d5c0" strokeWidth={1} />
                <text x={4} y={t.y + 3} fontSize={9} fill="#a8987e" style={TNUM}>{(t.v / 1e8).toFixed(0)}亿</text>
              </g>
            ))}
            <line x1={34} y1={chart.Y(0)} x2={chart.W - chart.labelW - 6} y2={chart.Y(0)} stroke="#c9b99a" strokeWidth={1} />
            {/* 时间刻度 */}
            {X_TICKS.map(([i, t, anchor]) => (
              <text key={t} x={chart.X(i)} y={chart.chartH - 8} fontSize={8} fill="#a8987e" textAnchor={anchor}>{t}</text>
            ))}
            {/* 板块曲线 */}
            {chart.lines.map((l) => (
              <polyline key={l.s.code} points={l.pts} fill="none" stroke={l.color} strokeWidth={1.4} strokeLinejoin="round" />
            ))}
            {/* 端点标签 + 标线(end 模式) */}
            {labelMode === "end" &&
              chart.labels.map((l) => (
                <g key={l.line.s.code}>
                  <line x1={chart.W - chart.labelW - 6} y1={l.line.lastY} x2={chart.W - chart.labelW} y2={l.labelY} stroke={l.line.color} strokeWidth={0.6} strokeOpacity={0.5} />
                  <text x={chart.W - chart.labelW + 2} y={l.labelY + 3} fontSize={8.5} fill={l.line.color} style={TNUM}>
                    {l.line.s.name} {l.line.lastV >= 0 ? "+" : ""}{(l.line.lastV / 1e8).toFixed(0)}
                  </text>
                </g>
              ))}
            {/* 时间游标 */}
            {progress < 1 && (
              <g>
                <line
                  x1={chart.X(chart.idx)}
                  y1={8}
                  x2={chart.X(chart.idx)}
                  y2={chart.chartH - 18}
                  stroke="#a8987e"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <text x={chart.X(chart.idx)} y={8} fontSize={8} fill="#e2e8f0" textAnchor="middle" style={TNUM}>
                  {chart.cursorT}
                </text>
              </g>
            )}
          </svg>
          {/* 图例(legend 模式): 色块 + 板块名 + 净额, 超出滚动 */}
          {labelMode === "legend" && (
            <div
              className="mt-1 flex shrink-0 flex-wrap content-start gap-x-3 gap-y-1 overflow-y-auto px-1"
              style={{ maxHeight: LEGEND_H }}
            >
              {chart.lines.map((l) => (
                <span key={l.s.code} className="flex items-center gap-1 text-[9px] leading-none">
                  <span className="h-[5px] w-[10px] shrink-0 rounded-sm" style={{ background: l.color }} />
                  <span className="max-w-[86px] truncate text-slate-400">{l.s.name}</span>
                  <span className="font-semibold" style={{ color: l.color, fontVariantNumeric: "tabular-nums" }}>
                    {l.lastV >= 0 ? "+" : ""}{(l.lastV / 1e8).toFixed(0)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full items-center justify-center text-[11px] text-slate-600">板块资金流加载中…</div>
      )}
    </div>
  );
}
