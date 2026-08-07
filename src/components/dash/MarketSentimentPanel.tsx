import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type LadderData, type LadderTrendPoint, type PluginMarketSentimentData } from "@/lib/api";

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

/* ========== 卡片1: 市场情绪评分 (圆形仪表盘, 紧凑) ========== */
function SentimentScoreCard({ score, level, desc }: { score: number; level: string; desc: string }) {
  const color = score >= 75 ? COLORS.red : score >= 60 ? COLORS.orange : score >= 45 ? COLORS.beige : score >= 30 ? COLORS.green : "#4a6b3f";
  const bgTag = score >= 75 ? "bg-[#b8533a]/15 text-[#b8533a]" : score >= 60 ? "bg-[#d4943a]/15 text-[#d4943a]" : score >= 45 ? "bg-[#a8987e]/15 text-[#a8987e]" : score >= 30 ? "bg-[#4a6b3f]/15 text-[#4a6b3f]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  // 圆弧参数(紧凑: 44px 仪表)
  const r = 17, cx = 22, cy = 22, circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      <div className="mb-0.5 truncate text-[10px] font-semibold text-[#8b7a5e]">市场情绪评分</div>
      <div className="flex min-h-0 flex-1 items-center gap-1.5">
        {/* SVG 圆形仪表 */}
        <svg width={44} height={44} viewBox="0 0 44 44" className="shrink-0">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e0d5c0" strokeWidth={4} />
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={4}
            strokeDasharray={circumference} strokeDashoffset={offset}
            strokeLinecap="round" transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: "stroke-dashoffset 0.6s ease" }} />
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight="bold" fill={color} style={{ fontVariantNumeric: "tabular-nums" }}>
            {score}
          </text>
        </svg>
        <div className="min-w-0 flex-1">
          <span className={`inline-block max-w-full truncate rounded px-1 py-px text-[10px] font-medium ${bgTag}`}>{level}</span>
          <div className="mt-0.5 truncate text-[10px] leading-tight text-[#8b7a5e]" title={desc}>{desc}</div>
        </div>
      </div>
    </div>
  );
}

/* ========== 卡片2: 涨跌统计 (紧凑) ========== */
function UpDownCard({ upCount, downCount, upRatio, downRatio, total }: { upCount: number; downCount: number; upRatio: number; downRatio: number; total: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      <div className="mb-0.5 truncate text-[10px] font-semibold text-[#8b7a5e]">涨跌统计</div>
      <div className="flex min-h-0 flex-1 items-center gap-1">
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#b8533a]" style={TNUM}>{fmt(upCount)}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">上涨</div>
        </div>
        <div className="text-[13px] leading-none text-[#d4c5a8]">/</div>
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#4a6b3f]" style={TNUM}>{fmt(downCount)}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">下跌</div>
        </div>
      </div>
      {/* 涨跌比例条(紧凑) */}
      <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-full bg-[#e0d5c0]">
        <div className="h-full rounded-l-full bg-[#b8533a]" style={{ width: `${upRatio}%` }} />
        <div className="h-full rounded-r-full bg-[#4a6b3f]" style={{ flex: 1 }} />
      </div>
      <div className="mt-0.5 flex items-center justify-between text-[9px] leading-none text-[#a8987e]">
        <span>{upRatio.toFixed(1)}%</span>
        <span>总{fmt(total)}</span>
        <span>{downRatio.toFixed(1)}%</span>
      </div>
    </div>
  );
}

/* ========== 卡片3: 涨停跌停对比 (紧凑) ========== */
function LimitUpDownCard({ limitUp, limitDown, blownUp, blownRate }: { limitUp: number; limitDown: number; blownUp: number; blownRate: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      <div className="mb-0.5 truncate text-[10px] font-semibold text-[#8b7a5e]">涨停跌停</div>
      <div className="flex min-h-0 flex-1 items-center justify-around gap-0.5">
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#b8533a]" style={TNUM}>{limitUp}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">涨停</div>
        </div>
        <div className="text-[13px] leading-none text-[#d4c5a8]">/</div>
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#4a6b3f]" style={TNUM}>{limitDown}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">跌停</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#d4943a]" style={TNUM}>{blownUp}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">炸板</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#6b5b3e]" style={TNUM}>{blownRate.toFixed(1)}%</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">炸板率</div>
        </div>
      </div>
    </div>
  );
}

/* ========== 卡片4: 连板梯队(api/market/limit-up-ladder, 紧凑) ========== */
function LadderCard({ ladder }: { ladder: LadderData }) {
  const [open, setOpen] = useState(false);
  const hasData = ladder.firstBoard + ladder.secondBoard + ladder.thirdBoard + ladder.highBoard > 0;
  const boards = [
    { label: "一板", v: ladder.firstBoard, color: COLORS.red },
    { label: "二板", v: ladder.secondBoard, color: COLORS.orange },
    { label: "三板", v: ladder.thirdBoard, color: COLORS.beige },
    { label: "高度板", v: ladder.highBoard, color: COLORS.green },
  ];
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full cursor-pointer items-center justify-between"
        title="点击查看连板梯队明细"
      >
        <span className="truncate text-[10px] font-semibold text-[#8b7a5e]">连板梯队</span>
        {hasData && (
          <span className="shrink-0 rounded bg-[#d4943a]/15 px-1 py-px text-[9px] font-medium text-[#b07a2a]" style={TNUM}>
            {ladder.ladderRate.toFixed(1)}%
          </span>
        )}
      </button>
      {hasData ? (
        <>
          <div className="flex min-h-0 flex-1 items-center justify-around gap-0.5">
            {boards.map((b) => (
              <div key={b.label} className="flex min-w-0 flex-col items-center">
                <div className="text-[14px] font-bold leading-none" style={{ color: b.color, fontVariantNumeric: "tabular-nums" }}>{b.v}</div>
                <div className="text-[9px] leading-tight text-[#a8987e]">{b.label}</div>
              </div>
            ))}
          </div>
          <div className="mt-0.5 flex items-center justify-between text-[9px] leading-none text-[#a8987e]" style={TNUM}>
            <span>{ladder.date ? ladder.date.slice(5) : "—"}</span>
            <span>破板 {ladder.brokenRate.toFixed(1)}%</span>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[#a8987e]">暂无数据</div>
      )}
      <LadderModal open={open} onClose={() => setOpen(false)} ladder={ladder} />
    </div>
  );
}

/* ========== 连板梯队趋势图(SVG 多线, 各层级按自身最大值归一化) ========== */
function LadderTrendChart({ trend }: { trend: LadderTrendPoint[] }) {
  const data = trend ? [...trend].reverse() : []; // 升序
  if (!data.length || data.length < 2) return <div className="text-[12px] text-[#a8987e]">暂无趋势数据</div>;
  const W = 560, H = 168, PL = 30, PR = 12, PT = 10, PB = 22;
  const iw = W - PL - PR, ih = H - PT - PB;
  const x = (i: number) => PL + (i / (data.length - 1)) * iw;
  const series: { key: keyof Pick<LadderTrendPoint, "firstBoard" | "secondBoard" | "thirdBoard" | "highBoard">; label: string; color: string }[] = [
    { key: "firstBoard", label: "一板", color: COLORS.red },
    { key: "secondBoard", label: "二板", color: COLORS.orange },
    { key: "thirdBoard", label: "三板", color: COLORS.beige },
    { key: "highBoard", label: "高度板", color: COLORS.green },
  ];
  const path = (key: typeof series[number]["key"]) => {
    const vals = data.map((d) => d[key]);
    const max = Math.max(...vals, 1);
    return data.map((d, i) => {
      const yy = PT + ih - (d[key] / max) * ih;
      return `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yy.toFixed(1)}`;
    }).join(" ");
  };
  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1 text-[10px] text-[#8b7a5e]">
            <span className="h-1.5 w-3 rounded" style={{ background: s.color }} />{s.label}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-[#a8987e]">各层级按自身最大值归一化</span>
      </div>
      <svg width={W} height={H} className="w-full" viewBox={`0 0 ${W} ${H}`}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const yy = PT + ih * (1 - t);
          return (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={yy} y2={yy} stroke="#e0d5c0" strokeWidth={1} strokeDasharray="3 3" />
              <text x={PL - 4} y={yy + 3} textAnchor="end" fontSize={9} fill="#a8987e">{Math.round(t * 100)}</text>
            </g>
          );
        })}
        {series.map((s) => <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={1.8} />)}
        {data.map((d, i) => (
          <text key={d.date} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} fontSize={9} fill="#a8987e">
            {d.date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}

/* ========== 连板梯队明细模态小窗 ========== */
function LadderModal({ open, onClose, ladder }: {
  open: boolean;
  onClose: () => void;
  ladder: LadderData;
}) {
  // 平滑过渡: 卸载前先置 visible=false 播放退场动画, 动画结束后再真正卸载
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 渲染前先判断是否显示(管理进入/退场动画)
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const t = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(t);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  const hasData = ladder.firstBoard + ladder.secondBoard + ladder.thirdBoard + ladder.highBoard > 0;
  const perfItems = [
    { label: "昨涨停今表现", v: ladder.yestLimitUpPerf },
    { label: "昨连板今表现", v: ladder.yestLadderPerf },
    { label: "昨破板今表现", v: ladder.yestBrokenPerf },
  ];

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
      style={{ background: "rgba(43,38,28,0.45)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[78vh] w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-[#d4c5a8] bg-[#faf6ec] shadow-2xl transition-all duration-200 ${visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-4 scale-95 opacity-0"}`}
      >
        {/* 头部 */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#e0d5c0] bg-[#f5f0e6] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="rounded-sm bg-[#d4943a]/15 px-1.5 py-px text-[10px] font-medium text-[#b07a2a]">连板梯队</span>
            <span className="text-[13px] font-semibold text-[#6b5b3e]">梯队明细</span>
            {ladder.date && <span className="text-[11px] text-[#a8987e]" style={TNUM}>{ladder.date}</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-[#a8987e] transition-colors hover:bg-[#e0d5c0] hover:text-[#6b5b3e]"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {hasData ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* 梯队结构 */}
            <div className="flex items-stretch justify-between gap-2">
              {[
                { label: "一板", v: ladder.firstBoard, color: COLORS.red },
                { label: "二板", v: ladder.secondBoard, color: COLORS.orange },
                { label: "三板", v: ladder.thirdBoard, color: COLORS.beige },
                { label: "高度板", v: ladder.highBoard, color: COLORS.green },
              ].map((b) => (
                <div key={b.label} className="flex-1 rounded border border-[#e0d5c0] bg-[#f5f0e6]/50 py-2 text-center">
                  <div className="text-[26px] font-bold" style={{ color: b.color, fontVariantNumeric: "tabular-nums" }}>{b.v}</div>
                  <div className="text-[11px] text-[#a8987e]">{b.label}</div>
                </div>
              ))}
            </div>

            {/* 连板率 / 破板率 */}
            <div className="mt-2 flex items-center justify-around rounded border border-[#e0d5c0] bg-[#f5f0e6]/50 py-2">
              <div className="text-center">
                <div className="text-[18px] font-bold text-[#b8533a]" style={TNUM}>{ladder.ladderRate.toFixed(1)}%</div>
                <div className="text-[11px] text-[#a8987e]">连板率</div>
              </div>
              <div className="w-px self-stretch bg-[#e0d5c0]" />
              <div className="text-center">
                <div className="text-[18px] font-bold text-[#d4943a]" style={TNUM}>{ladder.brokenRate.toFixed(1)}%</div>
                <div className="text-[11px] text-[#a8987e]">今日涨停破板率</div>
              </div>
            </div>

            {/* 昨日梯队表现 */}
            <div className="mt-2 flex items-center justify-around rounded border border-[#e0d5c0] bg-[#f5f0e6]/50 py-2">
              {perfItems.map((p, i) => (
                <Fragment key={p.label}>
                  {i > 0 && <div className="w-px self-stretch bg-[#e0d5c0]" />}
                  <div className="text-center">
                    <div className={`text-[16px] font-bold ${clsChg(p.v)}`} style={TNUM}>{p.v >= 0 ? "+" : ""}{p.v.toFixed(2)}%</div>
                    <div className="text-[11px] text-[#a8987e]">{p.label}</div>
                  </div>
                </Fragment>
              ))}
            </div>

            {/* 市场评价 */}
            {ladder.comment && (
              <div className="mt-2 flex items-center gap-2 rounded border border-[#d4943a]/30 bg-[#d4943a]/10 px-3 py-1.5">
                <span className="text-[11px] text-[#b07a2a]">市场评价</span>
                <span className="text-[12px] font-medium text-[#6b5b3e]">{ladder.comment}</span>
              </div>
            )}

            {/* 趋势图 */}
            <div className="mt-3 border-t border-[#e0d5c0] pt-2">
              <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">近{ladder.trend.length || 0}日梯队趋势</div>
              <LadderTrendChart trend={ladder.trend} />
            </div>
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-[12px] text-[#a8987e]">暂无连板梯队数据</div>
        )}
      </div>
    </div>
  );
}

/* ========== 卡片5: 量能分析 (紧凑) ========== */
function VolumeCard({ turnover, prevTurnover, ratio, change, level }: { turnover: number; prevTurnover: number; ratio: number; change: number; level: string }) {
  const tagCls = change >= 20 ? "bg-[#b8533a]/15 text-[#b8533a]" : change >= 5 ? "bg-[#d4943a]/15 text-[#d4943a]" : change >= -5 ? "bg-[#a8987e]/15 text-[#a8987e]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="truncate text-[10px] font-semibold text-[#8b7a5e]">量能分析</span>
        <span className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-none ${tagCls}`}>{level}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        <div className="flex items-baseline gap-1">
          <span className="text-[15px] font-bold leading-none text-[#6b5b3e]" style={TNUM}>{fmtTurnover(turnover)}</span>
          <span className="text-[9px] leading-none text-[#a8987e]">流通</span>
        </div>
        <div className="mt-0.5 truncate text-[9px] leading-none text-[#a8987e]">
          前日{fmtTurnover(prevTurnover)} <span className={`font-medium ${clsChg(change)}`} style={TNUM}>{change >= 0 ? "+" : ""}{change.toFixed(1)}%</span>
        </div>
        <div className="mt-0.5 text-[9px] leading-none text-[#a8987e]">量比 <span className="font-medium text-[#6b5b3e]" style={TNUM}>{ratio.toFixed(2)}x</span></div>
      </div>
    </div>
  );
}

/* ========== 卡片6: 涨停表现 (紧凑) ========== */
function LimitPerfCard({ yestPerf, yestBroken, brokenUp }: { yestPerf: number; yestBroken: number; brokenUp: number }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      <div className="mb-0.5 truncate text-[10px] font-semibold text-[#8b7a5e]">涨停表现</div>
      <div className="flex min-h-0 flex-1 items-center justify-around gap-0.5">
        <div className="flex min-w-0 flex-col items-center">
          <div className={`text-[15px] font-bold leading-none ${clsChg(yestPerf)}`} style={TNUM}>{fmtPct(yestPerf)}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">昨涨停</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="flex min-w-0 flex-col items-center">
          <div className={`text-[15px] font-bold leading-none ${clsChg(yestBroken)}`} style={TNUM}>{fmtPct(yestBroken)}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">昨破板</div>
        </div>
        <div className="w-px self-stretch bg-[#e0d5c0]" />
        <div className="flex min-w-0 flex-col items-center">
          <div className="text-[15px] font-bold leading-none text-[#d4943a]" style={TNUM}>{brokenUp}</div>
          <div className="text-[9px] leading-tight text-[#a8987e]">破板数</div>
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
  // 数据源 trendData 最新在前(降序): 直接取最近 N 天, 再反转为升序供图表自左向右(旧→新)绘制
  const descending = [...data];
  // 最多查看半年内的交易日(以最新日期往前推6个月为截止线)
  const latestDate = new Date(descending[0].date);
  const cutoff = new Date(latestDate);
  cutoff.setMonth(cutoff.getMonth() - 6);
  const maxDays = descending.filter(d => new Date(d.date) >= cutoff).length;
  const [viewDays, setViewDays] = useState<number>(Math.min(7, maxDays, descending.length));
  const [daysInput, setDaysInput] = useState<string>(String(Math.min(7, maxDays, descending.length)));
  // 最近的 viewDays 天(降序), 反转为升序(旧→新)用于绘图
  const newestN = viewDays < descending.length ? descending.slice(0, viewDays) : descending;
  const reversed = [...newestN].reverse();
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
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-1.5 py-1">
      {/* 标题 + 图例 + 天数控制(单行紧凑) */}
      <div className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="truncate text-[10px] font-semibold text-[#8b7a5e]">涨停跌停趋势({reversed.length}天)</span>
        <span className="flex items-center gap-1 text-[9px] text-[#a8987e]"><span className="h-1.5 w-2 rounded-sm bg-[#b8533a]" />涨</span>
        <span className="flex items-center gap-1 text-[9px] text-[#a8987e]"><span className="h-1.5 w-2 rounded-sm bg-[#4a6b3f]" />跌</span>
        <span className="flex items-center gap-1 text-[9px] text-[#a8987e]"><span className="h-1.5 w-2 rounded-sm bg-[#d4943a]" />炸</span>
        <div className="ml-auto flex items-center gap-1 text-[9px] text-[#8b7a5e]">
          {[7, 15, 30].filter(n => n < maxDays).map(n => (
            <button key={n} onClick={() => { setViewDays(n); setDaysInput(String(n)); }}
              className={`rounded px-1 py-px leading-none transition-colors ${viewDays === n ? "bg-[#d4943a] text-white" : "bg-[#e0d5c0] hover:bg-[#d4c5a8]"}`}>
              {n}
            </button>
          ))}
          <button onClick={() => { setViewDays(maxDays); setDaysInput(String(maxDays)); }}
            className={`rounded px-1 py-px leading-none transition-colors ${viewDays === maxDays ? "bg-[#d4943a] text-white" : "bg-[#e0d5c0] hover:bg-[#d4c5a8]"}`}>
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
            onBlur={() => { if (daysInput === "") setDaysInput(String(viewDays)); }}
            className="w-9 rounded border border-[#d4c5a8] bg-[#f5f0e6] px-0.5 py-px text-center text-[9px] text-[#6b5b3e] outline-none focus:border-[#a8987e]" />
          <span>天</span>
        </div>
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

        {/* 日期标签 (HTML, 正常比例): 首尾标签右/左对齐避免超出容器被裁剪 */}
        {reversed.map((d, i) => {
          if (i % Math.max(1, Math.floor(reversed.length / 5)) !== 0 && i !== reversed.length - 1) return null;
          const dateStr = d.date?.slice(5) || "";
          const isFirst = i === 0;
          const isLast = i === reversed.length - 1;
          const left = isFirst
            ? px(pad.left)
            : isLast
              ? px(pad.left + i * stepX)
              : px(pad.left + i * stepX);
          const translate = isFirst ? "translate(0%, 0%)" : isLast ? "translate(-100%, 0%)" : "translate(-50%, 0%)";
          return (
            <span key={i} className="absolute whitespace-nowrap text-[8px] leading-none text-[#a8987e]" style={{ left, top: py(h - 3), transform: translate }}>
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
        className="scroll-sentinel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
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
              const { mood, sentiment: si, ladder: ladderData, riseFall } = effective;
              return (
                <>
                  {/* 单行布局: 6 个小卡片 + 涨停跌停趋势图, 全部同一行且占满可用高度 */}
                  <div className="flex min-h-0 flex-1 items-stretch gap-2">
                    <SentimentScoreCard score={si.sentimentScore} level={si.sentimentLevel} desc={si.sentimentDesc} />
                    <UpDownCard upCount={mood.upCount} downCount={mood.downCount} upRatio={mood.upRatio} downRatio={mood.downRatio} total={mood.totalCount} />
                    <LimitUpDownCard limitUp={mood.limitUp} limitDown={mood.limitDown} blownUp={riseFall.blownLimitUpCount} blownRate={riseFall.blownLimitUpRate} />
                    <LadderCard ladder={ladderData} />
                    <VolumeCard turnover={mood.turnover} prevTurnover={mood.prevTurnover} ratio={mood.ratio} change={mood.turnoverChange} level={mood.volLevel} />
                    <LimitPerfCard yestPerf={riseFall.yesterdayLimitUpPerf} yestBroken={riseFall.yesterdayBrokenPerf} brokenUp={riseFall.brokenLimitUpCount} />
                    {riseFall.trendData.length >= 2 && (
                      <div className="flex min-w-0 flex-[1.4]">
                        <TrendChart data={riseFall.trendData} />
                      </div>
                    )}
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