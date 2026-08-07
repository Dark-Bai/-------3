import { useEffect, useMemo, useState } from "react";
import { Routes, Route } from "react-router";
import { TickerTape, type TapeItem } from "@/components/dash/TickerTape";
import { DashboardHeader } from "@/components/dash/DashboardHeader";
import { DashboardLayout, type PanelRowDef } from "@/components/dash/DashboardLayout";
import { IndexPanel } from "@/components/dash/IndexPanel";
import { SectorPanel } from "@/components/dash/SectorPanel";
import { BoardFlowPanel } from "@/components/dash/BoardFlowPanel";
import { NewsPanel } from "@/components/dash/NewsPanel";
import { MarketSentimentPanel } from "@/components/dash/MarketSentimentPanel";
import { PhiliaPanel } from "@/components/dash/PhiliaPanel";
import PhiliaPage from "@/components/dash/PhiliaPage";
import { StockDetailProvider, useStockDetail } from "@/components/dash/StockDetailContext";
import { StockDetailWindow } from "@/components/dash/StockDetailWindow";
import { startMainHeartbeat } from "@/lib/philiaSync";
import { MonitorWindow } from "@/components/dash/MonitorWindow";
import { PhiliaProvider, usePhilia } from "@/components/dash/PhiliaContext";
import { PhiliaModal } from "@/components/dash/PhiliaModal";
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

const PANEL_ROWS: PanelRowDef[] = [
  {
    defaultH: 0.36,
    panels: [
      { id: "index", component: IndexPanel, defaultW: 0.2222, mobileH: "h-[280px]", colStart: 1 },
      // 中央大型整体模块: 自选股移除后, philia 跨第一、二行(rowSpan=2)并吸收新闻 60% 宽度腾出的空间(0.4889→0.6045)
      { id: "philia", component: PhiliaPanel, defaultW: 0.6045, mobileH: "h-[560px]", colStart: 2, rowSpan: 2 },
      // 实时热点新闻·7×24 快讯: 宽度缩减至 60%(0.2889→0.1733)
      { id: "news", component: NewsPanel, defaultW: 0.1733, mobileH: "h-[280px]", colStart: 3 },
    ],
  },
  {
    defaultH: 0.42,
    panels: [
      { id: "boardFlow", component: BoardFlowPanel, defaultW: 0.2222, mobileH: "h-[340px]", colStart: 1 },
      // 市场板块实时热点: 宽度缩减至 60%(0.2889→0.1733)
      { id: "sector", component: SectorPanel, defaultW: 0.1733, mobileH: "h-[340px]", colStart: 3 },
    ],
  },
  {
    defaultH: 0.22,
    panels: [
      // 自选股已移除, 市场情绪独占整行(宽度 1.0), 在保持功能完整性的前提下降低 UI 高度占用(0.28→0.22)
      { id: "marketSentiment", component: MarketSentimentPanel, defaultW: 1, mobileH: "h-[560px]", colStart: 1, colSpan: 3 },
    ],
  },
];

function Dashboard() {
  const { isFullscreen, toggle } = useFullscreen();
  const [showMonitor, setShowMonitor] = useState(false);
  const { config, configLoaded, analyzing, modalOpen, openModal } = usePhilia();
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
        onTogglePhilia={openModal}
        philiaActive={!!config?.hasKey}
        philiaAlert={configLoaded && !config?.hasKey}
        philiaAnalyzing={analyzing}
      />
      <Tape />
      <DashboardLayout rows={PANEL_ROWS} />
      {showMonitor && <MonitorWindow onClose={() => setShowMonitor(false)} />}
      {modalOpen && <PhiliaModal />}
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

/** 主面板 + 个股详情 Provider + Philia Provider */
function DashboardApp() {
  // 主页面心跳: 周期性广播, 供 /philia 新页面判断「主页面是否仍打开」。
  // 主页面存在时 /philia 应纯镜像其结果、不独立轮询; 仅有当主页面关闭、/philia 独立打开时才自行调取。
  useEffect(() => startMainHeartbeat(), []);
  return (
    <StockDetailProvider>
      <PhiliaProvider>
        <Dashboard />
        <StockDetailWindows />
      </PhiliaProvider>
    </StockDetailProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardApp />} />
      <Route path="/ai" element={<AiDashboard />} />
      <Route path="/fin" element={<FinDashboard />} />
      <Route path="/philia" element={<PhiliaPage />} />
    </Routes>
  );
}
