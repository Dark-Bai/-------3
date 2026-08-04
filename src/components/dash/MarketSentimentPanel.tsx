import { useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type PluginMarketSentimentData } from "@/lib/api";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;
const COLORS = {
  red: "#b8533a",
  green: "#4a6b3f",
  orange: "#d4943a",
  beige: "#a8987e",
  dark: "#6b5b3e",
  bg: "#f5f0e6",
  border: "#e0d5c0",
  text: "#8b7a5e",
};

/* ========== 加载/错误 ========== */
function Loading() {
  return <div className="flex h-full items-center justify-center text-[15px] text-[#a8987e]">加载中…</div>;
}
function Failed({ msg = "数据加载失败" }: { msg?: string }) {
  return <div className="flex h-full items-center justify-center text-[15px] text-[#a8987e]">{msg}</div>;
}

/* ========== 工具函数 ========== */
function clsChg(v: number) {
  if (v > 0) return "text-[#b8533a]";
  if (v < 0) return "text-[#4a6b3f]";
  return "text-[#6b5b3e]";
}
function fmt(v: number) { return v.toLocaleString("zh-CN"); }
function fmtPct(v: number) { return v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`; }
function fmtTurnover(v: number) {
  if (v >= 10000) return (v / 10000).toFixed(1) + "亿";
  if (v >= 1) return v.toFixed(1) + "万";
  return v + "";
}

/* ========== 卡片1: 市场情绪评分 (圆形仪表盘) ========== */
function SentimentScoreCard({ score, level, desc }: { score: number; level: string; desc: string }) {
  const color = score >= 75 ? COLORS.red : score >= 60 ? COLORS.orange : score >= 45 ? COLORS.beige : score >= 30 ? COLORS.green : "#4a6b3f";
  const bgTag = score >= 75 ? "bg-[#b8533a]/15 text-[#b8533a]" : score >= 60 ? "bg-[#d4943a]/15 text-[#d4943a]" : score >= 45 ? "bg-[#a8987e]/15 text-[#a8987e]" : score >= 30 ? "bg-[#4a6b3f]/15 text-[#4a6b3f]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  // 圆弧参数
  const r = 28, cx = 36, cy = 36, circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">市场情绪评分</div>
      <div className="flex items-center gap-3">
        {/* SVG 圆形仪表 */}
        <svg width={72} height={72} viewBox="0 0 72 72" className="shrink-0">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e0d5c0" strokeWidth={6} />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={6}
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: "stroke-dashoffset 0.6s ease" }} />
          <text x={cx} y={cy - 2} textAnchor="middle" fontSize={16} fontWeight="bold" fill={color} style={{ fontVariantNumeric: "tabular-nums" }}>
            {score}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize={8} fill="#a8987e">/100</text>
        </svg>
        <div className="min-w-0 flex-1">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${bgTag}`}>{level}</span>
          <div className="mt-1 text-[12px] leading-relaxed text-[#8b7a5e]">{desc}</div>
        </div>
      </div>
    </div>
  );
}

/* ========== 卡片2: 涨跌统计 ========== */
function UpDownCard({ upCount, downCount, upRatio, downRatio, total }: { upCount: number; downCount: number; upRatio: number; downRatio: number; total: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">涨跌统计</div>
      <div className="flex items-center justify-around py-1">
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#b8533a]" style={TNUM}>{fmt(upCount)}</div>
          <div className="text-[12px] text-[#a8987e]">上涨</div>
        </div>
        <div className="text-[20px] text-[#d4c5a8]">/</div>
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#4a6b3f]" style={TNUM}>{fmt(downCount)}</div>
          <div className="text-[12px] text-[#a8987e]">下跌</div>
        </div>
      </div>
      {/* 涨跌比例条 */}
      <div className="mb-1 flex h-3 overflow-hidden rounded-full bg-[#e0d5c0]">
        <div className="h-full rounded-l-full bg-[#b8533a]" style={{ width: `${upRatio}%` }} />
        <div className="h-full rounded-r-full bg-[#4a6b3f]" style={{ flex: 1 }} />
      </div>
      <div className="flex items-center justify-between text-[12px] text-[#a8987e]">
        <span>涨 {upRatio.toFixed(1)}%</span>
        <span>总 {fmt(total)}</span>
        <span>跌 {downRatio.toFixed(1)}%</span>
      </div>
    </div>
  );
}

/* ========== 卡片3: 涨停跌停对比 ========== */
function LimitUpDownCard({ limitUp, limitDown, blownUp, blownRate }: { limitUp: number; limitDown: number; blownUp: number; blownRate: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">涨停跌停</div>
      <div className="flex items-center justify-around py-1">
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#b8533a]" style={TNUM}>{limitUp}</div>
          <div className="text-[12px] text-[#a8987e]">涨停</div>
        </div>
        <div className="text-[20px] text-[#d4c5a8]">/</div>
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#4a6b3f]" style={TNUM}>{limitDown}</div>
          <div className="text-[12px] text-[#a8987e]">跌停</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#d4943a]" style={TNUM}>{blownUp}</div>
          <div className="text-[12px] text-[#a8987e]">炸板</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#6b5b3e]" style={TNUM}>{blownRate.toFixed(1)}%</div>
          <div className="text-[12px] text-[#a8987e]">炸板率</div>
        </div>
      </div>
    </div>
  );
}

/* ========== 卡片4: 多空情绪 ========== */
function BullBearCard({ bullish, bearish, net, total, samples }: {
  bullish: number; bearish: number; net: number; total: number;
  samples?: { code: string; name: string; price: number; change: string }[];
}) {
  const hasApiData = bullish + bearish + total > 0;
  const hasSamples = samples && samples.length > 0;
  const totalRatio = hasApiData && total > 0 ? (bullish / total * 100) : 50;
  const safeNet = Number.isFinite(net) ? net : bullish - bearish;
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#8b7a5e]">多空情绪</span>
        {hasApiData && (
          <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${safeNet >= 0 ? "bg-[#b8533a]/15 text-[#b8533a]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]"}`}>
            {safeNet >= 0 ? "偏多" : "偏空"} {safeNet >= 0 ? "+" : ""}{safeNet}
          </span>
        )}
        {hasSamples && !hasApiData && (
          <span className="rounded bg-[#a8987e]/15 px-1.5 py-0.5 text-[12px] font-medium text-[#a8987e]">
            实时 {bullish}/{bearish}
          </span>
        )}
      </div>
      {hasApiData ? (
        <>
          <div className="flex items-center gap-3 py-1">
            <div className="flex-1 text-center">
              <div className="text-[20px] font-bold text-[#b8533a]" style={TNUM}>{bullish}</div>
              <div className="text-[12px] text-[#a8987e]">看多</div>
            </div>
            <div className="flex-1 text-center">
              <div className="text-[20px] font-bold text-[#4a6b3f]" style={TNUM}>{bearish}</div>
              <div className="text-[12px] text-[#a8987e]">看空</div>
            </div>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-[#e0d5c0]">
            <div className="h-full rounded-l-full bg-[#b8533a]" style={{ width: `${totalRatio}%` }} />
            <div className="h-full rounded-r-full bg-[#4a6b3f]" style={{ flex: 1 }} />
          </div>
          <div className="mt-1 text-center text-[12px] text-[#a8987e]">共 {total} 只成分股</div>
        </>
      ) : hasSamples ? (
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto" style={{ maxHeight: 160 }}>
          {samples.map(s => (
            <div key={s.code} className="flex items-center justify-between text-[12px]">
              <span className="truncate text-[#6b5b3e]">{s.name}</span>
              <span className={`shrink-0 font-medium ${parseFloat(s.change) >= 0 ? "text-[#b8533a]" : "text-[#4a6b3f]"}`} style={TNUM}>
                {parseFloat(s.change) >= 0 ? "+" : ""}{s.change}%
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-[12px] text-[#a8987e]">暂无数据</div>
      )}
    </div>
  );
}

/* ========== 卡片5: 量能分析 ========== */
function VolumeCard({ turnover, prevTurnover, ratio, change, level }: { turnover: number; prevTurnover: number; ratio: number; change: number; level: string }) {
  const tagCls = change >= 20 ? "bg-[#b8533a]/15 text-[#b8533a]" : change >= 5 ? "bg-[#d4943a]/15 text-[#d4943a]" : change >= -5 ? "bg-[#a8987e]/15 text-[#a8987e]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  // 提示灯条：正涨(红)负跌(绿)，绝对值越大颜色越深
  const intensity = Math.min(Math.abs(change) / 40, 1); // 0~1
  const lampOpacity = 0.20 + intensity * 0.65; // 透明度 0.20~0.85
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#8b7a5e]">量能分析</span>
        <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${tagCls}`}>{level}</span>
      </div>
      <div className="flex items-baseline justify-between">
        <span className="text-[20px] font-bold text-[#6b5b3e]" style={TNUM}>{fmtTurnover(turnover)}</span>
        <span className="text-[12px] text-[#a8987e]">流通量</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[12px] text-[#a8987e]">
        <span>前日 {fmtTurnover(prevTurnover)}</span>
        <span className={`font-medium ${clsChg(change)}`} style={TNUM}>{change >= 0 ? "+" : ""}{change.toFixed(1)}%</span>
      </div>
      {/* 提示灯条：居中，颜色深浅反映量能变化幅度 */}
      <div className="mt-1.5 h-2 w-3/4 overflow-hidden rounded-full transition-all mx-auto"
        style={{ backgroundColor: `rgba(0,0,0,0.06)` }}>
        <div className="h-full w-full rounded-full transition-all duration-500"
          style={{ backgroundColor: `rgba(${change > 0 ? "184,83,58" : change < 0 ? "74,107,63" : "160,150,130"},${lampOpacity})` }} />
      </div>
      <div className="mt-1 text-[12px] text-[#a8987e]">量比 <span className="font-medium text-[#6b5b3e]" style={TNUM}>{ratio.toFixed(2)}x</span></div>
    </div>
  );
}

/* ========== 卡片6: 涨停表现 ========== */
function LimitPerfCard({ yestPerf, yestBroken, brokenUp }: { yestPerf: number; yestBroken: number; brokenUp: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">涨停表现</div>
      <div className="flex items-center justify-around py-1">
        <div className="text-center">
          <div className={`text-[20px] font-bold ${clsChg(yestPerf)}`} style={TNUM}>{fmtPct(yestPerf)}</div>
          <div className="text-[12px] text-[#a8987e]">昨涨停表现</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="text-center">
          <div className={`text-[20px] font-bold ${clsChg(yestBroken)}`} style={TNUM}>{fmtPct(yestBroken)}</div>
          <div className="text-[12px] text-[#a8987e]">昨破板表现</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#d4943a]" style={TNUM}>{brokenUp}</div>
          <div className="text-[12px] text-[#a8987e]">破板数</div>
        </div>
      </div>
    </div>
  );
}

/* ========== 卡片7: 历史趋势迷你图 (SVG) ========== */
function TrendChart({ data }: { data: PluginMarketSentimentData["riseFall"]["trendData"] }) {
  if (!data || data.length < 2) return null;
  const reversed = [...data].reverse();
  const maxVal = Math.max(...reversed.map(d => Math.max(d.limitUp, d.limitDown, d.blownUp)), 10);
  const w = 600, h = 120, pad = { top: 10, bottom: 18, left: 28, right: 8 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const stepX = chartW / (reversed.length - 1);
  const scaleY = (v: number) => pad.top + chartH - (v / maxVal * chartH);

  const upPath = reversed.map((d, i) => `${i === 0 ? "M" : "L"}${pad.left + i * stepX},${scaleY(d.limitUp)}`).join(" ");
  const downPath = reversed.map((d, i) => `${i === 0 ? "M" : "L"}${pad.left + i * stepX},${scaleY(d.limitDown)}`).join(" ");
  const blownPath = reversed.map((d, i) => `${i === 0 ? "M" : "L"}${pad.left + i * stepX},${scaleY(d.blownUp)}`).join(" ");

  const areaUp = upPath + ` L${pad.left + (reversed.length - 1) * stepX},${pad.top + chartH} L${pad.left},${pad.top + chartH} Z`;
  const areaDown = downPath + ` L${pad.left + (reversed.length - 1) * stepX},${pad.top + chartH} L${pad.left},${pad.top + chartH} Z`;

  /* ---- 鼠标悬停 ---- */
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scale = w / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    const cx = mx - pad.left;
    if (cx < 0 || cx > chartW) { setHoverIdx(null); return; }
    const idx = Math.round(cx / stepX);
    setHoverIdx(idx >= 0 && idx < reversed.length ? idx : null);
  };
  const handleMouseLeave = () => setHoverIdx(null);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#8b7a5e]">涨停跌停趋势 (近{reversed.length}天)</span>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[#b8533a]" />涨停</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[#4a6b3f]" />跌停</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[#d4943a]" />炸板</span>
        </div>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${w} ${h}`} className="h-[120px] w-full" preserveAspectRatio="xMidYMid meet"
        onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} style={{ cursor: hoverIdx !== null ? "crosshair" : "default" }}>
        {/* 网格线 + Y轴标签 */}
        {[0, 0.25, 0.5, 0.75, 1].map(p => (
          <g key={p}>
            <line x1={pad.left} y1={pad.top + chartH * (1 - p)} x2={pad.left + chartW} y2={pad.top + chartH * (1 - p)} stroke="#e0d5c0" strokeWidth={0.5} strokeDasharray="3,3" />
            <text x={pad.left - 4} y={pad.top + chartH * (1 - p) + 3} textAnchor="end" fontSize={8} fill="#a8987e">{Math.round(maxVal * p)}</text>
          </g>
        ))}
        {/* 面积填充 */}
        <path d={areaUp} fill="#b8533a" opacity={0.08} />
        <path d={areaDown} fill="#4a6b3f" opacity={0.08} />
        {/* 折线 */}
        <path d={upPath} fill="none" stroke="#b8533a" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={downPath} fill="none" stroke="#4a6b3f" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={blownPath} fill="none" stroke="#d4943a" strokeWidth={1.5} strokeLinejoin="round" strokeDasharray="4,2" />
        {/* 日期标签 */}
        {reversed.map((d, i) => {
          if (i % Math.max(1, Math.floor(reversed.length / 5)) !== 0 && i !== reversed.length - 1) return null;
          const dateStr = d.date?.slice(5) || "";
          return (
            <text key={i} x={pad.left + i * stepX} y={h - 3} textAnchor="middle" fontSize={8} fill="#a8987e">
              {dateStr}
            </text>
          );
        })}
        {/* 十字交叉线 + 数据提示框 */}
        {hoverIdx !== null && (() => {
          const d = reversed[hoverIdx];
          const cx = pad.left + hoverIdx * stepX;
          const tipW = 90, tipH = 48;
          let boxX = cx + 8;
          if (boxX + tipW > w - pad.right) boxX = cx - tipW - 8;
          const boxY = pad.top + 2;
          return (
            <g>
              <line x1={cx} y1={pad.top} x2={cx} y2={pad.top + chartH} stroke="#8b7a5e" strokeWidth={1} strokeDasharray="2,3" />
              <circle cx={cx} cy={scaleY(d.limitUp)} r={3} fill="#b8533a" />
              <circle cx={cx} cy={scaleY(d.limitDown)} r={3} fill="#4a6b3f" />
              <circle cx={cx} cy={scaleY(d.blownUp)} r={3} fill="#d4943a" />
              <rect x={boxX} y={boxY} width={tipW} height={tipH} rx={3} fill="#f5f0e6" stroke="#d4c5a8" strokeWidth={0.8} opacity={0.95} />
              <text x={boxX + tipW / 2} y={boxY + 12} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#6b5b3e">{d.date?.slice(5) || d.date}</text>
              <text x={boxX + 6} y={boxY + 24} fontSize={8} fill="#b8533a">↑ {d.limitUp}</text>
              <text x={boxX + tipW / 2} y={boxY + 24} textAnchor="middle" fontSize={8} fill="#4a6b3f">↓ {d.limitDown}</text>
              <text x={boxX + tipW - 6} y={boxY + 24} textAnchor="end" fontSize={8} fill="#d4943a">⚡ {d.blownUp}</text>
              <text x={boxX + 6} y={boxY + 37} fontSize={8} fill="#8b7a5e">炸板率 {d.blownRate != null ? d.blownRate.toFixed(1) + "%" : "-"}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

/* ========== 可滚动面板容器 ========== */
function ScrollSentinel({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="scroll-sentinel flex flex-col gap-2 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#d4c5a8 transparent" }}
      >
        {children}
      </div>
      <style>{`
        .scroll-sentinel::-webkit-scrollbar { width: 4px; }
        .scroll-sentinel::-webkit-scrollbar-track { background: transparent; }
        .scroll-sentinel::-webkit-scrollbar-thumb { background: #d4c5a8; border-radius: 2px; }
        .scroll-sentinel::-webkit-scrollbar-thumb:hover { background: #c8b89a; }
      `}</style>
    </div>
  );
}

/* ========== 主面板: 市场情绪 (独立) ========== */
export function MarketSentimentPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const { data: sentData, loading } = usePolling(
    () => api.pluginMarketSentiment(),
    15000,
    []
  );

  const updateTime = useMemo(() => {
    return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }, [sentData]);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="市场情绪"
      icon="◉"
      accent="#d4943a"
    >
      <div className="flex h-full min-h-0 flex-col p-2.5">
        {/* 顶部状态栏 */}
        <div className="mb-2 shrink-0 rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
          <div className="flex items-center gap-2 text-[12px] text-[#8b7a5e]">
            <span className="font-semibold text-[#6b5b3e]">市场情绪</span>
            <span className="text-[#d4c5a8]">|</span>
            <span>数据源: 开盘啦</span>
            <span className="text-[#d4c5a8]">|</span>
            <span>更新: {updateTime}</span>
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : !sentData?.dataSuccess ? (
          <Failed msg="市场情绪数据暂不可用" />
        ) : (
          <ScrollSentinel>
            {(() => {
              const { mood, sentiment: si, riseFall } = sentData;
              return (
                <>
                  {/* 第一行: 情绪评分 + 涨跌统计 + 涨停跌停 */}
                  <div className="flex shrink-0 gap-2">
                    <SentimentScoreCard score={si.sentimentScore} level={si.sentimentLevel} desc={si.sentimentDesc} />
                    <UpDownCard upCount={mood.upCount} downCount={mood.downCount} upRatio={mood.upRatio} downRatio={mood.downRatio} total={mood.totalCount} />
                    <LimitUpDownCard limitUp={mood.limitUp} limitDown={mood.limitDown} blownUp={riseFall.blownLimitUpCount} blownRate={riseFall.blownLimitUpRate} />
                  </div>

                  {/* 第二行: 多空情绪 + 量能分析 + 涨停表现 */}
                  <div className="flex shrink-0 gap-2">
                    <BullBearCard bullish={si.bullishCount} bearish={si.bearishCount} net={si.netBullish} total={si.totalStockCount} samples={si.stockSamples} />
                    <VolumeCard turnover={mood.turnover} prevTurnover={mood.prevTurnover} ratio={mood.ratio} change={mood.turnoverChange} level={mood.volLevel} />
                    <LimitPerfCard yestPerf={riseFall.yesterdayLimitUpPerf} yestBroken={riseFall.yesterdayBrokenPerf} brokenUp={riseFall.brokenLimitUpCount} />
                  </div>

                  {/* 第三行: 历史趋势图 (跨列) */}
                  <div className="flex shrink-0 gap-2">
                    {riseFall.trendData.length >= 2 && <TrendChart data={riseFall.trendData} />}
                  </div>
                </>
              );
            })()}
          </ScrollSentinel>
        )}
      </div>
    </Panel>
  );
}