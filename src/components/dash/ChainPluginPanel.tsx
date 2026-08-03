import { useMemo } from "react";
import { usePolling } from "@/hooks/usePolling";
import { api, type PluginNewsAnalystData, type PluginMarketSentimentData } from "@/lib/api";
import { clsChg } from "@/lib/format";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/* ========== 加载/错误共用 ========== */
function Loading() {
  return <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">加载中…</div>;
}
function Failed({ msg = "数据加载失败" }: { msg?: string }) {
  return <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">{msg}</div>;
}

/* ========== 情绪卡片: 恐慌贪婪指数(圆形仪表) ========== */
function FearGreedGauge({ score, level, interpretation }: { score: string; level: string; interpretation: string }) {
  const s = parseFloat(score);
  const color = s >= 75 ? "#b8533a" : s >= 60 ? "#d4943a" : s >= 40 ? "#a8987e" : s >= 25 ? "#4a6b3f" : "#4a6b3f";
  const bg = s >= 75 ? "bg-[#b8533a]/15 text-[#b8533a]" : s >= 60 ? "bg-[#d4943a]/15 text-[#d4943a]" : s >= 40 ? "bg-[#a8987e]/15 text-[#a8987e]" : s >= 25 ? "bg-[#4a6b3f]/15 text-[#4a6b3f]" : "bg-[#4a6b3f]/15 text-[#4a6b3f]";
  return (
    <div className="flex flex-1 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
      <div className="mb-1 text-[9px] font-semibold text-[#8b7a5e]">恐慌贪婪指数</div>
      <div className="flex items-center gap-3">
        <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 border-[#e0d5c0]">
          <div className="text-center">
            <div className="text-[18px] font-bold leading-none" style={{ color, ...TNUM }}>{parseFloat(score).toFixed(0)}</div>
            <div className="text-[7px] text-[#a8987e]">/100</div>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-medium ${bg}`}>{level}</span>
          <div className="mt-1 text-[8px] leading-relaxed text-[#8b7a5e]">{interpretation}</div>
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
    <div className="flex flex-1 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[9px] font-semibold text-[#8b7a5e]">新闻情绪指数</span>
        <span className={`rounded px-1.5 py-0.5 text-[8px] font-medium ${tagCls}`}>{cls}</span>
      </div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[18px] font-bold leading-none text-[#6b5b3e]" style={TNUM}>{index}</span>
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[#e0d5c0]">
          <div className="h-full rounded-full transition-all" style={{ width: `${index}%`, background: barColor }} />
        </div>
      </div>
      <div className="flex items-center gap-2 text-[8px] text-[#a8987e]">
        <span className="flex items-center gap-0.5"><span className="h-1.5 w-1.5 rounded-full bg-[#b8533a]" />积极 {pos}</span>
        <span className="flex items-center gap-0.5"><span className="h-1.5 w-1.5 rounded-full bg-[#4a6b3f]" />消极 {neg}</span>
      </div>
    </div>
  );
}

/* ========== 情绪卡片: 大盘市场情绪 ========== */
function MarketIndexCard({ idx }: { idx: PluginMarketSentimentData["marketIndex"] }) {
  if (!idx) return null;
  const upRatio = idx.totalCount > 0 ? (idx.upCount / idx.totalCount * 100).toFixed(0) : "0";
  return (
    <div className="flex flex-1 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
      <div className="mb-1 text-[9px] font-semibold text-[#8b7a5e]">大盘市场情绪</div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] text-[#6b5b3e]">{idx.indexName}</span>
        <span className={`text-[13px] font-bold ${clsChg(idx.changePercent)}`} style={TNUM}>
          {idx.changePercent >= 0 ? "+" : ""}{idx.changePercent}%
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <div className="flex flex-1 overflow-hidden rounded-full bg-[#e0d5c0] text-[0]">
          <div className="h-3 rounded-l-full bg-[#b8533a] leading-none" style={{ width: `${upRatio}%` }} />
          <div className="h-3 bg-[#4a6b3f] leading-none" style={{ flex: 1 }} />
        </div>
      </div>
      <div className="mt-1.5 text-[8px] leading-relaxed text-[#8b7a5e]">{idx.sentimentInterpretation}</div>
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
    <div className="flex flex-1 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[9px] font-semibold text-[#8b7a5e]">📊 流量分析</span>
        <span className="rounded bg-[#d4943a]/15 px-1.5 py-0.5 text-[8px] font-medium text-[#d4943a]">{flowData.level}</span>
      </div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[18px] font-bold text-[#6b5b3e]" style={TNUM}>{flowData.totalScore}</span>
        <span className="text-[9px] text-[#a8987e]">/ 1000</span>
      </div>
      <div className="mb-1 flex flex-col gap-0.5">
        {cats.map(c => (
          <div key={c.label} className="flex items-center gap-1 text-[8px]">
            <span className="w-6 shrink-0 text-right text-[#a8987e]">{c.label}</span>
            <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[#e0d5c0]">
              <div className="h-full rounded-full" style={{ width: `${(c.value / maxVal) * 100}%`, background: c.color }} />
            </div>
            <span className="w-8 shrink-0 text-right font-medium text-[#6b5b3e]" style={TNUM}>{c.value}</span>
          </div>
        ))}
      </div>
      <div className="text-[8px] leading-relaxed text-[#8b7a5e]">{flowData.analysis}</div>
    </div>
  );
}

/* ========== 涨跌停统计卡片 ========== */
function LimitUpDownCard({ lud }: { lud: PluginMarketSentimentData["limitUpDown"] }) {
  if (!lud) return null;
  const total = lud.limitUpCount + lud.limitDownCount;
  const upPct = total > 0 ? (lud.limitUpCount / total * 100) : 50;
  return (
    <div className="flex flex-1 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
      <div className="mb-1.5 text-[9px] font-semibold text-[#8b7a5e]">🚫 涨跌停统计</div>
      <div className="flex items-center justify-around py-1">
        <div className="text-center">
          <div className="text-[16px] font-bold text-[#b8533a]" style={TNUM}>{lud.limitUpCount}</div>
          <div className="text-[8px] text-[#a8987e]">涨停</div>
        </div>
        <div className="text-[16px] text-[#d4c5a8]">/</div>
        <div className="text-center">
          <div className="text-[16px] font-bold text-[#4a6b3f]" style={TNUM}>{lud.limitDownCount}</div>
          <div className="text-[8px] text-[#a8987e]">跌停</div>
        </div>
      </div>
      <div className="mb-1 flex h-2 overflow-hidden rounded-full bg-[#e0d5c0]">
        <div className="h-full rounded-l-full bg-[#b8533a]" style={{ width: `${upPct}%` }} />
        <div className="h-full rounded-r-full bg-[#4a6b3f]" style={{ flex: 1 }} />
      </div>
      <div className="text-[8px] leading-relaxed text-[#8b7a5e]">{lud.interpretation}</div>
    </div>
  );
}

/* ========== 热门话题标签云 ========== */
function HotTopicsCloud({ topics }: { topics: PluginNewsAnalystData["hotTopics"] }) {
  if (!topics.length) return null;
  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-1 text-[9px] font-semibold text-[#8b7a5e]">🔥 热门话题 TOP{topics.length}</div>
      <div className="flex flex-wrap gap-1">
        {topics.map(t => (
          <span
            key={t.topic}
            className="inline-flex items-center rounded border border-[#d4943a]/20 bg-[#d4943a]/10 px-1.5 py-0.5 text-[8px] text-[#8b7a5e]"
            title={`热度 ${t.heat} · 跨 ${t.crossPlatform} 平台 · ${t.sources.join(", ")}`}
          >
            {t.topic}
            <span className="ml-1 text-[7px] text-[#c8b89a]">{t.heat}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ========== 股票新闻列表 ========== */
function StockNewsList({ news }: { news: PluginNewsAnalystData["stockNews"] }) {
  if (!news.length) {
    return <div className="flex items-center justify-center py-4 text-[9px] text-[#a8987e]">暂无相关新闻</div>;
  }
  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-1 text-[9px] font-semibold text-[#8b7a5e]">
        📰 股票相关新闻 <span className="font-normal text-[#a8987e]">TOP{news.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
        {news.slice(0, 10).map((n, i) => (
          <div key={i} className="rounded px-1.5 py-1 hover:bg-[#ede4d4]">
            <div className="flex items-center gap-1 text-[7px] text-[#a8987e]">
              <span>{n.platform}</span>
              <span className="text-[#d4c5a8]">·</span>
              <span className="capitalize">{n.category}</span>
            </div>
            <div className="mt-0.5 text-[8px] leading-[1.4] text-[#6b5b3e] line-clamp-2">{n.title}</div>
            {n.matchedKeywords.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {n.matchedKeywords.slice(0, 3).map(kw => (
                  <span key={kw} className="rounded bg-[#4a6b3f]/10 px-1 text-[6px] text-[#4a6b3f]">{kw}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ========== 综合情绪仪表盘(顶部, 仅从市场情绪数据) ========== */
function SentimentDashboard({ data }: { data: PluginMarketSentimentData | null }) {
  if (!data?.dataSuccess) return null;
  return (
    <div className="flex shrink-0 gap-2">
      {data.fearGreed && <FearGreedGauge {...data.fearGreed} />}
      <MarketIndexCard idx={data.marketIndex} />
      {data.limitUpDown && <LimitUpDownCard lud={data.limitUpDown} />}
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
    <div className={`flex h-full min-h-0 flex-col gap-1.5 p-2 ${className}`}>
      {/* 顶部状态栏 */}
      <div className="flex shrink-0 items-center justify-between rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2 py-1">
        <div className="flex items-center gap-2 text-[8px] text-[#8b7a5e]">
          <span className="font-semibold text-[#6b5b3e]">📈 市场情绪总览</span>
          <span className="text-[#d4c5a8]">|</span>
          <span>
            数据源:
            {newsOk && ` 新闻(22平台) `}
            {newsOk && sentimentOk && <span className="text-[#d4c5a8]">·</span>}
            {sentimentOk && ` 大盘(上证/涨跌停)`}
          </span>
          <span className="text-[#d4c5a8]">|</span>
          <span>更新: {updateTime}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {newsData?.platformStats && (
            <span className="text-[7px] text-[#a8987e]">
              平台 {newsData.platformStats.success}/{newsData.platformStats.total}
            </span>
          )}
          {newsData?.fetchTime && (
            <span className="text-[7px] text-[#d4c5a8]">
              {new Date(newsData.fetchTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      {/* 第一行: 三大情绪指标 */}
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
        {sentimentData?.limitUpDown && <LimitUpDownCard lud={sentimentData.limitUpDown} />}
      </div>

      {/* 第二行: 流量分析 + 涨跌停统计(二列) */}
      <div className="flex shrink-0 gap-2">
        {newsData?.flowData && <FlowCard flowData={newsData.flowData} />}
      </div>

      {/* 第三行: 热门话题 + 股票新闻(双栏) */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* 左栏: 热门话题 */}
        <div className="flex w-1/2 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
          {newsData?.hotTopics ? (
            <HotTopicsCloud topics={newsData.hotTopics} />
          ) : (
            <div className="flex h-full items-center justify-center text-[9px] text-[#a8987e]">暂无热门话题</div>
          )}
        </div>
        {/* 右栏: 股票新闻 */}
        <div className="flex w-1/2 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2.5 py-2">
          {newsData?.stockNews ? (
            <StockNewsList news={newsData.stockNews} />
          ) : (
            <div className="flex h-full items-center justify-center text-[9px] text-[#a8987e]">暂无相关新闻</div>
          )}
        </div>
      </div>
    </div>
  );
}