import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolling } from "@/hooks/usePolling";
import { api, type PluginNewsAnalystData, type PluginMarketSentimentData } from "@/lib/api";
import { clsChg } from "@/lib/format";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/* ========== 加载/错误共用 ========== */
function Loading() {
  return <div className="flex h-full items-center justify-center text-[15px] text-[#a8987e]">加载中…</div>;
}
function Failed({ msg = "数据加载失败" }: { msg?: string }) {
  return <div className="flex h-full items-center justify-center text-[15px] text-[#a8987e]">{msg}</div>;
}

/* ========== 情绪卡片: 恐慌贪婪指数(圆形仪表) ========== */
function FearGreedGauge({ score, level, interpretation }: { score: string; level: string; interpretation: string }) {
  const s = parseFloat(score);
  const color = s >= 75 ? "#b8533a" : s >= 60 ? "#d4943a" : s >= 40 ? "#a8987e" : s >= 25 ? "#4a6b3f" : "#4a6b3f";
  const bg = s >= 75 ? "bg-[#b8533a]/15 text-[#b8533a]" : s >= 60 ? "bg-[#d4943a]/15 text-[#d4943a]" : s >= 40 ? "bg-[#a8987e]/15 text-[#a8987e]" : s >= 25 ? "bg-[#4a6b3f]/15 text-[#4a6b3f]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">恐慌贪婪指数</div>
      <div className="flex items-center gap-3">
        <div className="relative flex h-18 w-18 shrink-0 items-center justify-center rounded-full border-2 border-[#e0d5c0]">
          <div className="text-center">
            <div className="text-[20px] font-bold leading-none" style={{ color, ...TNUM }}>{parseFloat(score).toFixed(0)}</div>
            <div className="text-[11px] text-[#a8987e]">/100</div>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${bg}`}>{level}</span>
          <div className="mt-1 text-[12px] leading-relaxed text-[#8b7a5e]">{interpretation}</div>
        </div>
      </div>
    </div>
  );
}

/* ========== 情绪卡片: 新闻情绪指数(进度条) ========== */
function SentimentBar({ index, cls, pos, neg }: { index: number; cls: string; pos: number; neg: number }) {
  const barColor = index >= 60 ? "#b8533a" : index >= 40 ? "#d4943a" : "#4a6b3f";
  const tagCls = index >= 60 ? "bg-[#b8533a]/15 text-[#b8533a]" : index >= 40 ? "bg-[#d4943a]/15 text-[#d4943a]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#8b7a5e]">新闻情绪指数</span>
        <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${tagCls}`}>{cls}</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[20px] font-bold leading-none text-[#6b5b3e]" style={TNUM}>{index}</span>
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-[#e0d5c0]">
          <div className="h-full rounded-full transition-all" style={{ width: `${index}%`, background: barColor }} />
        </div>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-[#a8987e]">
        <span className="flex items-center gap-0.5"><span className="h-2.5 w-2 rounded-full bg-[#b8533a]" />积极 {pos}</span>
        <span className="flex items-center gap-0.5"><span className="h-2.5 w-2 rounded-full bg-[#4a6b3f]" />消极 {neg}</span>
      </div>
    </div>
  );
}

/* ========== 情绪卡片: 大盘市场情绪 ========== */
function MarketIndexCard({ idx }: { idx: PluginMarketSentimentData["marketIndex"] }) {
  if (!idx) return null;
  const upRatio = idx.totalCount > 0 ? (idx.upCount / idx.totalCount * 100).toFixed(0) : "0";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">大盘市场情绪</div>
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-[#6b5b3e]">{idx.indexName}</span>
        <span className={`text-[15px] font-bold ${clsChg(idx.changePercent)}`} style={TNUM}>
          {idx.changePercent >= 0 ? "+" : ""}{idx.changePercent}%
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex flex-1 overflow-hidden rounded-full bg-[#e0d5c0] text-[0]">
          <div className="h-4 rounded-l-full bg-[#b8533a] leading-none" style={{ width: `${upRatio}%` }} />
          <div className="h-4 bg-[#4a6b3f] leading-none" style={{ flex: 1 }} />
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[12px] text-[#a8987e]">
        <span>涨 {idx.upCount}</span>
        <span>跌 {idx.downCount}</span>
      </div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-[#8b7a5e]">{idx.sentimentInterpretation}</div>
    </div>
  );
}

/* ========== ARBR 情绪指标卡片 ========== */
function ArbrCard({ arbr }: { arbr: PluginMarketSentimentData["arbr"] }) {
  if (!arbr) return null;
  const arColor = arbr.arJudgment === "多头" ? "#b8533a" : arbr.arJudgment === "偏多" ? "#d4943a" : arbr.arJudgment === "中性" ? "#a8987e" : "#4a6b3f";
  const brColor = arbr.brJudgment === "多头" ? "#b8533a" : arbr.brJudgment === "偏多" ? "#d4943a" : arbr.brJudgment === "中性" ? "#a8987e" : "#4a6b3f";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">ARBR 情绪指标</div>
      <div className="flex items-center gap-3">
        <div className="flex flex-col items-center">
          <span className="text-[11px] text-[#a8987e]">AR</span>
          <span className="text-[20px] font-bold" style={{ color: arColor, ...TNUM }}>{arbr.ar}</span>
          <span className="text-[11px]" style={{ color: arColor }}>{arbr.arJudgment}</span>
        </div>
        <div className="text-[20px] text-[#d4c5a8]">/</div>
        <div className="flex flex-col items-center">
          <span className="text-[11px] text-[#a8987e]">BR</span>
          <span className="text-[20px] font-bold" style={{ color: brColor, ...TNUM }}>{arbr.br}</span>
          <span className="text-[11px]" style={{ color: brColor }}>{arbr.brJudgment}</span>
        </div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-[#8b7a5e]">{arbr.interpretation}</div>
    </div>
  );
}

/* ========== 成交量分析卡片 ========== */
function VolumeCard({ vol }: { vol: PluginMarketSentimentData["volumeAnalysis"] }) {
  if (!vol) return null;
  const volColor = vol.level === "放量" || vol.level === "温和放量" ? "#b8533a" : vol.level === "正常" ? "#a8987e" : "#4a6b3f";
  const tagCls = vol.level === "放量" || vol.level === "温和放量" ? "bg-[#b8533a]/15 text-[#b8533a]" : vol.level === "正常" ? "bg-[#a8987e]/15 text-[#a8987e]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#8b7a5e]">成交量分析</span>
        <span className={`rounded px-1.5 py-0.5 text-[12px] font-medium ${tagCls}`}>{vol.level}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[20px] font-bold text-[#6b5b3e]" style={TNUM}>{vol.ratio.toFixed(2)}x</span>
        <span className="text-[12px] text-[#a8987e]">量比</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex flex-1 overflow-hidden rounded-full bg-[#e0d5c0] text-[0]">
          <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(vol.ratio / 2 * 100, 100)}%`, background: volColor }} />
        </div>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-[#8b7a5e]">{vol.interpretation}</div>
    </div>
  );
}

/* ========== 涨跌分布卡片 ========== */
function DistributionCard({ dist }: { dist: PluginMarketSentimentData["distribution"] }) {
  if (!dist) return null;
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1 text-[11px] font-semibold text-[#8b7a5e]">涨跌分布</div>
      <div className="mb-1 flex items-center gap-2 text-[12px]">
        <span className="font-medium text-[#b8533a]">涨 {dist.upPct}%</span>
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-[#e0d5c0]">
          <div className="h-full rounded-l-full bg-[#b8533a]" style={{ width: `${dist.upPct}%` }} />
          <div className="h-full bg-[#d4c5a8]" style={{ width: `${dist.flatCount / dist.totalCount * 100}%` }} />
          <div className="h-full rounded-r-full bg-[#4a6b3f]" style={{ flex: 1 }} />
        </div>
        <span className="font-medium text-[#4a6b3f]">跌 {dist.downPct}%</span>
      </div>
      <div className="flex flex-wrap gap-0.5">
        {dist.intervals.filter(i => i.count > 0).map(i => (
          <span key={i.range} className="rounded bg-[#e0d5c0]/50 px-1 text-[11px] text-[#8b7a5e]">
            {i.range} <span className="font-medium text-[#6b5b3e]">{i.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ========== 流量分析卡片 ========== */
function FlowCard({ flowData }: { flowData: PluginNewsAnalystData["flowData"] }) {
  const cats = [
    { label: "社交", value: flowData.socialScore, color: "#d4943a" },
    { label: "新闻", value: flowData.newsScore, color: "#4a6b3f" },
    { label: "财经", value: flowData.financeScore, color: "#b8533a" },
    { label: "科技", value: flowData.techScore, color: "#a8987e" },
  ];
  const maxVal = Math.max(...cats.map(c => c.value), 1);
  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#8b7a5e]">流量分析</span>
        <span className="rounded bg-[#d4943a]/15 px-1.5 py-0.5 text-[12px] font-medium text-[#d4943a]">{flowData.level}</span>
      </div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[20px] font-bold text-[#6b5b3e]" style={TNUM}>{flowData.totalScore}</span>
        <span className="text-[11px] text-[#a8987e]">/ 1000</span>
      </div>
      <div className="mb-1 flex min-w-0 flex-col gap-0.5">
        {cats.map(c => (
          <div key={c.label} className="flex min-w-0 items-center gap-1.5 text-[12px]">
            <span className="w-8 shrink-0 text-right text-[#a8987e]">{c.label}</span>
            <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-[#e0d5c0]">
              <div className="h-full rounded-full" style={{ width: `${(c.value / maxVal) * 100}%`, background: c.color }} />
            </div>
            <span className="w-10 shrink-0 text-right font-medium text-[#6b5b3e]" style={TNUM}>{c.value}</span>
          </div>
        ))}
      </div>
      <div className="break-words text-[12px] leading-relaxed text-[#8b7a5e]">{flowData.analysis}</div>
    </div>
  );
}

/* ========== 涨跌停统计卡片 ========== */
function LimitUpDownCard({ lud }: { lud: PluginMarketSentimentData["limitUpDown"] }) {
  if (!lud) return null;
  const total = lud.limitUpCount + lud.limitDownCount;
  const upPct = total > 0 ? (lud.limitUpCount / total * 100) : 50;
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-2.5">
      <div className="mb-1.5 text-[11px] font-semibold text-[#8b7a5e]">涨跌停统计</div>
      <div className="flex items-center justify-around py-1">
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#b8533a]" style={TNUM}>{lud.limitUpCount}</div>
          <div className="text-[12px] text-[#a8987e]">涨停</div>
        </div>
        <div className="text-[20px] text-[#d4c5a8]">/</div>
        <div className="text-center">
          <div className="text-[20px] font-bold text-[#4a6b3f]" style={TNUM}>{lud.limitDownCount}</div>
          <div className="text-[12px] text-[#a8987e]">跌停</div>
        </div>
      </div>
      <div className="mb-1 flex h-2 overflow-hidden rounded-full bg-[#e0d5c0]">
        <div className="h-full rounded-l-full bg-[#b8533a]" style={{ width: `${upPct}%` }} />
        <div className="h-full rounded-r-full bg-[#4a6b3f]" style={{ flex: 1 }} />
      </div>
      <div className="text-[12px] leading-relaxed text-[#8b7a5e]">{lud.interpretation}</div>
    </div>
  );
}



/* ========== 可滚动面板容器(带滚动指示器) ========== */
function ScrollSentinel({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ top: 0, canScroll: false, atBottom: true });

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    setScrollState({
      top: el.scrollTop,
      canScroll: maxScroll > 1,
      atBottom: maxScroll <= 1 || el.scrollTop >= maxScroll - 2,
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [update]);

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 顶部渐变遮罩 — 滚动到顶部时隐藏 */}
      {scrollState.canScroll && scrollState.top > 2 && (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 h-10 bg-gradient-to-b from-[#f5f0e6] to-transparent" />
      )}
      <div
        ref={scrollRef}
        className="scroll-sentinel flex flex-col gap-2 overflow-y-auto scroll-smooth"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#d4c5a8 transparent" }}
      >
        {children}
      </div>
      {/* 底部渐变遮罩 + 滚动箭头指示器 — 到达底部时隐藏 */}
      {scrollState.canScroll && !scrollState.atBottom && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 flex flex-col items-center pb-2">
          <div className="h-10 w-full bg-gradient-to-b from-transparent to-[#f5f0e6]/90" />
          <button
            onClick={scrollToBottom}
            className="pointer-events-auto mt-[-12px] rounded-full bg-[#d4c5a8]/90 p-1.5 shadow-sm ring-1 ring-[#c8b89a]/40 transition-all duration-200 hover:bg-[#c8b89a] hover:ring-[#b8a888] active:scale-95"
            title="滚动到底部"
          >
            <svg className="h-3.5 w-3.5 text-[#6b5b3e]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      )}
      <style>{`
        .scroll-sentinel::-webkit-scrollbar { width: 4px; }
        .scroll-sentinel::-webkit-scrollbar-track { background: transparent; }
        .scroll-sentinel::-webkit-scrollbar-thumb { background: #d4c5a8; border-radius: 2px; }
        .scroll-sentinel::-webkit-scrollbar-thumb:hover { background: #c8b89a; }
      `}</style>
    </div>
  );
}

/* ========== 主面板 ========== */
export function ChainPluginPanel({ className = "" }: { className?: string }) {
  const { data: newsData, loading: newsLoading } = usePolling(
    () => api.pluginNewsAnalyst(),
    300000,
    []
  );
  const { data: sentimentData, loading: sentimentLoading } = usePolling(
    () => api.pluginMarketSentiment(),
    60000,
    []
  );

  const loading = newsLoading || sentimentLoading;
  const newsOk = newsData?.success;
  const sentimentOk = sentimentData?.dataSuccess;

  const updateTime = useMemo(() => {
    const t = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return t;
  }, [newsData, sentimentData]);

  if (loading) return <Loading />;
  if (!newsOk && !sentimentOk) return <Failed msg="数据接口暂不可用" />;

  return (
    <div className={`flex h-full min-h-0 flex-col p-2.5 ${className}`}>
      {/* 顶部状态栏 — 始终固定 */}
      <div className="mb-2 shrink-0 rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-3 py-1.5">
        <div className="flex items-center gap-2 text-[12px] text-[#8b7a5e]">
          <span className="font-semibold text-[#6b5b3e]">市场情绪总览</span>
          <span className="text-[#d4c5a8]">|</span>
          <span>
            数据源:
            {newsOk && ` 新闻(22平台) `}
            {newsOk && sentimentOk && <span className="text-[#d4c5a8]">·</span>}
            {sentimentOk && ` 大盘(上证/涨跌停/ARBR)`}
          </span>
          <span className="text-[#d4c5a8]">|</span>
          <span>更新: {updateTime}</span>
        </div>
        <div className="flex items-center gap-2">
          {newsData?.platformStats && (
            <span className="text-[11px] text-[#a8987e]">
              平台 {newsData.platformStats.success}/{newsData.platformStats.total}
            </span>
          )}
          {newsData?.fetchTime && (
            <span className="text-[11px] text-[#d4c5a8]">
              {new Date(newsData.fetchTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      <ScrollSentinel>
        {/* 第一行: 四大情绪指标(恐慌贪婪 + 新闻情绪 + 大盘 + ARBR) */}
        <div className="flex shrink-0 gap-2">
          {sentimentData?.fearGreed && <FearGreedGauge {...sentimentData.fearGreed} />}
          {newsData?.sentimentData && (
            <SentimentBar
              index={newsData.sentimentData.sentimentIndex}
              cls={newsData.sentimentData.sentimentClass}
              pos={newsData.sentimentData.positiveCount}
              neg={newsData.sentimentData.negativeCount}
            />
          )}
          <MarketIndexCard idx={sentimentData?.marketIndex ?? null} />
          {sentimentData?.arbr && <ArbrCard arbr={sentimentData.arbr} />}
        </div>

        {/* 第二行: 涨跌停 + 成交量分析 + 涨跌分布 */}
        <div className="flex shrink-0 gap-2">
          {sentimentData?.limitUpDown && <LimitUpDownCard lud={sentimentData.limitUpDown} />}
          {sentimentData?.volumeAnalysis && <VolumeCard vol={sentimentData.volumeAnalysis} />}
          {sentimentData?.distribution && <DistributionCard dist={sentimentData.distribution} />}
        </div>

        {/* 第三行: 流量分析 */}
        <div className="flex shrink-0 gap-2">
          {newsData?.flowData && <FlowCard flowData={newsData.flowData} />}
        </div>
      </ScrollSentinel>
    </div>
  );
}