import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type PluginMarketSentimentData } from "@/lib/api";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;
/** 市场情绪轮询时段: 每日 08:59 - 15:00(收盘)。此处纯时间判断, 前端据此启停轮询 */
function inPollWindow(now = new Date()) {
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= 8 * 60 + 59 && m < 15 * 60;
}
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
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
/* 智能纵坐标刻度: 生成"nice numbers"(1/2/5 × 10^n), 保证间隔均匀易读 */
function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(Math.max(range, 1e-9)));
  const frac = range / Math.pow(10, exp);
  let nf: number;
  if (round) {
    if (frac < 1.5) nf = 1; else if (frac < 3) nf = 2; else if (frac < 7) nf = 5; else nf = 10;
  } else {
    if (frac <= 1) nf = 1; else if (frac <= 2) nf = 2; else if (frac <= 5) nf = 5; else nf = 10;
  }
  return nf * Math.pow(10, exp);
}
function TrendChart({ data }: { data: PluginMarketSentimentData["riseFall"]["trendData"] }) {
  if (!data || data.length < 2) return null;
  const allReversed = [...data].reverse();
  // 最多查看半年内的交易日(以最新日期往前推6个月为截止线)
  const latestDate = new Date(allReversed[0].date);
  const cutoff = new Date(latestDate);
  cutoff.setMonth(cutoff.getMonth() - 6);
  const maxDays = allReversed.filter(d => new Date(d.date) >= cutoff).length;
  const [viewDays, setViewDays] = useState<number>(Math.min(7, maxDays, allReversed.length));
  const [daysInput, setDaysInput] = useState<string>(String(Math.min(7, maxDays, allReversed.length)));
  const reversed = viewDays < allReversed.length ? allReversed.slice(0, viewDays) : allReversed;
  const maxVal = Math.max(...reversed.map(d => Math.max(d.limitUp, d.limitDown, d.blownUp)), 10);
  const minNonZero = Math.min(...reversed.map(d => [d.limitUp, d.limitDown, d.blownUp].filter(v => v > 0)).flat(), maxVal);
  const w = 600, h = 120, pad = { top: 10, bottom: 18, left: 28, right: 8 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const stepX = chartW / (reversed.length - 1);
  /* ---- 智能纵坐标刻度(随展示天数与数据范围自适应) ---- */
  // 对数刻度: 仅当所有值>0 且跨度>=100倍时启用(0值会导致 log(0) 无意义, 故需全部>0)
  const useLog = minNonZero > 0 && maxVal / minNonZero >= 100;
  // 目标刻度数: 展示天数越多刻度略少, 避免y轴标签过于密集
  const targetTicks = reversed.length <= 10 ? 6 : reversed.length <= 30 ? 5 : 4;
  let ticks: number[]; let maxTick: number; let scaleY: (v: number) => number;
  if (useLog) {
    const lo = Math.floor(Math.log10(minNonZero));
    const hi = Math.ceil(Math.log10(maxVal));
    const tSet = new Set<number>();
    for (let e = lo; e <= hi; e++) { const b = Math.pow(10, e); [1, 2, 5].forEach(m => tSet.add(m * b)); }
    ticks = [...tSet].filter(t => t >= minNonZero * 0.9 && t <= maxVal * 1.1).sort((a, b) => a - b);
    maxTick = ticks[ticks.length - 1];
    const logRange = Math.log10(maxTick) - Math.log10(minNonZero);
    scaleY = (v) => pad.top + chartH - (Math.log10(Math.max(v, 1)) - Math.log10(minNonZero)) / logRange * chartH;
  } else {
    const step = niceNum(maxVal / Math.max(1, targetTicks - 1), true);
    maxTick = Math.ceil(maxVal / step) * step;
    ticks = [];
    for (let v = 0; v <= maxTick + step * 1e-6; v += step) ticks.push(Math.round(v));
    scaleY = (v) => pad.top + chartH - (v / maxTick * chartH);
  }
  // SVG 坐标 → 容器百分比(用于 HTML 覆盖层定位, 使文字保持正常比例)
  const px = (x: number) => `${(x / w) * 100}%`;
  const py = (y: number) => `${(y / h) * 100}%`;

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
      {/* 查看天数控制 */}
      <div className="mb-1 flex items-center gap-1.5 text-[10px] text-[#8b7a5e]">
        <span>查看</span>
        {[7, 15, 30].filter(n => n < maxDays).map(n => (
          <button key={n} onClick={() => { setViewDays(n); setDaysInput(String(n)); }}
            className={`rounded px-1.5 py-0.5 transition-colors ${viewDays === n ? "bg-[#d4943a] text-white" : "bg-[#e0d5c0] hover:bg-[#d4c5a8]"}`}>
            {n}天
          </button>
        ))}
        <button onClick={() => { setViewDays(maxDays); setDaysInput(String(maxDays)); }}
          className={`rounded px-1.5 py-0.5 transition-colors ${viewDays === maxDays ? "bg-[#d4943a] text-white" : "bg-[#e0d5c0] hover:bg-[#d4c5a8]"}`}>
          全部
        </button>
        <input type="number" min={2} max={maxDays} value={daysInput}
          onChange={e => {
            const v = e.target.value;
            setDaysInput(v);
            if (v === "") return; // 允许空值, 便于输入
            const n = Number(v);
            if (!isNaN(n) && n >= 2) setViewDays(Math.min(maxDays, n));
          }}
          onBlur={() => { if (daysInput === "") setDaysInput(String(viewDays)); }} // 失焦时若为空则回填当前值
          className="w-12 rounded border border-[#d4c5a8] bg-[#f5f0e6] px-1 py-0.5 text-center text-[10px] text-[#6b5b3e] outline-none focus:border-[#a8987e]" />
        <span>天</span>
      </div>
      <div className="relative min-h-0 w-full flex-1">
        <svg ref={svgRef} viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none"
          onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} style={{ cursor: hoverIdx !== null ? "crosshair" : "default" }}>
          {/* 网格线(几何, 拉伸) */}
          {ticks.map(t => (
            <line key={t} x1={pad.left} y1={scaleY(t)} x2={pad.left + chartW} y2={scaleY(t)} stroke="#e0d5c0" strokeWidth={0.5} strokeDasharray="3,3" />
          ))}
          {/* 面积填充 + 折线(几何, 拉伸) */}
          <path d={areaUp} fill="#b8533a" opacity={0.08} />
          <path d={areaDown} fill="#4a6b3f" opacity={0.08} />
          <path d={upPath} fill="none" stroke="#b8533a" strokeWidth={1.5} strokeLinejoin="round" />
          <path d={downPath} fill="none" stroke="#4a6b3f" strokeWidth={1.5} strokeLinejoin="round" />
          <path d={blownPath} fill="none" stroke="#d4943a" strokeWidth={1.5} strokeLinejoin="round" strokeDasharray="4,2" />
        </svg>

        {/* Y轴标签 (HTML, 正常比例) */}
        {ticks.map(t => (
          <span key={t} className="absolute text-[8px] leading-none text-[#a8987e]" style={{ left: px(pad.left - 4), top: py(scaleY(t) + 3), transform: "translate(-100%, -50%)" }}>
            {t}
          </span>
        ))}
        {/* Y轴单位 (HTML, 正常比例) */}
        <span className="absolute text-[8px] leading-none text-[#a8987e]" style={{ left: px(pad.left - 4), top: py(pad.top - 2), transform: "translate(-100%, -100%)" }}>家</span>

        {/* 日期标签 (HTML, 正常比例) */}
        {reversed.map((d, i) => {
          if (i % Math.max(1, Math.floor(reversed.length / 5)) !== 0 && i !== reversed.length - 1) return null;
          const dateStr = d.date?.slice(5) || "";
          return (
            <span key={i} className="absolute whitespace-nowrap text-[8px] leading-none text-[#a8987e]" style={{ left: px(pad.left + i * stepX), top: py(h - 3), transform: "translate(-50%, 0%)" }}>
              {dateStr}
            </span>
          );
        })}

        {/* 悬停十字线 + 提示框 (HTML, 正常比例) */}
        {hoverIdx !== null && (() => {
          const d = reversed[hoverIdx];
          const cx = pad.left + hoverIdx * stepX;
          const tipW = 90, tipH = 48;
          let boxX = cx + 8;
          if (boxX + tipW > w - pad.right) boxX = cx - tipW - 8;
          const boxY = pad.top + 2;
          return (
            <>
              <div className="absolute bg-[#8b7a5e]" style={{ left: px(cx), top: py(pad.top), width: 1, height: `${((pad.top + chartH) - pad.top) / h * 100}%`, opacity: 0.6 }} />
              <span className="absolute h-1.5 w-1.5 rounded-full bg-[#b8533a]" style={{ left: px(cx), top: py(scaleY(d.limitUp)), transform: "translate(-50%,-50%)" }} />
              <span className="absolute h-1.5 w-1.5 rounded-full bg-[#4a6b3f]" style={{ left: px(cx), top: py(scaleY(d.limitDown)), transform: "translate(-50%,-50%)" }} />
              <span className="absolute h-1.5 w-1.5 rounded-full bg-[#d4943a]" style={{ left: px(cx), top: py(scaleY(d.blownUp)), transform: "translate(-50%,-50%)" }} />
              <div className="absolute" style={{ left: px(boxX), top: py(boxY), width: tipW, height: tipH }}>
                <div className="flex h-full flex-col justify-center rounded border border-[#d4c5a8] bg-[#f5f0e6] px-1.5 text-[8px] leading-tight opacity-95">
                  <div className="text-[9px] font-bold text-[#6b5b3e]">{d.date?.slice(5) || d.date}</div>
                  <div className="flex justify-between text-[#b8533a]"><span>↑ {d.limitUp}</span><span>↓ {d.limitDown}</span><span>⚡ {d.blownUp}</span></div>
                  <div className="text-[#8b7a5e]">炸板率 {d.blownRate != null ? d.blownRate.toFixed(1) + "%" : "-"}</div>
                </div>
              </div>
            </>
          );
        })()}
      </div>
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
/** 刷新中指示器: 脉冲圆点 + 文案, 用户感知数据正在后台更新 */
function RefreshingChip() {
  return (
    <span className="inline-flex items-center gap-1 text-[#3a6ea5]">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#3a6ea5]/60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#3a6ea5]" />
      </span>
      刷新中
    </span>
  );
}

export function MarketSentimentPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  // 轮询时段: 每日 08:59-15:00; 每 30s 校准一次, 收盘后停发、次日开盘自动恢复
  const [inWindow, setInWindow] = useState(() => inPollWindow());
  useEffect(() => {
    const t = setInterval(() => setInWindow(inPollWindow()), 30000);
    return () => clearInterval(t);
  }, []);

  // 轮询: 时段内每 15s 拉取; 收盘后 enabled=false → 完全停发, 保留当前数据(定格)
  const { data: sentData, loading, refreshing } = usePolling(
    () => api.pluginMarketSentiment(),
    inWindow ? 15000 : 0,
    [],
    undefined,
    inWindow
  );

  // 粘性数据: 新响应 dataSuccess=false(上游失败聚合为空)时沿用上一次成功数据, 杜绝刷新闪空
  const [sticky, setSticky] = useState<PluginMarketSentimentData | null>(null);
  useEffect(() => {
    if (sentData?.dataSuccess) setSticky(sentData);
  }, [sentData]);
  const live = sentData?.dataSuccess ? sentData : sticky;

  // 收盘停止期间: 单次拉取后端持久化的定格快照(不轮询), 保证刷新/重开页面也能展示定格数据
  const [frozen, setFrozen] = useState<PluginMarketSentimentData | null>(null);
  useEffect(() => {
    if (inWindow) return;
    let cancelled = false;
    api.pluginMarketSentiment().then((d) => { if (!cancelled) setFrozen(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [inWindow]);

  const effective = live ?? frozen;
  // 状态: 已停止 / 数据加载中 / 轮询中
  const stateKey = !inWindow ? "stopped" : (loading && !effective ? "loading" : "polling");
  const stateLabel = stateKey === "stopped" ? "已停止" : stateKey === "loading" ? "数据加载中" : "轮询中";
  const stateColor = stateKey === "stopped" ? "#8b7a5e" : stateKey === "loading" ? "#d4943a" : "#4a6b3f";

  const updateTime = useMemo(() => {
    return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }, [effective]);

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
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: stateColor }} />
              <span style={{ color: stateColor }}>{stateLabel}</span>
            </span>
            {refreshing && effective?.dataSuccess && <RefreshingChip />}
            {stateKey === "stopped" && <span className="text-[10px] text-[#a8987e]">(数据定格)</span>}
            <span className="text-[#d4c5a8]">|</span>
            <span>更新: {updateTime}</span>
          </div>
        </div>

        {loading && !effective ? (
          <Loading />
        ) : !effective?.dataSuccess ? (
          <Failed msg={stateKey === "stopped" ? "暂无定格数据" : "市场情绪数据暂不可用"} />
        ) : (
          <ScrollSentinel>
            {(() => {
              const { mood, sentiment: si, riseFall } = effective;
              return (
                <>
                  <div className="flex gap-2">
                    {/* 左列: 6个小卡片 (固定49%宽, 为折线图让出更多宽度) */}
                    <div className="flex w-[49%] shrink-0 flex-col gap-2">
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
                    </div>

                    {/* 右列: 折线图占满右侧, 竖跨两行高度 */}
                    <div className="flex min-w-0 flex-1">
                      {riseFall.trendData.length >= 2 && <TrendChart data={riseFall.trendData} />}
                    </div>
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