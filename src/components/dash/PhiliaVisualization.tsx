/**
 * PHILIA M4 可视化区
 *
 * 三张图表:
 *  1. 情绪走势        —— 基于 /api/plugin-market-sentiment 的 riseFall.trendData(近N日涨停家数/炸板率)
 *  2. 机会-风险矩阵    —— 来自 analysis.result 的机会权重(x)·风险权重(y) 二维散点
 *  3. 核心标的权重     —— 来自 analysis.result.stocks 的权重横向条形
 *
 * 全部手写 SVG, 无第三方图表依赖, 复用驾驶舱复古报刊配色。
 */
import { useEffect, useState } from "react";
import { api, type PhiliaAnalysisResult, type PluginMarketSentimentData } from "@/lib/api";

const C = {
  red: "#b8533a",
  green: "#4a6b3f",
  orange: "#d4943a",
  beige: "#a8987e",
  dark: "#6b5b3e",
  bg: "#f5f0e6",
  border: "#e0d5c0",
  text: "#8b7a5e",
};

const pct = (w?: number) => `${Math.round((w || 0) * 100)}%`;

/** 日期 → MM-DD 短格式(与图表刻度一致) */
const fmtDate = (d?: string) => (d && d.length >= 10 ? d.slice(5) : d || "");

/** 外层标题栏(三个图表共用): 标题右侧标注数据来源 + 数据日期 */
function ChartShell({ title, meta, colors, children }: {
  title: string;
  meta?: string;
  colors?: { label: string; color: string }[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2 py-1.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="shrink-0 text-[10px] font-bold font-newspaper-heading text-[#6b5b3e]">{title}</span>
        {meta && (
          <span
            className="shrink-0 rounded bg-[#ede4d4] px-1 py-px text-[8px] leading-none text-[#a8987e]"
            title={meta}
          >
            {meta}
          </span>
        )}
        {colors && (
          <span className="ml-auto flex items-center gap-2">
            {colors.map((c) => (
              <span key={c.label} className="flex items-center gap-0.5 text-[8px] text-[#8b7a5e]">
                <span className="h-1 w-2 rounded" style={{ background: c.color }} />{c.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/* ========== 图表1: 情绪走势(涨停家数 + 炸板率) ========== */
function SentimentTrend({ data, onDate }: { data: PluginMarketSentimentData | null; onDate?: (d: string) => void }) {
  const trend = data?.riseFall?.trendData || [];
  useEffect(() => {
    if (onDate && data?.riseFall?.date) onDate(data.riseFall.date);
  }, [data, onDate]);
  const pts = trend.slice(-12); // 近 12 个交易日
  if (pts.length < 2) {
    return (
      <div className="flex h-full items-center justify-center text-[10px] text-[#a8987e]">
        暂无情绪走势数据
      </div>
    );
  }
  const W = 300, H = 120, PL = 26, PR = 8, PT = 8, PB = 16;
  const iw = W - PL - PR, ih = H - PT - PB;
  const maxUp = Math.max(...pts.map((p) => p.limitUp), 1);
  const maxBr = Math.max(...pts.map((p) => p.blownRate), 1);
  const x = (i: number) => PL + (i / (pts.length - 1)) * iw;
  const line = (vals: number[], max: number) =>
    vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${(PT + ih - (v / max) * ih).toFixed(1)}`).join(" ");
  return (
    <svg width={W} height={H} className="h-full w-full" viewBox={`0 0 ${W} ${H}`}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const yy = PT + ih * (1 - t);
        return (
          <g key={t}>
            <line x1={PL} x2={W - PR} y1={yy} y2={yy} stroke={C.border} strokeWidth={1} strokeDasharray="3 3" />
            <text x={PL - 4} y={yy + 3} textAnchor="end" fontSize={8} fill={C.beige}>{Math.round(t * maxUp)}</text>
          </g>
        );
      })}
      {/* 炸板率(面积弱化) */}
      <path d={`${line(pts.map((p) => p.blownRate), maxBr)} L${x(pts.length - 1)},${PT + ih} L${x(0)},${PT + ih} Z`} fill={C.orange} opacity={0.12} />
      <path d={line(pts.map((p) => p.blownRate), maxBr)} fill="none" stroke={C.orange} strokeWidth={1.4} />
      {/* 涨停家数 */}
      <path d={`${line(pts.map((p) => p.limitUp), maxUp)} L${x(pts.length - 1)},${PT + ih} L${x(0)},${PT + ih} Z`} fill={C.red} opacity={0.10} />
      <path d={line(pts.map((p) => p.limitUp), maxUp)} fill="none" stroke={C.red} strokeWidth={1.8} />
      {/* 末点数值 */}
      <text x={x(pts.length - 1)} y={PT + ih - (pts[pts.length - 1].limitUp / maxUp) * ih - 4} textAnchor="end" fontSize={8} fontWeight="bold" fill={C.red}>
        {pts[pts.length - 1].limitUp}
      </text>
      {/* 日期刻度 */}
      {pts.map((p, i) => (
        <text key={p.date} x={x(i)} y={H - 4} textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"} fontSize={7} fill={C.beige}>
          {p.date.slice(5)}
        </text>
      ))}
    </svg>
  );
}

/* ========== 图表2: 机会-风险矩阵 ========== */
function OpportunityRiskMatrix({ result }: { result: PhiliaAnalysisResult }) {
  const opps = result.opportunities || [];
  const risks = result.risks || [];
  const W = 300, H = 120, PL = 30, PR = 8, PT = 8, PB = 16;
  const iw = W - PL - PR, ih = H - PT - PB;
  const maxOp = Math.max(...opps.map((o) => o.weight), 0.01);
  const maxRk = Math.max(...risks.map((r) => r.weight), 0.01);
  // 机会: 沿 x 轴按权重排布(底部横带); 风险: 沿 y 轴按权重排布(左侧竖带)
  const opX = (w: number) => PL + (w / maxOp) * iw;
  const rkY = (w: number) => PT + ih - (w / maxRk) * ih;
  const OX = opps.map((o) => opX(o.weight));
  const OY = PT + ih * 0.28; // 机会点固定横带
  const RX = PL + iw * 0.3;  // 风险点固定竖带
  const RY = risks.map((r) => rkY(r.weight));
  // 象限分隔线
  const midOp = PL + iw * 0.5, midRk = PT + ih * 0.5;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <svg width={W} height={H} className="min-h-0 w-full flex-1" viewBox={`0 0 ${W} ${H}`}>
        {/* 象限背景 */}
        <rect x={PL} y={PT} width={iw} height={ih} fill="#faf6ee" stroke={C.border} strokeWidth={1} />
        <rect x={midOp} y={PT} width={W - PR - midOp} height={midRk - PT} fill={C.green} opacity={0.05} />
        <rect x={midOp} y={midRk} width={W - PR - midOp} height={PT + ih - midRk} fill={C.red} opacity={0.05} />
        <line x1={midOp} x2={midOp} y1={PT} y2={PT + ih} stroke={C.border} strokeWidth={1} strokeDasharray="3 3" />
        <line x1={PL} x2={W - PR} y1={midRk} y2={midRk} stroke={C.border} strokeWidth={1} strokeDasharray="3 3" />
        {/* 轴标签 */}
        <text x={PL + iw / 2} y={PT + ih + 11} textAnchor="middle" fontSize={8} fill={C.beige}>机会权重 →</text>
        <text x={PL - 4} y={midRk + 3} textAnchor="end" fontSize={8} fill={C.beige}>风险权重</text>
        {/* 机会点(绿) */}
        {opps.map((_, i) => (
          <g key={i}>
            <circle cx={OX[i]} cy={OY} r={4} fill={C.green} stroke="#fff" strokeWidth={1} />
            <text x={OX[i]} y={OY - 6} textAnchor="middle" fontSize={7} fill={C.dark}>{i + 1}</text>
          </g>
        ))}
        {/* 风险点(橙) */}
        {risks.map((_, i) => (
          <g key={i}>
            <circle cx={RX} cy={RY[i]} r={4} fill={C.orange} stroke="#fff" strokeWidth={1} />
            <text x={RX + 8} y={RY[i] + 3} textAnchor="start" fontSize={7} fill={C.dark}>{i + 1}</text>
          </g>
        ))}
      </svg>
      {/* 图例: 机会 */}
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[8px] text-[#8b7a5e]">
        {opps.map((o, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <span className="text-[#4a6b3f]">{i + 1}.</span>
            <span className="max-w-[80px] truncate">{o.sector || o.type}</span>
            <span className="text-[#4a6b3f]">{pct(o.weight)}</span>
          </span>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[8px] text-[#8b7a5e]">
        <span className="text-[#d4943a]">风险</span>
        {risks.map((r, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <span className="text-[#d4943a]">{i + 1}.</span>
            <span className="max-w-[80px] truncate">{r.scope}</span>
            <span className="text-[#d4943a]">{pct(r.weight)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ========== 图表3: 核心标的权重(横向条形) ========== */
function StockWeight({ result }: { result: PhiliaAnalysisResult }) {
  const stocks = result.stocks || [];
  if (!stocks.length) {
    return <div className="flex h-full items-center justify-center text-[10px] text-[#a8987e]">暂无核心标的</div>;
  }
  const maxW = Math.max(...stocks.map((s) => s.weight), 0.01);
  const W = 300, H = 120, PL = 62, PR = 34, PT = 6, PB = 6;
  const iw = W - PL - PR;
  const rowH = (H - PT - PB) / stocks.length;
  const barH = Math.max(rowH * 0.5, 6);
  const colors = [C.red, C.orange, C.beige, C.green, C.dark];
  return (
    <svg width={W} height={H} className="h-full w-full" viewBox={`0 0 ${W} ${H}`}>
      {stocks.map((s, i) => {
        const y = PT + i * rowH + (rowH - barH) / 2;
        const bw = Math.max((s.weight / maxW) * iw, 4);
        return (
          <g key={s.code || s.name}>
            <text x={PL - 4} y={y + barH / 2 + 2.5} textAnchor="end" fontSize={8} fill={C.text}>
              {s.name}
            </text>
            <rect x={PL} y={y} width={bw} height={barH} rx={2} fill={colors[i % colors.length]} />
            <text x={PL + bw + 4} y={y + barH / 2 + 2.5} fontSize={8} fontWeight="bold" fill={C.dark}>
              {pct(s.weight)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ========== 可视化区容器 ========== */
export function PhiliaVisualization({ result, date }: { result: PhiliaAnalysisResult; date?: string }) {
  const [sent, setSent] = useState<PluginMarketSentimentData | null>(null);
  const [sentDate, setSentDate] = useState<string>("");

  useEffect(() => {
    let alive = true;
    api
      .pluginMarketSentiment()
      .then((d) => alive && setSent(d))
      .catch(() => alive && setSent(null));
    return () => {
      alive = false;
    };
  }, []);

  const aiMeta = `DeepSeek AI · ${fmtDate(date) || "—"}`;
  const sentMeta = `东方财富网页数据 · ${fmtDate(sentDate) || "—"}`;

  return (
    <div className="grid h-full min-h-0 grid-cols-3 gap-1.5 p-2">
      <ChartShell
        title="情绪走势"
        meta={sentMeta}
        colors={[
          { label: "涨停", color: C.red },
          { label: "炸板率", color: C.orange },
        ]}
      >
        <SentimentTrend data={sent} onDate={setSentDate} />
      </ChartShell>
      <ChartShell title="机会-风险矩阵" meta={aiMeta}>
        <OpportunityRiskMatrix result={result} />
      </ChartShell>
      <ChartShell title="核心标的权重" meta={aiMeta}>
        <StockWeight result={result} />
      </ChartShell>
    </div>
  );
}