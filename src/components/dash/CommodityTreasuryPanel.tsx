import { useCallback, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { Spark } from "./Spark";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes, type HubQuote } from "@/lib/market";
import { api, type MinuteData } from "@/lib/api";
import { INDICES, FOREX, type IndexDef } from "@/config/dashboard";
import { bgChg, clsChg, fmtPct, fmtPrice } from "@/lib/format";

const STORAGE_KEY = "commodity-treasury-order";

/** 港股 · 美股 · 汇率 + 日经/KOSPI */
const GLOBAL_DEFS: IndexDef[] = [
  ...INDICES.filter((d) => d.region === "HK"),
  ...INDICES.filter((d) => d.region === "US"),
  ...FOREX,
];

const ALL_CODES = GLOBAL_DEFS.map((i) => i.code);
const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 从 localStorage 读取已保存顺序，缺失项追加到末尾 */
function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...ALL_CODES];
    const saved: string[] = JSON.parse(raw);
    const seen = new Set(saved);
    return [...saved.filter((c) => ALL_CODES.includes(c)), ...ALL_CODES.filter((c) => !seen.has(c))];
  } catch {
    return [...ALL_CODES];
  }
}

function saveOrder(order: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch { /* 忽略 */ }
}

function IndexRow({
  def,
  q,
  minute,
  index,
  dragOverIndex,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  def: IndexDef;
  q?: HubQuote;
  minute?: MinuteData;
  index: number;
  dragOverIndex: number | null;
  onDragStart: (e: React.DragEvent, idx: number) => void;
  onDragOver: (e: React.DragEvent, idx: number) => void;
  onDrop: (e: React.DragEvent, idx: number) => void;
  onDragEnd: (e: React.DragEvent) => void;
}) {
  const isDragOver = dragOverIndex === index;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onDragEnd={onDragEnd}
      className={`group flex cursor-grab items-center gap-1.5 rounded px-1 py-[1.5px] transition-colors hover:bg-[#ede4d4] active:cursor-grabbing ${
        isDragOver ? "ring-2 ring-[#d4943a]/50 bg-[#ede4d4]" : ""
      }`}
    >
      {/* 拖拽把手 */}
      <span className="shrink-0 text-[10px] text-[#c9b99a] opacity-0 transition-opacity group-hover:opacity-100 select-none">⠿</span>
      <span className="w-6 shrink-0 rounded-sm bg-[#e0d5c0] text-center text-[8px] leading-3 text-[#8b7a5e]">{def.region}</span>
      <span className="w-[72px] shrink-0 truncate text-[11px] text-[#6b5b3e]">{def.label}</span>
      <span className={`w-[70px] shrink-0 text-right text-[12px] font-bold ${q ? clsChg(q.pct) : "text-[#a8987e]"}`} style={TNUM}>
        {q ? fmtPrice(q.price) : "—"}
      </span>
      <span className={`w-[56px] shrink-0 rounded px-0.5 text-right text-[10px] font-semibold ${q ? bgChg(q.pct) : ""}`} style={TNUM}>
        {q ? fmtPct(q.pct) : ""}
      </span>
      <span className="hidden min-w-0 flex-1 items-center px-1 md:flex">
        {minute && minute.points.length > 1 && (
          <Spark points={minute.points} prec={minute.prec} width={120} height={16} fluid session="h24" />
        )}
      </span>
    </div>
  );
}

export function CommodityTreasuryPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [order, setOrder] = useState<string[]>(loadOrder);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragNode = useRef<HTMLElement | null>(null);

  // 报价
  const quotes = useQuotes(ALL_CODES);
  // 分钟线（15s 轮询）
  const { data: minutes } = usePolling(
    async () => {
      const results = await Promise.allSettled(ALL_CODES.map((c) => api.minute(c)));
      const map: Record<string, MinuteData> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled") map[ALL_CODES[i]] = r.value;
      });
      return map;
    },
    15000
  );

  // 按 order 排序的 defs
  const sortedDefs = useMemo(() => {
    const defMap = new Map(GLOBAL_DEFS.map((d) => [d.code, d]));
    return order.filter((c) => defMap.has(c)).map((c) => defMap.get(c)!);
  }, [order]);

  // 拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragNode.current = e.currentTarget as HTMLElement;
    setDragIndex(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  }, []);

  // 拖拽经过
  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(idx);
  }, []);

  // 拖拽放下
  const handleDrop = useCallback(
    (e: React.DragEvent, dropIdx: number) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === dropIdx) {
        setDragIndex(null);
        setDragOverIndex(null);
        return;
      }
      const newOrder = [...order];
      const [moved] = newOrder.splice(dragIndex, 1);
      newOrder.splice(dropIdx, 0, moved);
      setOrder(newOrder);
      saveOrder(newOrder);
      setDragIndex(null);
      setDragOverIndex(null);
    },
    [dragIndex, order]
  );

  // 拖拽结束
  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragNode.current = null;
  }, []);

  return (
    <Panel className={className} {...zoomProps} title="外围指数" icon="▦" accent="#d4943a"
      right={
        <span className="flex items-center gap-2 text-[10px] text-[#a8987e]">
          <span className="hidden sm:inline">拖拽排序</span>
          <span>5s</span>
        </span>
      }>
      <div className="flex h-full flex-col overflow-y-auto p-1">
        <div className="px-1 pb-0.5 pt-1 text-[9px] font-medium uppercase tracking-widest text-[#a8987e]">
          港股 · 美股 · 汇率 · 亚太
        </div>
        {sortedDefs.map((d, i) => (
          <IndexRow
            key={d.code}
            def={d}
            q={quotes?.[d.code]}
            minute={minutes?.[d.code]}
            index={i}
            dragOverIndex={dragOverIndex}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>
    </Panel>
  );
}