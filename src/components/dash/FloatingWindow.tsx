import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minus, Square, X, Maximize2, RotateCcw } from "lucide-react";

/* ---------------- 小窗尺寸/位置记忆 ----------------
 * 每次拖拽移动或调整大小结束后, 将 {x,y,w,h} 持久化到 localStorage(按窗口 id 分键),
 * 应用重启后读取并应用, 保证用户调整过的小窗大小在重启后仍生效。
 * key 形如 dash:float:{id}:layout, 与既有 localStorage 约定(dash:*)保持一致。
 */
interface SavedLayout { x: number; y: number; w: number; h: number; }
const LAYOUT_KEY = (id: string) => `dash:float:${id}:layout`;
function loadLayout(id: string): SavedLayout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY(id));
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o !== "object" || o === null) return null;
    const { x, y, w, h } = o as Partial<SavedLayout>;
    if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    return { x: x as number, y: y as number, w: w as number, h: h as number };
  } catch {
    return null;
  }
}
function saveLayout(id: string, l: SavedLayout) {
  try { localStorage.setItem(LAYOUT_KEY(id), JSON.stringify(l)); } catch { /* 存储不可用时静默忽略 */ }
}
function clearLayout(id: string) {
  try { localStorage.removeItem(LAYOUT_KEY(id)); } catch { /* ignore */ }
}

interface FloatingWindowProps {
  id: string;
  title: string;
  icon?: string;
  accent?: string;
  children: ReactNode;
  onClose: () => void;
  /** 点击窗口任意处时的回调(置顶之外的可选副作用, 如 PHILIA 自动触发分析) */
  onWindowClick?: () => void;
  defaultWidth?: number;
  defaultHeight?: number;
  /** 初始位置(默认居中); 屏幕分辨率变化时会自适应夹取到视口内 */
  defaultX?: number;
  defaultY?: number;
}

let globalZIndex = 1000;

export function FloatingWindow({
  id,
  title,
  icon,
  accent = "#d4943a",
  children,
  onClose,
  onWindowClick,
  defaultWidth = 960,
  defaultHeight = 640,
  defaultX,
  defaultY,
}: FloatingWindowProps) {
  // 初次挂载时读取已记忆的布局(尺寸+位置), 无记忆则用默认值; 均夹取到当前视口内
  const initial = loadLayout(id);
  const savedW = initial?.w ?? defaultWidth;
  const savedH = initial?.h ?? defaultHeight;
  const [pos, setPos] = useState(() => {
    const w = Math.min(savedW, window.innerWidth - 80);
    const h = Math.min(savedH, window.innerHeight - 120);
    const x = initial?.x ?? defaultX ?? (window.innerWidth - w) / 2;
    const y = initial?.y ?? defaultY ?? 80;
    return {
      x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w)),
      y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - h)),
    };
  });
  const [size, setSize] = useState({ w: Math.min(savedW, window.innerWidth - 80), h: Math.min(savedH, window.innerHeight - 120) });
  const [zIndex, setZIndex] = useState(() => ++globalZIndex);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimizedState] = useState(false);
  const [prevState, setPrevState] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef(false);
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 });
  const windowRef = useRef<HTMLDivElement>(null);

  // 最新位置/尺寸引用: 供 resize 自适应夹取使用(避免闭包陈旧值)
  const posRef = useRef(pos);
  const sizeRef = useRef(size);
  useEffect(() => { posRef.current = pos; }, [pos]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // 屏幕分辨率变化时自适应: 缩回视口内并夹取尺寸, 避免窗口被裁切/相互越界
  useEffect(() => {
    const onResize = () => {
      if (isMaximized) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const p = posRef.current;
      const s = sizeRef.current;
      const nw = Math.min(s.w, Math.max(320, vw - 40));
      const nh = Math.min(s.h, Math.max(240, vh - 40));
      const nx = Math.min(Math.max(0, p.x), Math.max(0, vw - nw));
      const ny = Math.min(Math.max(0, p.y), Math.max(0, vh - nh));
      setSize({ w: nw, h: nh });
      setPos({ x: nx, y: ny });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMaximized]);

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

  /** 恢复默认大小/位置: 清空记忆, 回到初始默认尺寸 */
  const resetSize = useCallback(() => {
    clearLayout(id);
    const defW = Math.min(defaultWidth, window.innerWidth - 80);
    const defH = Math.min(defaultHeight, window.innerHeight - 120);
    setSize({ w: defW, h: defH });
    setPos({ x: defaultX ?? (window.innerWidth - defW) / 2, y: defaultY ?? 80 });
  }, [id, defaultWidth, defaultHeight, defaultX, defaultY]);

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
      // 拖拽/调整结束后, 持久化当前尺寸与位置, 供重启后恢复 (id 为稳定 prop, 闭包捕获安全)
      if (dragging.current || resizing.current) {
        saveLayout(id, { ...posRef.current, ...sizeRef.current });
      }
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

  // 窗口显示(首次挂载 / 从最小化恢复)时强制重排, 确保 flex 内容区正确出图,
  // 避免小窗退出/切后台后再查看出现空白、需额外点击才显示的问题。
  useEffect(() => {
    if (isMinimized) return;
    const raf = requestAnimationFrame(() => {
      const el = windowRef.current;
      if (el) void el.offsetHeight; // 强制浏览器重排/重绘
    });
    return () => cancelAnimationFrame(raf);
  }, [isMinimized]);

  return createPortal(
    <>
    <div
      ref={windowRef}
      className="fixed flex flex-col rounded-sm border border-[#d4943a]/50 bg-[#faf6ee] shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
      style={{
        left: isMaximized ? 0 : pos.x,
        top: isMaximized ? 0 : pos.y,
        width: isMaximized ? "100vw" : size.w,
        height: isMaximized ? "100vh" : size.h,
        zIndex,
        // 最小化时: 内容保持挂载(状态/滚动不丢失), 仅视觉隐藏, 避免重挂载导致空白
        visibility: isMinimized ? "hidden" : "visible",
        pointerEvents: isMinimized ? "none" : undefined,
      }}
      onClick={() => { bringToFront(); onWindowClick?.(); }}
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
            onClick={resetSize}
            title="恢复默认大小"
            className="flex h-[26px] w-[26px] items-center justify-center rounded text-[#8b7a5e] transition-colors hover:bg-[#ede4d4] hover:text-[#6b5b3e]"
          >
            <RotateCcw size={13} />
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
    </div>
    {/* 最小化时: 底部任务栏, 点击恢复(内容保持挂载不动) */}
    {isMinimized && (
      <div
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
      </div>
    )}
  </>,
    document.body
  );
}