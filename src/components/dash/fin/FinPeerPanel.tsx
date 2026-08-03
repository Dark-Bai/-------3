import { useMemo, useState } from "react";
import { Panel, type PanelZoomProps } from "../Panel";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";
import { useFin } from "./FinContext";
import { SkeletonRows } from "./SkeletonRows";
import { TNUM, fmtYi } from "./utils";

type Mode = "table" | "radar";

/** 数值比较条: 公司值 vs 行业均值, 相对宽度指示 */
function CmpBar({ val, avg }: { val: number; avg: number }) {
  const max = Math.max(val, avg, 1);
  const vw = Math.max((val / max) * 100, 2);
  const aw = Math.max((avg / max) * 100, 2);
  const vCls = val >= avg ? "bg-[#b8533a]/70" : "bg-[#4a6b3f]/70";
  return (
    <div className="flex h-[3px] w-full gap-[1px]">
      <div className={vCls} style={{ width: `${vw}%`, transition: "width 0.3s" }} />
      <div className="h-full flex-1 rounded-r bg-[#a8987e]/40" style={{ width: `${aw}%` }}>
        <div className="h-full w-full rounded-r bg-[#d4943a]/20" />
      </div>
    </div>
  );
}

const pctCls = (v: number) => (v > 0 ? "text-[#b8533a]" : v < 0 ? "text-[#4a6b3f]" : "text-[#8b7a5e]");

/** 同行对比: 表格(公司指标 vs 行业均值/排名) + 雷达图 */
export function FinPeerPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [mode, setMode] = useState<Mode>("table");
  const [retry, setRetry] = useState(0);
  const { company, period } = useFin();

  const {
    data: board,
    error: boardErr,
    loading: boardLoading,
  } = usePolling(() => api.financeBoard(period), 1800000, [retry, period]);

  const {
    data: finData,
    error: finErr,
    loading: finLoading,
  } = usePolling(() => api.financeMain(company.code), 1800000, [company.code, retry]);

  const loading = boardLoading || finLoading;
  const error = boardErr || finErr;

  // 在 board 中匹配公司（尝试多种代码格式）
  const peerData = useMemo(() => {
    if (!board?.stocks?.length || !finData?.reports?.[0]) return null;
    const bare = company.code.replace(/^(sh|sz|bj)/, "");
    const companyInBoard = board.stocks.find(
      (s) => s.code === bare || s.code === company.code || s.code === `${bare}.${company.code.startsWith("sh") ? "SH" : company.code.startsWith("sz") ? "SZ" : "BJ"}`
    );
    if (!companyInBoard) return { industry: null, comparisons: null, count: 0 };

    const industry = companyInBoard.industry;
    const peers = board.stocks.filter((s) => s.industry === industry);
    const count = peers.length;
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / count;
    const rank = (arr: number[], val: number) => arr.filter((v) => v > val).length + 1;

    const peerNp = peers.map((s) => s.netProfit);
    const peerRoe = peers.map((s) => s.roe);
    const peerEps = peers.map((s) => s.eps);
    const peerPy = peers.map((s) => s.profitYoY);
    const peerRy = peers.map((s) => s.revenueYoY);

    const r0 = finData.reports[0];
    const cmpNp = companyInBoard.netProfit;
    const cmpRoe = companyInBoard.roe;
    const cmpEps = companyInBoard.eps;
    const cmpPy = companyInBoard.profitYoY;
    const cmpRy = companyInBoard.revenueYoY;

    const comparisons = [
      {
        label: "净利",
        companyVal: fmtYi(r0.netProfit),
        peerVal: fmtYi(avg(peerNp)),
        rank: `${rank(peerNp, cmpNp)}/${count}`,
        barVal: cmpNp,
        barAvg: avg(peerNp),
      },
      {
        label: "净利增速",
        companyVal: `${cmpPy > 0 ? "+" : ""}${cmpPy.toFixed(1)}%`,
        peerVal: `${avg(peerPy) > 0 ? "+" : ""}${avg(peerPy).toFixed(1)}%`,
        rank: `${rank(peerPy, cmpPy)}/${count}`,
        barVal: cmpPy,
        barAvg: avg(peerPy),
        colorCls: pctCls(cmpPy),
      },
      {
        label: "营收增速",
        companyVal: `${cmpRy > 0 ? "+" : ""}${cmpRy.toFixed(1)}%`,
        peerVal: `${avg(peerRy) > 0 ? "+" : ""}${avg(peerRy).toFixed(1)}%`,
        rank: `${rank(peerRy, cmpRy)}/${count}`,
        barVal: cmpRy,
        barAvg: avg(peerRy),
        colorCls: pctCls(cmpRy),
      },
      {
        label: "ROE",
        companyVal: `${cmpRoe.toFixed(1)}%`,
        peerVal: `${avg(peerRoe).toFixed(1)}%`,
        rank: `${rank(peerRoe, cmpRoe)}/${count}`,
        barVal: cmpRoe,
        barAvg: avg(peerRoe),
      },
      {
        label: "EPS",
        companyVal: cmpEps.toFixed(2),
        peerVal: avg(peerEps).toFixed(2),
        rank: `${rank(peerEps, cmpEps)}/${count}`,
        barVal: cmpEps,
        barAvg: avg(peerEps),
      },
    ];

    return { industry, comparisons, count };
  }, [board, finData, company.code]);

  // 雷达图数据: 归一化到 0-1, 公司 vs 行业均值
  const radarData = useMemo(() => {
    if (!peerData?.comparisons) return null;
    const axes = peerData.comparisons.map((c) => {
      const max = Math.max(Math.abs(c.barVal), Math.abs(c.barAvg), 1);
      return {
        label: c.label,
        company: Math.max(c.barVal / max, 0.02),
        peer: Math.max(c.barAvg / max, 0.02),
      };
    });
    return axes;
  }, [peerData]);

  const hasPeer = peerData && peerData.industry;

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="同业对比"
      icon="≋"
      accent="#d4943a"
      right={
        <div className="flex items-center gap-2 text-[10px]">
          {(["table", "radar"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex h-[22px] items-center rounded px-2 ${
                mode === m ? "bg-[#d4943a]/20 text-[#d4943a]" : "text-[#8b7a5e] hover:text-[#6b5b3e]"
              }`}
            >
              {m === "table" ? "表格" : "雷达"}
            </button>
          ))}
        </div>
      }
    >
      {!company.code ? (
        <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">
          ← 从榜单选入公司
        </div>
      ) : !board || !finData ? (
        loading ? (
          <SkeletonRows rows={8} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px]">
            <button className="h-full w-full text-[#a8987e]" onClick={() => setRetry((r) => r + 1)}>
              数据获取失败，点击重试{error ? `(${error})` : ""}
            </button>
          </div>
        )
      ) : !hasPeer ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-[11px] text-[#a8987e]">
          <span>该公司未出现在当期行业榜单中</span>
          <span className="text-[9px] text-[#c8b89a]">可能在统计样本外或代码不一致</span>
        </div>
      ) : mode === "table" ? (
        <div className="flex h-full min-h-0 flex-col">
          {/* 行业头部 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[#e0d5c0] px-2 py-1">
            <span className="text-[11px] font-semibold text-[#d4943a]">{peerData.industry}</span>
            <span className="text-[9px] text-[#a8987e]">
              共 {peerData.count} 家 · 排名第
            </span>
          </div>
          {/* 表头 */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[#e0d5c0] px-2 py-0.5 text-[8.5px] text-[#a8987e]">
            <span className="w-[48px] shrink-0">指标</span>
            <span className="min-w-0 flex-1 text-right">{finData.name.length > 6 ? finData.name.slice(0, 6) : finData.name}</span>
            <span className="w-[52px] shrink-0 text-right">行业均值</span>
            <span className="w-[36px] shrink-0 text-right">排名</span>
          </div>
          {/* 行 */}
          <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
            {peerData.comparisons!.map((c, i) => (
              <div key={c.label} className="flex flex-col border-b border-[#e0d5c0] px-2 py-1 hover:bg-[#ede4d4]">
                <div className="flex items-center gap-2">
                  <span className="w-[48px] shrink-0 text-[10px] text-[#8b7a5e]">{c.label}</span>
                  <span className={`min-w-0 flex-1 text-right text-[11px] font-semibold ${c.colorCls ?? "text-[#6b5b3e]"}`} style={TNUM}>
                    {c.companyVal}
                  </span>
                  <span className="w-[52px] shrink-0 text-right text-[10px] text-[#a8987e]" style={TNUM}>
                    {c.peerVal}
                  </span>
                  <span className="w-[36px] shrink-0 text-right text-[9px] text-[#8b7a5e]" style={TNUM}>
                    {c.rank}
                  </span>
                </div>
                {/* 比较底条 */}
                {i < peerData.comparisons!.length - 1 && (
                  <div className="mt-0.5 px-0">
                    <CmpBar val={Math.abs(c.barVal)} avg={Math.abs(c.barAvg)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : radarData ? (
        <RadarChart axes={radarData} companyName={finData.name} />
      ) : null}
    </Panel>
  );
}

/** 简易雷达图: SVG 多边形 + 轴标签 */
function RadarChart({ axes, companyName }: { axes: { label: string; company: number; peer: number }[]; companyName: string }) {
  const n = axes.length;
  if (n < 3) return <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">需要至少 3 项指标</div>;

  const CX = 150;
  const CY = 120;
  const R = 80;
  const levels = 5;

  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pt = (i: number, r: number) => ({
    x: CX + r * Math.cos(angle(i)),
    y: CY + r * Math.sin(angle(i)),
  });

  // 背景网格
  const grids = Array.from({ length: levels }, (_, li) => {
    const r = ((li + 1) / levels) * R;
    return axes.map((_, i) => pt(i, r));
  });

  // 公司多边形
  const companyPts = axes.map((a, i) => pt(i, a.company * R));
  const peerPts = axes.map((a, i) => pt(i, a.peer * R));

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center">
      <svg width="300" height="260" className="shrink-0">
        {/* 径向网格 */}
        {grids.map((ring, li) => (
          <polygon
            key={li}
            points={ring.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="#c8b89a"
            strokeWidth={1}
          />
        ))}
        {/* 轴 */}
        {axes.map((_, i) => {
          const outer = pt(i, R);
          return <line key={i} x1={CX} y1={CY} x2={outer.x} y2={outer.y} stroke="#c8b89a" strokeWidth={1} />;
        })}
        {/* 行业均值 */}
        <polygon
          points={peerPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
          fill="#d4943a"
          fillOpacity={0.08}
          stroke="#d4943a"
          strokeWidth={1}
          strokeDasharray="3 2"
        />
        {/* 公司值 */}
        <polygon
          points={companyPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
          fill="#d4943a"
          fillOpacity={0.15}
          stroke="#d4943a"
          strokeWidth={1.5}
        />
        {/* 轴标签 */}
        {axes.map((a, i) => {
          const outer = pt(i, R + 16);
          return (
            <text
              key={i}
              x={outer.x}
              y={outer.y + 3}
              fontSize={9}
              fill="#8b7a5e"
              textAnchor="middle"
              style={TNUM}
            >
              {a.label}
            </text>
          );
        })}
      </svg>
      {/* 图例 */}
      <div className="flex items-center gap-4 text-[9px]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#d4943a]/40" />
          <span className="text-[#8b7a5e]">
            {companyName.length > 6 ? companyName.slice(0, 6) : companyName}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm border border-[#d4943a]/50 bg-[#d4943a]/10" />
          <span className="text-[#a8987e]">行业均值</span>
        </span>
      </div>
    </div>
  );
}
