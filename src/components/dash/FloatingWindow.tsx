import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minus, Square, X, Maximize2 } from "lucide-react";

interface FloatingWindowProps {
  id: string;
  title: string;
  icon?: string;
  accent?: string;
  children: ReactNode;
  onClose: () => void;
  defaultWidth?: number;
  defaultHeight?: number;
}

let globalZIndex = 1000;

export function FloatingWindow({
  title,
  icon,
  accent = "#d4943a",
  children,
  onClose,
  defaultWidth = 960,
  defaultHeight = 640,
}: FloatingWindowProps) {
  const [pos, setPos] = useState({ x: (window.innerWidth - defaultWidth) / 2, y: 80 });
  const [size, setSize] = useState({ w: Math.min(defaultWidth, window.innerWidth - 80), h: Math.min(defaultHeight, window.innerHeight - 120) });
  const [zIndex, setZIndex] = useState(() => ++globalZIndex);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimizedState] = useState(false);
  const [prevState, setPrevState] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 });
  const windowRef = useRef<HTMLDivElement>(null);

  /** 点击窗口时提升到最前 */
  const bringToFront = useCallback(() => {
    setZIndex(++globalZIndex);
  }, []);

  /** 最小化 */
  const minimize = useCallback(() => {
    setIsMinimizedState(true);
  }, []);

  /** 最大化/还原 */
  const toggleMaximize = useCallback(() => {
    if (isMaximized && prevState) {
      setPos({ x: prevState.x, y: prevState.y });
      setSize({ w: prevState.w, h: prevState.h });
      setIsMaximized(false);
      setPrevState(null);
    } else {
      setPrevState({ x: pos.x, y: pos.y, w: size.w, h: size.h });
      setPos({ x: 0, y: 0 });
      setSize({ w: window.innerWidth, h: window.innerHeight });
      setIsMaximized(true);
      setIsMinimizedState(false);
    }
  }, [isMaximized, prevState, pos, size]);

  /** 关闭 */
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  /** 恢复（从最小化） */
  const restore = useCallback(() => {
    setIsMinimizedState(false);
    bringToFront();
  }, [bringToFront]);

  /** 鼠标拖拽 - 窗口移动 */
  const onMouseDownTitle = useCallback((e: React.MouseEvent) => {
    if (isMaximized) return;
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    bringToFront();
  }, [pos, isMaximized, bringToFront]);

  // 双击标题栏最大化/还原
  const onDoubleClickTitle = useCallback(() => {
    toggleMaximize();
  }, [toggleMaximize]);

  /** 鼠标拖拽 - 调整大小（右下角） */
  const onMouseDownResize = useCallback((e: React.MouseEvent) => {
    if (isMaximized) return;
    e.preventDefault();
    resizing.current = true;
    resizeStart.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h, px: pos.x, py: pos.y };
    bringToFront();
  }, [size, pos, isMaximized, bringToFront]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragging.current) {
        const newX = Math.max(0, e.clientX - dragOffset.current.x);
        const newY = Math.max(0, e.clientY - dragOffset.current.y);
        setPos({ x: newX, y: newY });
      }
      if (resizing.current) {
        const dx = e.clientX - resizeStart.current.x;
        const dy = e.clientY - resizeStart.current.y;
        const newW = Math.max(400, resizeStart.current.w + dx);
        const newH = Math.max(300, resizeStart.current.h + dy);
        setSize({ w: newW, h: newH });
      }
    };
    const handleMouseUp = () => {
      dragging.current = false;
      resizing.current = false;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // 最小化状态：只显示标题栏
  if (isMinimized) {
    return createPortal(
      <div
        ref={windowRef}
        className="fixed bottom-0 left-0 z-[9999]"
        onClick={restore}
      >
        <div
          className="flex cursor-pointer items-center gap-2 rounded-t border border-[#e0d5c0] border-b-[#d4943a] bg-[#faf6ee] px-3 py-1.5 shadow-newspaper-lg hover:bg-[#ede4d4] transition-colors"
          style={{ borderBottomWidth: 2, minWidth: 160 }}
        >
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: accent }} />
          {icon && <span className="text-[11px]" style={{ color: accent }}>{icon}</span>}
          <span className="text-[12px] font-medium text-[#6b5b3e] truncate max-w-[120px]">{title}</span>
          <span className="ml-2 text-[10px] text-[#a8987e]">— 点击恢复</span>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={windowRef}
      className="fixed flex flex-col rounded-sm border border-[#d4943a]/50 bg-[#faf6ee] shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
      style={{
        left: isMaximized ? 0 : pos.x,
        top: isMaximized ? 0 : pos.y,
        width: isMaximized ? "100vw" : size.w,
        height: isMaximized ? "100vh" : size.h,
        zIndex,
      }}
      onClick={bringToFront}
      onMouseDown={bringToFront}
    >
      {/* 标题栏 */}
      <header
        className="flex h-9 shrink-0 cursor-default items-center gap-2 border-b border-[#e0d5c0] bg-gradient-to-r from-[#f5f0e6] via-[#faf6ee] to-[#f5f0e6] px-3 select-none"
        onMouseDown={onMouseDownTitle}
        onDoubleClick={onDoubleClickTitle}
      >
        <span className="inline-block h-4 w-1.5 rounded-sm" style={{ background: accent }} />
        {icon && <span className="text-[13px] leading-none" style={{ color: accent }}>{icon}</span>}
        <h2 className="text-[13px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">{title}</h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={minimize}
            title="最小化"
            className="flex h-[26px] w-[26px] items-center justify-center rounded text-[#8b7a5e] transition-colors hover:bg-[#ede4d4] hover:text-[#6b5b3e]"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            onClick={toggleMaximize}
            title={isMaximized ? "还原" : "最大化"}
            className="flex h-[26px] w-[26px] items-center justify-center rounded text-[#8b7a5e] transition-colors hover:bg-[#ede4d4] hover:text-[#6b5b3e]"
          >
            {isMaximized ? <Maximize2 size={13} /> : <Square size={13} />}
          </button>
          <button
            type="button"
            onClick={handleClose}
            title="关闭"
            className="flex h-[26px] w-[26px] items-center justify-center rounded text-[#8b7a5e] transition-colors hover:bg-[#b8533a]/15 hover:text-[#b8533a]"
          >
            <X size={14} />
          </button>
        </div>
      </header>
      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-auto text-[#6b5b3e]">
        {children}
      </div>
      {/* 右下角拖拽手柄 */}
      {!isMaximized && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
          onMouseDown={onMouseDownResize}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="absolute bottom-1 right-1 opacity-40">
            <line x1="2" y1="10" x2="10" y2="2" stroke="#c9b99a" strokeWidth="1.5" />
            <line x1="5" y1="10" x2="10" y2="5" stroke="#c9b99a" strokeWidth="1.5" />
          </svg>
        </div>
      )}
    </div>,
    document.body
  );
}