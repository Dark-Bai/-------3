import { useEffect, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { LeaderPoolChip } from "./LeaderPoolChip";
import { MarketReviewSection, type MarketReviewSectionHandle } from "./MarketReviewSection";
import { PhiliaStockBox } from "./PhiliaStockBox";
import { usePhilia } from "./PhiliaContext";
import { isPhiliaPollEnabled } from "@/hooks/usePhiliaPolling";

/**
 * 界面中央大型整体模块: 由"上部空白模块" + "原 philia 模块"纵向合并而成。
 * 标题栏复用 Panel 组件; 主体为「龙头情绪复盘」——由 MarketReviewSection 内的
 * 「启动 AI 综合分析」按钮触发, 一次性生成今日龙头核心/情绪周期/机会/风险 + 昨日梯队双日对照 5 模块。
 * 综合分析视图已被龙头复盘取代, 仅保留启动键与龙头池。
 */
export function PhiliaPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const reviewRef = useRef<MarketReviewSectionHandle>(null);
  const { isZoomed } = zoomProps;
  // 配置加载标志: 首次挂载时若配置未就绪, 空技能会命中/写入与轮询不同的缓存槽, 导致刷新后显示陈旧数据,
  // 因此等配置加载完成后再自动触发分析, 确保用真实技能命中与轮询相同的缓存槽。
  const { configLoaded } = usePhilia();
  // 个股输入小窗当前值(由 PhiliaStockBox 同步): 供手动「重新分析」带上个股, 分析结果连同个股意见一起返还
  const [stockInput, setStockInput] = useState<{ code?: string; name?: string } | null>(null);

  // 进入 PHILIA 小窗(isZoomed 由 false→true)时自动触发一次「启动 AI 综合分析」,
  // 无需任何点击即可直接显示数据。run 内部有并发防抖, 规避重复请求。
  // 仅在自动轮询开关开启时才自动触发, 否则只由用户手动「启动/重新分析」驱动。
  const prevZoomed = useRef(isZoomed);
  useEffect(() => {
    const wasZoomed = prevZoomed.current;
    prevZoomed.current = isZoomed;
    if (isZoomed && !wasZoomed && isPhiliaPollEnabled()) {
      void reviewRef.current?.run();
    }
  }, [isZoomed]);

  // 首次挂载时自动触发一次分析: 保证本地全新打开/切回主页面都能直接显示内容。
  // 注: 页面初始的 focus/visibility 事件可能在组件挂载前就已触发, 事件监听器会漏掉,
  // 因此需在挂载后显式补一次, 否则全新启动时 PHILIA 只显示占位符。
  // 该触发须等配置加载完成(configLoaded), 以确保用真实技能命中与轮询相同的缓存槽。
  // 仅在自动轮询开关开启时才自动触发, 避免开关关闭时仍进入「AI 分析中」。
  useEffect(() => {
    if (configLoaded && isPhiliaPollEnabled()) void reviewRef.current?.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded]);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="PHILIA"
      icon={
        <img
          src="/hkrpg_cn.ico"
          alt="PHILIA"
          className="h-[1em] w-[1em] object-contain"
          draggable={false}
        />
      }
      accent="#d4943a"
      defaultWidth={1152}
      defaultHeight={768}
      right={
        <div className="ml-auto flex items-center gap-1.5">
          {/* 个股输入小窗: 搜索索引 + 拖入自选股 + 查收; 内部同步共享状态(主面板↔小窗镜像 + 跨页广播 + 自动轮询带个股) */}
          <PhiliaStockBox
            onCheck={(stock) => void reviewRef.current?.checkStock(stock)}
            onStockChange={setStockInput}
          />
          <LeaderPoolChip />
        </div>
      }
      // PHILIA 小窗标题栏同样提供搜索栏(仅小窗渲染): 与主面板搜索栏共享同一份个股状态, 编辑即镜像+广播
      floatingRight={
        <PhiliaStockBox
          onCheck={(stock) => void reviewRef.current?.checkStock(stock)}
          onStockChange={setStockInput}
        />
      }
    >
      <div className="flex h-full flex-col">
        <MarketReviewSection
          ref={reviewRef}
          // 外部个股框当前值: 填了股票后点「重新分析」也带上个股, 分析结果连同个股意见一起返还
          stockInput={stockInput}
        />
      </div>
    </Panel>
  );
}
