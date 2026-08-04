import { useMemo } from "react";
import { Routes, Route } from "react-router";
import { TickerTape, type TapeItem } from "@/components/dash/TickerTape";
import { DashboardHeader } from "@/components/dash/DashboardHeader";
import { DashboardLayout, type PanelRowDef } from "@/components/dash/DashboardLayout";
import { IndexPanel } from "@/components/dash/IndexPanel";
import { CommodityTreasuryPanel } from "@/components/dash/CommodityTreasuryPanel";
import { SectorPanel } from "@/components/dash/SectorPanel";
import { MoneyFlowPanel } from "@/components/dash/MoneyFlowPanel";
import { RankPanel } from "@/components/dash/RankPanel";
import { BoardFlowPanel } from "@/components/dash/BoardFlowPanel";
import { NewsPanel } from "@/components/dash/NewsPanel";
import { ChainPanel } from "@/components/dash/ChainPanel";
import { WatchlistPanel } from "@/components/dash/WatchlistPanel";
import { StockDetailProvider, useStockDetail } from "@/components/dash/StockDetailContext";
import { StockDetailWindow } from "@/components/dash/StockDetailWindow";
import AiDashboard from "./AiDashboard";
import GoodsDashboard from "./GoodsDashboard";
import FinDashboard from "./FinDashboard";
import { useSharedPolling } from "@/hooks/useSharedPolling";
import { useQuotes } from "@/lib/market";
import { useFullscreen } from "@/hooks/useFullscreen";
import { api } from "@/lib/api";
import { INDICES, FOREX, COMMODITIES } from "@/config/dashboard";

function Tape() {
  const codes = useMemo(() => [...INDICES.map((i) => i.code), ...FOREX.map((i) => i.code)], []);
  const futureCodes = useMemo(() => COMMODITIES.map((c) => c.code), []);
  // 指数与期货报价: 统一报价中心(与全站所有面板同帧)
  const quotes = useQuotes(codes);
  const futures = useQuotes(futureCodes);
  const { data: treasuries } = useSharedPolling("treasuries", () => api.treasuries(), 60000);

  const items: TapeItem[] = useMemo(() => {
    const list: TapeItem[] = [];
    for (const d of [...INDICES, ...FOREX]) {
      const q = quotes?.[d.code];
      if (q) list.push({ key: d.code, label: d.label, price: q.price, pct: q.pct });
    }
    for (const c of COMMODITIES) {
      const q = futures?.[c.code];
      if (q) list.push({ key: c.code, label: c.label, price: q.price, pct: q.pct });
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
  }, [quotes, futures, treasuries]);

  if (items.length === 0) return <div className="h-7 border-b border-[#e0d5c0] bg-[#f5f0e6]" />;
  return <TickerTape items={items} />;
}

const PANEL_ROWS: PanelRowDef[] = [
  {
    defaultH: 0.30,
    panels: [
      { id: "index", component: IndexPanel, defaultW: 0.3, mobileH: "h-[560px]" },
      { id: "commodityTreasury", component: CommodityTreasuryPanel, defaultW: 0.3, mobileH: "h-[560px]" },
      { id: "news", component: NewsPanel, defaultW: 0.4, mobileH: "h-[560px]" },
    ],
  },
  {
    defaultH: 0.34,
    panels: [
      { id: "boardFlow", component: BoardFlowPanel, defaultW: 0.2, mobileH: "h-[340px]" },
      { id: "moneyFlow", component: MoneyFlowPanel, defaultW: 0.2, mobileH: "h-[340px]" },
      { id: "rank", component: RankPanel, defaultW: 0.2, mobileH: "h-[340px]" },
      { id: "sector", component: SectorPanel, defaultW: 0.4, mobileH: "h-[340px]" },
    ],
  },
  {
    defaultH: 0.36,
    panels: [
      { id: "watchlist", component: WatchlistPanel, defaultW: 0.2222, mobileH: "h-[400px]" },
      { id: "chain", component: ChainPanel, defaultW: 0.7778, mobileH: "h-[560px]" },
    ],
  },
];

function Dashboard() {
  const { isFullscreen, toggle } = useFullscreen();

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f0e6] text-[#6b5b3e] lg:h-screen lg:overflow-hidden">
      <DashboardHeader
        title="市场研究驾驶舱"
        subtitle="MARKET RESEARCH COCKPIT"
        accent="gold"
        tagline="沪深港美 · 大宗 · 美债 · 板块 · 资金流 · 快讯 · 产业链"
        linkTo="/ai"
        linkLabel="AI 观察"
        links={[{ to: "/goods", label: "商品价格" }, { to: "/ai", label: "AI 观察" }, { to: "/fin", label: "财报窗口" }]}
        live
        githubUrl="https://github.com/theBigGavin/marketingdashboard"
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggle}
      />
      <Tape />
      <DashboardLayout rows={PANEL_ROWS} />
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
      <Route path="/goods" element={<GoodsDashboard />} />
      <Route path="/fin" element={<FinDashboard />} />
    </Routes>
  );
}
