import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { PhiliaProvider } from "./PhiliaContext";
import { MarketReviewSection, type MarketReviewSectionHandle } from "./MarketReviewSection";

/**
 * PHILIA 独立页面: 由驾驶舱「PHILIA」小窗的「新页面」按钮打开。
 * 全屏单独展示龙头情绪复盘, 挂载时自动加载已有分析/触发一次分析, 交互能力与驾驶舱一致。
 */
function PhiliaPageInner() {
  const reviewRef = useRef<MarketReviewSectionHandle>(null);

  // 挂载后自动触发一次分析: 保证直接显示内容(与驾驶舱 PhiliaPanel 首次挂载行为一致)
  useEffect(() => {
    void reviewRef.current?.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen flex-col bg-[#f5f0e6] text-[#6b5b3e]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[#e0d5c0] bg-[#faf6ee] px-3">
        <span className="inline-block h-3.5 w-1 rounded-sm bg-[#d4943a]" />
        <span className="text-[13px] leading-none" style={{ color: "#d4943a" }}>
          ◈
        </span>
        <h1 className="text-[14px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">
          PHILIA · 龙头情绪复盘
        </h1>
        <div className="ml-auto flex items-center gap-2">
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
        <MarketReviewSection ref={reviewRef} />
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