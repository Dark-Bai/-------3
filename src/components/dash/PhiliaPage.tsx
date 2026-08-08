import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { PhiliaProvider } from "./PhiliaContext";
import { MarketReviewSection, type MarketReviewSectionHandle } from "./MarketReviewSection";
import { PhiliaStockBox } from "./PhiliaStockBox";
import { isMainPageAlive, onPhiliaSync } from "@/lib/philiaSync";

/**
 * PHILIA 独立页面: 由驾驶舱「PHILIA」小窗的「新页面」按钮打开。
 * 全屏单独展示龙头情绪复盘。本页是主面板 PHILIA 的实时镜像: 打开时通过跨标签页同步
 * 拉取主面板当前状态, 不自行触发分析, 保证与主面板所有按钮状态一致; 若主面板未打开
 * (直接访问 /philia), 由 MarketReviewSection 内的兜底逻辑从缓存加载已有分析。
 * 个股输入小窗: 主面板存在时纯镜像主页个股(不可编辑, 结果一并镜像); 主面板关闭时
 * 独立模式可编辑, 独立轮询会带上该个股再判断, 避免结果失去时效性。
 */
function PhiliaPageInner() {
  const reviewRef = useRef<MarketReviewSectionHandle>(null);
  // 主页面存活状态: 每 2s 检查心跳 + 实时接收 main-beat 广播
  const [mainAlive, setMainAlive] = useState(isMainPageAlive);
  // 本页当前个股(供手动「重新分析」带上个股; 镜像/独立模式由 PhiliaStockBox 共享状态统一驱动)
  const [stockInput, setStockInput] = useState<{ code?: string; name?: string } | null>(null);

  useEffect(() => {
    const check = () => setMainAlive(isMainPageAlive());
    check();
    const t = window.setInterval(check, 2000);
    const unsub = onPhiliaSync((msg) => {
      if (msg.type === "philia-main-beat") setMainAlive(true);
    });
    return () => {
      window.clearInterval(t);
      unsub();
    };
  }, []);

  // 主页面存在 → 纯镜像(输入框镜像主页个股, 不独立轮询); 主页面关闭 → 独立模式(输入可编辑, 独立轮询带个股)
  const mirror = mainAlive;

  return (
    <div className="flex h-screen flex-col bg-[#f5f0e6] text-[#6b5b3e]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[#e0d5c0] bg-[#faf6ee] px-3">
        <span className="inline-block h-3.5 w-1 rounded-sm bg-[#d4943a]" />
        <span className="inline-flex items-center text-[13px] leading-none">
          <img src="/hkrpg_cn.ico" alt="PHILIA" className="h-[1em] w-[1em] object-contain" draggable={false} />
        </span>
        <h1 className="text-[14px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">
          PHILIA · 龙头情绪复盘
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <PhiliaStockBox
            mirror={mirror}
            onCheck={(stock) => void reviewRef.current?.checkStock(stock)}
            onStockChange={setStockInput}
          />
          <Link
            to="/"
            className="flex items-center gap-1 rounded border border-[#e0d5c0] bg-[#ede4d4] px-2 py-1 text-[13px] font-bold text-[#8b7a5e] transition-colors hover:border-[#d4943a]/60 hover:text-[#6b5b3e]"
          >
            <ChevronLeft size={14} />
            返回驾驶舱
          </Link>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {/* standalone: /philia 独立页面。主页面存在时纯镜像其结果、不独立轮询; 主页面关闭时才自行调取结果(并带上个股) */}
        <MarketReviewSection ref={reviewRef} standalone stockInput={stockInput} />
      </div>
    </div>
  );
}

export default function PhiliaPage() {
  return (
    <PhiliaProvider>
      <PhiliaPageInner />
    </PhiliaProvider>
  );
}
