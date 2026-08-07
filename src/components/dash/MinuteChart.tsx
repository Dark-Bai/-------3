import { useMemo, useRef, useState } from "react";
import { clsChg, fmtPct, fmtPrice, hexChg } from "@/lib/format";

interface MinuteChartProps {
  points: { t: string; p: number }[];
  prec: number;
  height: number;
  /** X 轴时间映射: A股交易时段(默认) / 24h(港美股等连续交易) */
  session?: "ashare" | "h24";
  /** 双击分时图回调(如唤起同花顺跳转该股) */
  onDoubleClick?: () => void;
}

/** 名义视口宽度(与容器宽度按比例对应, 坐标轴标签用百分比定位) */
const VB_W = 428;
/** 绘图区边距: 左(纵轴百分比)/右/上/下(横轴时间) */
const LEFT = 40, RIGHT = 10, TOP = 6, BOTTOM = 18;
/** A股交易时段: 09:30-11:30, 13:00-15:00, 共240分钟 */
const OPEN = 570, LUNCH_S = 690, LUNCH_E = 780, SESSION = 240;

/** 解析时间字符串为分钟数, 支持 "0930" / "09:30" / "2024-01-01 09:30" */
function toMinute(t: string): number {
  const s = t.includes(":") ? (t.trim().split(/\s+/).pop() ?? t) : t;
  if (s.includes(":")) {
    const [hh, mm] = s.split(":");
    return parseInt(hh, 10) * 60 + parseInt(mm, 10);
  }
  return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2, 4), 10);
}

/** 生成"好看"的刻度步长 */
function niceStep(target: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  const norm = target / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

/** 分时走势图: 时间/百分比坐标轴 + 鼠标悬停数据悬浮框 */
export function MinuteChart({ points, prec, height, session = "ashare", onDoubleClick }: MinuteChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const pendingRef = useRef<{ i: number; leftPct: number } | null>(null);
  const [hover, setHover] = useState<{ i: number; leftPct: number } | null>(null);

  const plotW = VB_W - LEFT - RIGHT;
  const plotH = Math.max(10, height - TOP - BOTTOM);

  const data = useMemo(() => {
    if (!points || points.length < 2 || !prec) {
      return { xs: [] as number[], pts: points, min: 0, max: 0, color: "#64748b", xTicks: [] as { label: string; x: number }[], yTicks: [] as { label: number; y: number }[] };
    }
    // 交易时间 → 归一化进度
    let es: number[];
    let xTicks: { label: string; x: number }[];
    if (session === "h24") {
      // 24h 连续交易(港美股): 相邻间隔超阈值视为休市段并压缩, 兼容跨午夜
      const GAP_MIN = 5;
      const tl = [0];
      for (let i = 1; i < points.length; i++) {
        let d = toMinute(points[i].t) - toMinute(points[i - 1].t);
        if (d < -720) d += 1440; // 跨午夜
        if (d < 0 || d > GAP_MIN) d = 1; // 休市段压缩为 1 分钟
        tl.push(tl[i - 1] + d);
      }
      const span = Math.max(tl[tl.length - 1], 1);
      es = tl.map((v) => Math.max(0, Math.min(v / span, 1)) * SESSION);
      // 横轴刻度: 取首尾加中间若干实际时间点
      const n = points.length;
      const idx = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];
      xTicks = idx.map((i) => ({ label: String(points[i].t).slice(-4), x: LEFT + (es[i] / SESSION) * plotW }));
      // 去重相邻相同标签
      xTicks = xTicks.filter((t, i, a) => i === 0 || t.label !== a[i - 1].label);
    } else {
      // A股交易时段: 09:30-11:30, 13:00-15:00, 共240分钟
      es = points.map((d) => {
        const m = toMinute(d.t);
        let e = m - OPEN;
        if (m >= LUNCH_E) e -= LUNCH_E - LUNCH_S;
        return Math.max(0, Math.min(e, SESSION));
      });
      xTicks = [
        { label: "09:30", e: 0 },
        { label: "10:30", e: 60 },
        { label: "11:30", e: 120 },
        { label: "14:00", e: 180 },
        { label: "15:00", e: 240 },
      ].map((t) => ({ label: t.label, x: LEFT + (t.e / SESSION) * plotW }));
    }
    // 时间解析失败(如未知格式)时退化为按序号均匀分布
    if (es.some((x) => !Number.isFinite(x))) {
      es = points.map((_, i) => (i / (points.length - 1)) * SESSION);
    }
    const prices = points.map((d) => d.p);
    let min = Math.min(...prices, prec);
    let max = Math.max(...prices, prec);
    if (max - min < 1e-9) { max += 1; min -= 1; }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;

    const xs = es.map((e) => LEFT + (e / SESSION) * plotW);
    const color = hexChg(prices[prices.length - 1] - prec);

    // 纵轴涨跌幅刻度
    const pctMin = ((min - prec) / prec) * 100;
    const pctMax = ((max - prec) / prec) * 100;
    const step = niceStep((pctMax - pctMin) / 4);
    const yTicks: { label: number; y: number }[] = [];
    for (let v = Math.ceil(pctMin / step) * step; v <= pctMax + 1e-9; v += step) {
      const price = prec * (1 + v / 100);
      const y = TOP + (1 - (price - min) / (max - min)) * plotH;
      yTicks.push({ label: Math.abs(v) < 0.05 ? 0 : v, y });
    }

    return { xs, pts: points, min, max, color, xTicks, yTicks };
  }, [points, prec, height, plotW, plotH, session]);

  const yOf = (price: number) => TOP + (1 - (price - data.min) / (data.max - data.min)) * plotH;
  const y0 = yOf(prec); // 昨收 0% 线

  const line = data.xs.map((x, i) => `${x.toFixed(1)},${yOf(data.pts[i].p).toFixed(1)}`).join(" ");
  const area = data.xs.length
    ? `${data.xs[0].toFixed(1)},${height - BOTTOM} ${line} ${data.xs[data.xs.length - 1].toFixed(1)},${height - BOTTOM}`
    : "";

  const handleMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !data.xs.length) return;
    const px = e.clientX - rect.left;
    const vbX = (px / rect.width) * VB_W;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < data.xs.length; i++) {
      const d = Math.abs(data.xs[i] - vbX);
      if (d < bestD) { bestD = d; best = i; }
    }
    const w = rect.width;
    const half = 70;
    const clampedPx = Math.min(Math.max(px, half), Math.max(half, w - half));
    pendingRef.current = { i: best, leftPct: (clampedPx / w) * 100 };
    if (rafRef.current) return; // 每帧合并一次, 保证流畅
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (pendingRef.current) setHover(pendingRef.current);
    });
  };

  const handleLeave = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setHover(null);
  };

  const hoverPt = hover && data.pts[hover.i] ? data.pts[hover.i] : null;
  const hoverX = hover && data.xs[hover.i] != null ? data.xs[hover.i] : null;
  const hoverY = hoverPt ? yOf(hoverPt.p) : null;
  const hoverPct = hoverPt ? ((hoverPt.p - prec) / prec) * 100 : 0;

  return (
    <div ref={wrapRef} className="relative mt-8" style={{ height }}>
      <svg
        className="block h-full w-full"
        viewBox={`0 0 ${VB_W} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onDoubleClick={onDoubleClick}
      >
        {/* 横向网格线(涨跌幅刻度) */}
        {data.yTicks.map((t, i) => (
          <line key={`g${i}`} x1={LEFT} x2={VB_W - RIGHT} y1={t.y} y2={t.y} stroke="#eae2d2" strokeWidth={0.6} />
        ))}
        {/* 昨收 0% 参考线 */}
        <line x1={LEFT} x2={VB_W - RIGHT} y1={y0} y2={y0} stroke="#c9b99a" strokeWidth={0.8} strokeDasharray="2,3" />
        {/* 区域填充 + 走势线 */}
        {area && <polygon points={area} fill={data.color} opacity={0.12} />}
        {line && (
          <polyline points={line} fill="none" stroke={data.color} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
        {/* 悬停十字线 + 数据点 */}
        {hover != null && hoverX != null && hoverY != null && (
          <>
            <line x1={hoverX} x2={hoverX} y1={TOP} y2={height - BOTTOM} stroke="#8b7a5e" strokeWidth={0.6} strokeDasharray="2,2" />
            <circle cx={hoverX} cy={hoverY} r={3} fill={data.color} stroke="#fdf9f0" strokeWidth={1} />
          </>
        )}
      </svg>

      {/* 纵轴涨跌幅刻度(HTML, 避免 SVG 文本被拉伸变形) */}
      {data.yTicks.map((t, i) => (
        <span
          key={`y${i}`}
          className="absolute left-0 -translate-y-1/2 text-[9px] leading-none text-[#a8987e]"
          style={{ top: `${(t.y / height) * 100}%` }}
        >
          {t.label.toFixed(1)}%
        </span>
      ))}
      {/* 横轴时间刻度 */}
      {data.xTicks.map((t, i) => (
        <span
          key={`x${i}`}
          className="absolute bottom-0 -translate-x-1/2 text-[9px] leading-none text-[#a8987e]"
          style={{ left: `${(t.x / VB_W) * 100}%` }}
        >
          {t.label}
        </span>
      ))}

      {/* 悬浮信息框(分时图框上方外侧) */}
      {hoverPt && hover != null && (
        <div
          className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-[#e0d5c0] bg-[#fdf9f0] px-2 py-1 text-[10px] shadow-sm"
          style={{ left: `${hover.leftPct}%` }}
        >
          <span className="mr-1.5 text-[#a8987e]">{hoverPt.t}</span>
          <span className="mr-1.5 font-semibold text-[#6b5b3e]" style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtPrice(hoverPt.p)}
          </span>
          <span className={`font-semibold ${clsChg(hoverPct)}`} style={{ fontVariantNumeric: "tabular-nums" }}>
            {fmtPct(hoverPct)}
          </span>
        </div>
      )}
    </div>
  );
}