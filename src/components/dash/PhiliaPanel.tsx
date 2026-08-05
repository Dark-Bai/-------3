import { Panel, type PanelZoomProps } from "./Panel";
import {
  Sparkles,
  Loader2,
  ChevronRight,
  RefreshCw,
  TrendingUp,
  AlertTriangle,
  Target,
  Gauge,
} from "lucide-react";
import { usePhilia } from "./PhiliaContext";
import { PhiliaVisualization } from "./PhiliaVisualization";
import { LeaderPoolChip } from "./LeaderPoolChip";
import type { PhiliaAnalysis, PhiliaDataSource, PhiliaOpportunity, PhiliaRisk, PhiliaStock } from "@/lib/api";
import { useState } from "react";

/** 权重 → 百分比字符串 */
const pct = (w?: number) => `${Math.round((w || 0) * 100)}%`;

/** 风险等级配色 */
const RISK_COLOR: Record<string, string> = { 高: "#b8533a", 中: "#d4943a", 低: "#4a6b3f" };

/** 情绪评分 → 配色 */
const scoreColor = (s: number) => (s >= 70 ? "#4a6b3f" : s >= 40 ? "#d4943a" : "#b8533a");

function OpportunityItem({ o }: { o: PhiliaOpportunity }) {
  return (
    <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[10px] font-bold text-[#6b5b3e]">
          {o.type} · {o.sector}
        </span>
        <span className="shrink-0 text-[10px] font-bold text-[#b8533a]">{pct(o.weight)}</span>
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-[#8b7a5e]">{o.analysis}</p>
      <p className="mt-0.5 text-[10px] text-[#4a6b3f]">预期收益：{o.expectedReturn}</p>
    </div>
  );
}

function RiskItem({ r }: { r: PhiliaRisk }) {
  const color = RISK_COLOR[r.level] || "#d4943a";
  return (
    <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1">
          <span
            className="shrink-0 rounded px-1 py-px text-[9px] font-bold text-white"
            style={{ backgroundColor: color }}
          >
            {r.level}
          </span>
          <span className="truncate text-[10px] font-bold text-[#6b5b3e]">{r.scope}</span>
        </span>
        <span className="shrink-0 text-[10px] font-bold text-[#b8533a]">{pct(r.weight)}</span>
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-[#8b7a5e]">{r.description}</p>
      <p className="mt-0.5 text-[10px] text-[#4a6b3f]">应对：{r.mitigation}</p>
    </div>
  );
}

function StockItem({ s }: { s: PhiliaStock }) {
  return (
    <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[10px] font-bold text-[#6b5b3e]">
          {s.name} <span className="font-normal text-[#a8987e]">{s.code}</span>
        </span>
        <span className="shrink-0 text-[10px] font-bold text-[#d4943a]">{pct(s.weight)}</span>
      </div>
      <p className="mt-0.5 text-[10px] leading-snug text-[#8b7a5e]">{s.reason}</p>
      {s.target && <p className="mt-0.5 text-[10px] text-[#4a6b3f]">目标：{s.target}</p>}
    </div>
  );
}

/** 结果区列表单元(带标题头) */
function ResultColumn({
  icon,
  title,
  color,
  meta,
  sources,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
  meta?: string;
  sources?: PhiliaDataSource[];
  children: React.ReactNode;
}) {
  const [showSrc, setShowSrc] = useState(false);
  return (
    <div className="flex min-h-0 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
      <div className="mb-1 flex items-center gap-1 border-b border-[#e0d5c0]/60 pb-1" style={{ color }}>
        {icon}
        <span className="truncate text-[11px] font-bold font-newspaper-heading">{title}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {meta && (
            <span className="rounded bg-[#ede4d4] px-1 py-px text-[8px] leading-none text-[#a8987e]" title={meta}>
              {meta}
            </span>
          )}
          {sources && sources.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSrc((v) => !v)}
              title="查看数据来源与获取时间"
              className="flex items-center gap-0.5 rounded border border-[#c9b99a]/60 bg-[#faf6ee] px-1 py-px text-[8px] leading-none text-[#8b7a5e] transition-colors hover:border-[#d4943a]/60 hover:text-[#6b5b3e]"
            >
              数据源
              <span className="text-[7px]">{showSrc ? "▲" : "▼"}</span>
            </button>
          )}
        </div>
      </div>
      {showSrc && sources && sources.length > 0 && (
        <div className="mb-1 rounded border border-[#d8cbb4] bg-[#faf6ee] px-1.5 py-1 text-[8px] text-[#8b7a5e]">
          {sources.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 py-px">
              <span className="truncate">{s.name}</span>
              <span className="shrink-0 tabular-nums text-[#a8987e]">{s.fetchedAt}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** 分析结果展示(M3) */
function AnalysisResult({ analysis }: { analysis: PhiliaAnalysis }) {
  const { sentiment, opportunities, risks, stocks, sources } = analysis.result;
  const aiMeta = `DeepSeek AI · ${analysis.date?.slice(5) || "—"}`;
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      {/* 评分卡 */}
      <div className="flex items-center gap-3 rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2">
        <div
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 text-[15px] font-bold"
          style={{ borderColor: scoreColor(sentiment.score), color: scoreColor(sentiment.score) }}
        >
          <Gauge size={30} className="absolute opacity-20" style={{ color: scoreColor(sentiment.score) }} />
          {sentiment.score}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-[#6b5b3e]">市场情绪</span>
            <span
              className="rounded px-1.5 py-px text-[9px] font-bold text-white"
              style={{ backgroundColor: scoreColor(sentiment.score) }}
            >
              {sentiment.level}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-[#8b7a5e]">{sentiment.comment}</p>
        </div>
      </div>

      {/* 三列列表: 机会 / 风险 / 核心标的 */}
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-1.5">
        <ResultColumn icon={<TrendingUp size={12} />} title="机会" color="#b8533a" meta={aiMeta} sources={sources}>
          {(opportunities || []).map((o, i) => (
            <OpportunityItem key={i} o={o} />
          ))}
        </ResultColumn>
        <ResultColumn icon={<AlertTriangle size={12} />} title="风险" color="#d4943a" meta={aiMeta} sources={sources}>
          {(risks || []).map((r, i) => (
            <RiskItem key={i} r={r} />
          ))}
        </ResultColumn>
        <ResultColumn icon={<Target size={12} />} title="核心标的" color="#4a6b3f" meta={aiMeta} sources={sources}>
          {(stocks || []).map((s, i) => (
            <StockItem key={i} s={s} />
          ))}
        </ResultColumn>
      </div>
    </div>
  );
}

/** 导出分析结果为 JSON 文件 */
function exportAnalysis(analysis: PhiliaAnalysis) {
  const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `philia-分析-${analysis.date || new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 界面中央大型整体模块: 由"上部空白模块" + "原 philia 模块"纵向合并而成。
 *  跨两行(rowSpan=2)占据原「商品·美债」区域与 philia 区域, 形成统一大块。
 *  标题栏复用 Panel 组件; 有分析结果时上方 3/4 渲染结果区, 下方 1/4 渲染可视化区(M4) */
export function PhiliaPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const { config, configLoaded, analyzing, analysis, analysisError, openModal, runAnalysis } = usePhilia();

  /** 强制刷新: 复用最近一次使用的 model 与技能 */
  const refresh = () => {
    const m = config?.model || analysis?.model || "";
    const sk = config?.skills?.length ? config.skills : [];
    if (m && sk.length) runAnalysis(m, sk, true);
    else openModal();
  };

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="PHILIA"
      icon="◈"
      accent="#d4943a"
      right={
        <div className="ml-auto flex items-center gap-1.5">
          <LeaderPoolChip />
          {analysis && (
            <>
              <button
                onClick={() => exportAnalysis(analysis)}
                className="flex items-center gap-1 rounded border border-[#4a6b3f]/40 px-1.5 py-0.5 text-[9px] text-[#8b7a5e] transition-colors hover:border-[#4a6b3f]/80 hover:text-[#6b5b3e]"
                title="导出本次分析结果为 JSON"
              >
                导出
              </button>
              <button
                onClick={refresh}
                disabled={analyzing}
                className="flex items-center gap-1 rounded border border-[#d4943a]/40 px-1.5 py-0.5 text-[9px] text-[#8b7a5e] transition-colors hover:border-[#d4943a]/80 hover:text-[#6b5b3e] disabled:opacity-50"
              >
                <RefreshCw size={10} className={analyzing ? "animate-spin" : ""} />
                重新分析
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="flex h-full flex-col">
        {analysis ? (
          <>
            {/* 结果区(约 3/4): AI 分析期间保持可交互, 不阻塞数据查看 */}
            <div className="min-h-0 flex-1">
              <AnalysisResult analysis={analysis} />
            </div>
            {/* 可视化区(约 1/4, M4 落地) */}
            <div className="h-[26%] min-h-0 border-t border-[#e0d5c0]">
              <PhiliaVisualization result={analysis.result} date={analysis.date} />
            </div>
          </>
        ) : (
          /* 未分析: 启动入口 + 配置提示 */
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 pb-6">
            <button
              onClick={openModal}
              disabled={analyzing}
              className="group flex flex-col items-center gap-2 rounded border border-[#d4943a]/50 bg-gradient-to-b from-[#faf6ee] to-[#ede4d4] px-10 py-6 shadow-newspaper transition-all hover:border-[#d4943a]/80 hover:shadow-newspaper-lg disabled:opacity-60"
            >
              {analyzing ? (
                <Loader2 size={30} className="animate-spin text-[#d4943a]" />
              ) : (
                <Sparkles size={30} className="text-[#d4943a] transition-transform group-hover:scale-110" />
              )}
              <span className="text-[16px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">
                {analyzing ? "AI 分析中…" : "启动 AI 综合分析"}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-[#a8987e]">
                游资视角 · 市场情绪 / 机会 / 风险 / 核心标的
                <ChevronRight size={12} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </button>

            <div className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  config?.hasKey ? "bg-[#4a6b3f]" : configLoaded ? "bg-[#d4943a]" : "bg-[#a8987e]"
                }`}
              />
              <span className="text-[#8b7a5e]">
                {config?.hasKey
                  ? "已配置 API Key，点击开始分析"
                  : configLoaded
                    ? "未配置 API Key，点击进行配置"
                    : "正在读取配置…"}
              </span>
            </div>

            {analysisError && (
              <p className="max-w-[90%] text-center text-[10px] text-[#b8533a]">{analysisError}</p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}