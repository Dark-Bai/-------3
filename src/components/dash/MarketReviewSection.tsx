/**
 * 龙头情绪复盘(4 模块): 今日龙头核心 / 今日情绪周期 / 今日机会 / 今日风险
 *
 * 由一个「启动 AI 综合分析」按钮触发, 调用后端 /api/philia/market-analyze(LLM),
 * 一次性返回 4 个结构化模块, 前端分卡片清晰展示。
 * 交互: 启动按钮 + 加载状态提示 + 结果展示区 + 重新分析(force)。
 */
import { useState } from "react";
import {
  Sparkles,
  Loader2,
  RefreshCw,
  Crown,
  Gauge,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import { api, type PhiliaMarketAnalysis, type PhiliaDataSource } from "@/lib/api";
import { usePhilia } from "./PhiliaContext";
import { ThinkingProcessButton } from "./ThinkingProcessButton";

/** 情绪阶段 → 配色 */
const STAGE_META: Record<string, { color: string; bg: string }> = {
  冰点: { color: "#a8987e", bg: "rgba(168,152,126,0.15)" },
  回暖: { color: "#4a6b3f", bg: "rgba(74,107,63,0.15)" },
  高潮: { color: "#d4943a", bg: "rgba(212,148,58,0.15)" },
  退潮: { color: "#b8533a", bg: "rgba(184,83,58,0.15)" },
};
const stageMeta = (s: string) => {
  const key = (Object.keys(STAGE_META) as (keyof typeof STAGE_META)[]).find((k) => (s || "").includes(k));
  return STAGE_META[key || "回暖"] || STAGE_META["回暖"];
};

/** 风险等级配色 */
const RISK_COLOR: Record<string, string> = { 高: "#b8533a", 中: "#d4943a", 低: "#4a6b3f" };

/** 时间戳 → HH:MM */
const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function MarketReviewSection() {
  const { config } = usePhilia();
  const [analysis, setAnalysis] = useState<PhiliaMarketAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showSrc, setShowSrc] = useState(false);

  const run = async (force = false) => {
    setLoading(true);
    setError("");
    try {
      const d = await api.philia.marketAnalyze({ skills: config?.skills || [], force });
      setAnalysis(d);
    } catch (e) {
      setError((e as Error)?.message || "分析失败");
    } finally {
      setLoading(false);
    }
  };

  const r = analysis?.result;
  const sources: PhiliaDataSource[] = r?.sources || [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      {/* 顶部操作区: 启动按钮 + 状态 + 重新分析 */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-[#d4943a]/40 bg-gradient-to-b from-[#faf6ee] to-[#ede4d4] px-3 py-1.5">
        <button
          type="button"
          onClick={() => run(false)}
          disabled={loading}
          title="启动 AI 综合分析: 一次性生成今日龙头核心/情绪周期/机会/风险"
          className="group flex items-center gap-1.5 rounded border border-[#d4943a]/60 bg-[#4a6b3f] px-2.5 py-1 text-[10px] font-bold text-[#faf6ee] transition-colors hover:bg-[#3d5940] disabled:opacity-60"
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} className="transition-transform group-hover:scale-110" />
          )}
          启动 AI 综合分析
        </button>
        {analysis && (
          <button
            type="button"
            onClick={() => run(true)}
            disabled={loading}
            title="强制重新分析(绕过缓存)"
            className="flex items-center gap-1 rounded border border-[#d4943a]/40 px-1.5 py-0.5 text-[9px] text-[#8b7a5e] transition-colors hover:border-[#d4943a]/80 hover:text-[#6b5b3e] disabled:opacity-50"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
            重新分析
          </button>
        )}
        {analysis && (
          <ThinkingProcessButton
            trace={analysis.trace || []}
            model={analysis.model}
            date={analysis.date}
            fromCache={analysis.fromCache}
          />
        )}
        <span className={`ml-auto text-[9px] ${loading ? "text-[#d4943a]" : "text-[#a8987e]"}`}>
          {loading ? "AI 分析中, 请稍候…" : analysis ? `更新于 ${fmtTime(analysis.updatedAt)}` : "龙头情绪复盘 · DeepSeek AI"}
        </span>
      </div>

      {error && (
        <p className="rounded border border-[#b8533a]/40 bg-[#b8533a]/8 px-2 py-1 text-[9px] text-[#b8533a]">{error}</p>
      )}

      {!analysis && !loading && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded border border-dashed border-[#d8cbb4] bg-gradient-to-b from-[#faf6ee]/70 to-[#f5f0e6]/30 px-6 py-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#d4943a]/10">
            <Gauge size={30} className="text-[#d4943a]/70" />
          </div>
          <p className="text-[12px] font-bold text-[#6b5b3e]">做好复盘准备，点击「启动 AI 综合分析」</p>
          <p className="max-w-md text-[9px] leading-relaxed text-[#a8987e]">
            由 AI 基于上游市场数据白皮书，一次性生成以下四项核心分析：
          </p>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {["今日龙头核心", "今日情绪周期", "今日机会", "今日风险"].map((m) => (
              <span
                key={m}
                className="rounded border border-[#e0d5c0] bg-[#faf6ee] px-2 py-0.5 text-[8px] font-semibold text-[#8b7a5e]"
              >
                ◈ {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {analysis && r && (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {/* 今日龙头核心 */}
          <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
            <div className="mb-1 flex items-center gap-1 border-b border-[#c9b99a]/50 pb-1" style={{ color: "#4a6b3f" }}>
              <Crown size={12} />
              <span className="text-[11px] font-bold font-newspaper-heading">今日龙头核心</span>
              <button
                type="button"
                onClick={() => setShowSrc((v) => !v)}
                className="ml-auto flex items-center gap-0.5 rounded border border-[#c9b99a]/60 bg-[#faf6ee] px-1 py-px text-[8px] leading-none text-[#8b7a5e]"
              >
                数据源 {sources.length ? `(${sources.length})` : ""}
                <span className="text-[7px]">{showSrc ? "▲" : "▼"}</span>
              </button>
            </div>
            {showSrc && sources.length > 0 && (
              <div className="mb-1 rounded border border-[#d8cbb4] bg-[#faf6ee] px-1.5 py-1 text-[8px] text-[#8b7a5e]">
                {sources.map((s) => (
                  <div key={s.name} className="flex items-center justify-between gap-2 py-px">
                    <span className="truncate">{s.name}</span>
                    <span className="shrink-0 tabular-nums text-[#a8987e]">{s.fetchedAt}</span>
                  </div>
                ))}
              </div>
            )}
            {r.leaderCore.title && (
              <p className="mb-1 text-[10px] font-bold text-[#6b5b3e]">总龙头：{r.leaderCore.title}</p>
            )}
            {r.leaderCore.summary && (
              <p className="mb-1 text-[9px] leading-snug text-[#8b7a5e]">{r.leaderCore.summary}</p>
            )}
            <div className="flex flex-col gap-1">
              {(r.leaderCore.leaders || []).map((l, i) => (
                <div key={i} className="flex items-center gap-1.5 rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-1.5 py-1">
                  <span className="shrink-0 rounded bg-[#4a6b3f]/15 px-1 py-px text-[9px] font-bold tabular-nums text-[#4a6b3f]">
                    {l.ladder}板
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] font-bold text-[#6b5b3e]">
                      {l.name} <span className="font-normal text-[#a8987e]">{l.code}</span>
                    </span>
                    <span className="block truncate text-[8px] text-[#a8987e]">
                      {l.board} · {l.seal}
                    </span>
                  </span>
                  {l.note && <span className="max-w-[45%] shrink-0 truncate text-[8px] text-[#d4943a]">{l.note}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* 今日情绪周期 */}
          <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
            <div className="mb-1 flex items-center gap-1 border-b border-[#c9b99a]/50 pb-1" style={{ color: "#d4943a" }}>
              <Gauge size={12} />
              <span className="text-[11px] font-bold font-newspaper-heading">今日情绪周期</span>
              <span
                className="ml-auto rounded px-1.5 py-px text-[9px] font-bold text-white"
                style={{ backgroundColor: stageMeta(r.sentimentCycle.stage).color }}
              >
                {r.sentimentCycle.stage || "未知"}
              </span>
            </div>
            {r.sentimentCycle.indicators && (
              <p className="mb-0.5 text-[9px] font-semibold text-[#8b7a5e]">{r.sentimentCycle.indicators}</p>
            )}
            {r.sentimentCycle.analysis && (
              <p className="text-[9px] leading-snug text-[#6b5b3e]">{r.sentimentCycle.analysis}</p>
            )}
          </div>

          {/* 今日机会 / 今日风险 两列(窄屏堆叠为单列) */}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-1.5 lg:grid-cols-2">
            <div className="flex min-h-0 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
              <div className="mb-1 flex items-center gap-1 border-b border-[#c9b99a]/50 pb-1" style={{ color: "#b8533a" }}>
                <TrendingUp size={12} />
                <span className="text-[11px] font-bold font-newspaper-heading">今日机会</span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {(r.opportunities || []).map((o, i) => (
                  <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      <span className="truncate text-[9px] font-bold text-[#6b5b3e]">
                        {o.type} · {o.sector}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[8px] leading-snug text-[#8b7a5e]">{o.analysis}</p>
                    {o.opportunity && <p className="mt-0.5 text-[8px] text-[#4a6b3f]">机会点：{o.opportunity}</p>}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex min-h-0 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
              <div className="mb-1 flex items-center gap-1 border-b border-[#c9b99a]/50 pb-1" style={{ color: "#b8533a" }}>
                <AlertTriangle size={12} />
                <span className="text-[11px] font-bold font-newspaper-heading">今日风险</span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {(r.risks || []).map((rk, i) => (
                  <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      <span
                        className="shrink-0 rounded px-1 py-px text-[8px] font-bold text-white"
                        style={{ backgroundColor: RISK_COLOR[rk.level] || "#d4943a" }}
                      >
                        {rk.level}
                      </span>
                      <span className="truncate text-[9px] font-bold text-[#6b5b3e]">{rk.scope || "风险"}</span>
                    </div>
                    <p className="mt-0.5 text-[8px] leading-snug text-[#8b7a5e]">{rk.description}</p>
                    {rk.mitigation && <p className="mt-0.5 text-[8px] text-[#4a6b3f]">应对：{rk.mitigation}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}