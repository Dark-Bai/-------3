import { createContext, useState, type ReactNode } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { isTv } from "@/lib/tv";
import { FloatingWindow } from "./FloatingWindow";

/** 标记内容是否渲染在悬浮小窗内(纯镜像模式)。Panel 放大成小窗时会同时渲染两份 children
 *  (网格内 section + FloatingWindow 内), 子组件据此隐藏轮询等交互、仅镜像主面板数据。 */
export const MirrorContext = createContext(false);

export interface PanelZoomProps {
  panelId?: string;
  isZoomed?: boolean;
  onToggleZoom?: (id: string) => void;
}

interface PanelProps extends PanelZoomProps {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  accent?: string;
  /** 弹出悬浮窗默认尺寸(默认 960x640) */
  defaultWidth?: number;
  defaultHeight?: number;
  /** 悬浮窗标题栏右侧附加内容(仅小窗渲染, 如 PHILIA 个股搜索栏; 与 right 独立, 不影响其他面板小窗) */
  floatingRight?: ReactNode;
  /** 点击悬浮窗任意处时的回调(置顶之外的可选副作用, 如 PHILIA 自动触发分析) */
  onWindowClick?: () => void;
}

/** 驾驶舱面板容器 — 复古报刊专栏风格 */
export function Panel({
  title,
  icon,
  right,
  children,
  className = "",
  bodyClassName = "",
  accent = "#d4943a",
  panelId,
  isZoomed = false,
  onToggleZoom,
  defaultWidth,
  defaultHeight,
  floatingRight,
  onWindowClick,
}: PanelProps) {
  const tvOverlay = isTv && isZoomed;
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const measureRef = (el: HTMLElement | null) => {
    if (el && !isZoomed && el.offsetWidth > 0) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setNatural((prev) => (prev && Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2 ? prev : { w, h }));
    }
  };
  const overlayStyle = tvOverlay
    ? (() => {
        const w = window.innerWidth - 48;
        const h = window.innerHeight - 48;
        const k = natural ? Math.min(w / natural.w, h / natural.h) : 2;
        const z = Math.max(1, Math.min(k, 3));
        return { position: "fixed" as const, left: 24 / z, top: 24 / z, width: w / z, height: h / z, zIndex: 60, zoom: z };
      })()
    : undefined;

  const handleToggleZoom = () => {
    if (panelId && onToggleZoom) onToggleZoom(panelId);
  };

  return (
    <>
      {tvOverlay && <div className="fixed left-0 right-0 top-0 bottom-0 z-[55] bg-black/70" />}
      <section
        ref={measureRef}
        data-panel={panelId || undefined}
        style={overlayStyle}
        className={`flex min-h-0 flex-col rounded-sm border bg-[#faf6ee] shadow-newspaper transition-all duration-300 ${
          isZoomed ? "border-[#d4943a]/60 shadow-[0_0_24px_rgba(212,148,58,0.15)]" : "border-[#e0d5c0]"
        } ${tvOverlay ? "bg-[#faf6ee]" : ""} ${className}`}
      {...(isTv && panelId && onToggleZoom
        ? {
            "data-tv-focusable": true,
            "data-tv-zoomed": isZoomed || undefined,
            tabIndex: -1,
            onClick: (e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
              onToggleZoom(panelId);
            },
          }
        : {})}
    >
      {/* 报纸专栏标题栏 — 橘黄色强调条 + 报头标题 */}
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-[#e0d5c0] px-2.5">
        <span className="inline-block h-3.5 w-1 rounded-sm" style={{ background: accent }} />
        {icon && <span className="text-[13px] leading-none" style={{ color: accent }}>{icon}</span>}
        <h2 className="text-[13px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">{title}</h2>
        <div className="ml-auto flex items-center gap-2">
          {right}
          {panelId && onToggleZoom && (
            <button
              type="button"
              onClick={handleToggleZoom}
              title={isZoomed ? "收回悬浮窗" : "弹出悬浮窗"}
              className={`flex h-[22px] w-[22px] items-center justify-center rounded border transition-colors ${
                isZoomed
                  ? "border-[#d4943a]/60 bg-[#d4943a]/10 text-[#d4943a]"
                  : "border-[#e0d5c0] bg-[#ede4d4] text-[#8b7a5e] hover:border-[#d4943a]/60 hover:text-[#d4943a]"
              }`}
            >
              {isZoomed ? <ZoomOut size={12} /> : <ZoomIn size={12} />}
            </button>
          )}
        </div>
      </header>
      {/* 面板体 — 报纸正文区域 */}
      <div className={`min-h-0 flex-1 text-[#6b5b3e] ${bodyClassName}`}>{children}</div>
      </section>

      {/* 非 TV 模式: 悬浮窗口替代原地放大 */}
      {!isTv && isZoomed && panelId && (
        <FloatingWindow
          id={panelId}
          title={title}
          icon={icon}
          accent={accent}
          onClose={handleToggleZoom}
          right={floatingRight}
          defaultWidth={defaultWidth}
          defaultHeight={defaultHeight}
          onWindowClick={onWindowClick}
        >
          <MirrorContext.Provider value={true}>{children}</MirrorContext.Provider>
        </FloatingWindow>
      )}
    </>
  );
}