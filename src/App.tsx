import { useMemo, useState } from "react";
import { Routes, Route } from "react-router";
import { TickerTape, type TapeItem } from "@/components/dash/TickerTape";
import { DashboardHeader } from "@/components/dash/DashboardHeader";
import { DashboardLayout, type PanelRowDef } from "@/components/dash/DashboardLayout";
import { IndexPanel } from "@/components/dash/IndexPanel";
import { CommodityTreasuryPanel } from "@/components/dash/CommodityTreasuryPanel";
import { SectorPanel } from "@/components/dash/SectorPanel";
import { BoardFlowPanel } from "@/components/dash/BoardFlowPanel";
import { NewsPanel } from "@/components/dash/NewsPanel";
import { MarketSentimentPanel } from "@/components/dash/MarketSentimentPanel";
import { WatchlistPanel } from "@/components/dash/WatchlistPanel";
import { StockDetailProvider, useStockDetail } from "@/components/dash/StockDetailContext";
import { StockDetailWindow } from "@/components/dash/StockDetailWindow";
import { MonitorWindow } from "@/components/dash/MonitorWindow";
import AiDashboard from "./AiDashboard";
import FinDashboard from "./FinDashboard";
import { useSharedPolling } from "@/hooks/useSharedPolling";
import { useQuotes } from "@/lib/market";
import { useFullscreen } from "@/hooks/useFullscreen";
import { api } from "@/lib/api";
import { INDICES, FOREX } from "@/config/dashboard";

function Tape() {
  const codes = useMemo(() => [...INDICES.map((i) => i.code), ...FOREX.map((i) => i.code)], []);
  // 指数与汇率报价: 统一报价中心(与全站所有面板同帧)
  const quotes = useQuotes(codes);
  const { data: treasuries } = useSharedPolling("treasuries", () => api.treasuries(), 60000);

  const items: TapeItem[] = useMemo(() => {
    const list: TapeItem[] = [];
    for (const d of [...INDICES, ...FOREX]) {
      const q = quotes?.[d.code];
      if (q) list.push({ key: d.code, label: d.label, price: q.price, pct: q.pct });
    }
    for (const sym of ["US10Y", "US2Y"]) {
      const t = treasuries?.find((x) => x.symbol === sym);
      if (t)
        list.push({
          key: sym,
          label: `美债${sym.replace("US", "")}收益率`,
          price: t.yield,
          pct: t.yield ? (t.change / t.yield) * 100 : 0, // yield 缺失(接口异常归一为 0)时不产生 Infinity%
          digits: 3,
        });
    }
    return list;
  }, [quotes, treasuries]);

  if (items.length === 0) return <div className="h-7 border-b border-[#e0d5c0] bg-[#f5f0e6]" />;
  return <TickerTape items={items} />;
}

/** 透明占位: 用于在行内对齐上下行面板, 不渲染任何内容/边框 */
function Spacer() {
  return <div className="h-full" />;
}

const PANEL_ROWS: PanelRowDef[] = [
  {
    defaultH: 0.30,
    panels: [
      { id: "index", component: IndexPanel, defaultW: 0.2222, mobileH: "h-[560px]" },
      { id: "commodityTreasury", component: CommodityTreasuryPanel, defaultW: 0.4889, mobileH: "h-[560px]" },
      { id: "news", component: NewsPanel, defaultW: 0.2889, mobileH: "h-[560px]" },
    ],
  },
  {
    defaultH: 0.34,
    panels: [
      // 第二行与第一行对齐: 板块资金流向↔A股关键指数(0.2222), 市场板块实时热点↔快讯(0.2889), 中间留白对应商品·美债
      { id: "boardFlow", component: BoardFlowPanel, defaultW: 0.2222, mobileH: "h-[340px]" },
      { id: "spacer", component: Spacer, defaultW: 0.4889, mobileH: "h-[340px]" },
      { id: "sector", component: SectorPanel, defaultW: 0.2889, mobileH: "h-[340px]" },
    ],
  },
  {
    defaultH: 0.36,
    panels: [
      { id: "watchlist", component: WatchlistPanel, defaultW: 0.2222, mobileH: "h-[400px]" },
      { id: "marketSentiment", component: MarketSentimentPanel, defaultW: 0.7778, mobileH: "h-[560px]" },
    ],
  },
];

function Dashboard() {
  const { isFullscreen, toggle } = useFullscreen();
  const [showMonitor, setShowMonitor] = useState(false);
  // 轻量监控数据: 用于头部告警红点(慢接口/报错时点亮), 30s 轮询
  const { data: monitorData } = useSharedPolling("monitor", () => api.monitor(), 30000);
  const monitorAlert = useMemo(() => {
    const eps = monitorData?.endpoints ?? [];
    return eps.some((e) => e.count > 0 && (e.p95 > 1000 || e.errors > 0));
  }, [monitorData]);

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f0e6] text-[#6b5b3e] lg:h-screen lg:overflow-hidden">
      <DashboardHeader
        title="市场研究驾驶舱"
        subtitle="MARKET RESEARCH COCKPIT"
        accent="gold"
        tagline="沪深港美 · 美债 · 板块 · 资金流 · 快讯 · 市场情绪"
        linkTo="/ai"
        linkLabel="AI 观察"
        links={[{ to: "/ai", label: "AI 观察" }, { to: "/fin", label: "财报窗口" }]}
        live
        githubUrl="https://github.com/theBigGavin/marketingdashboard"
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggle}
        onToggleMonitor={() => setShowMonitor((v) => !v)}
        monitorActive={showMonitor}
        monitorAlert={monitorAlert}
      />
      <Tape />
      <DashboardLayout rows={PANEL_ROWS} />
      {showMonitor && <MonitorWindow onClose={() => setShowMonitor(false)} />}
    </div>
  );
}

/** 渲染所有打开的个股详情悬浮窗 */
function StockDetailWindows() {
  const { stocks, closeStockDetail } = useStockDetail();
  return (
    <>
      {stocks.map((s) => (
        <StockDetailWindow
          key={s.code}
          code={s.code}
          name={s.name}
          onClose={() => closeStockDetail(s.code)}
        />
      ))}
    </>
  );
}

/** 主面板 + 个股详情 Provider */
function DashboardApp() {
  return (
    <StockDetailProvider>
      <Dashboard />
      <StockDetailWindows />
    </StockDetailProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardApp />} />
      <Route path="/ai" element={<AiDashboard />} />
      <Route path="/fin" element={<FinDashboard />} />
    </Routes>
  );
}
