/**
 * mini自选 面板(原「实时热点新闻 · 7×24 快讯」位置改造)
 *
 * 功能:
 *  - 标题右侧搜索添加(与自选股共享列表, 新加的从头部插入, 两面板同步出现)
 *  - 单行紧凑展示: 股票名称(点击打开个股小窗) + 涨幅 + 总金额 + 主力净额
 *  - 拖动排序(HTML5 DnD): 顺序独立持久化(dash:watchlist-mini-order), 不影响自选股卡片顺序
 *  - 数据: 报价统一走报价中心(useQuotes 5s 单源) / 大单净额 30s
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { useSharedPolling } from "@/hooks/useSharedPolling";
import { api, type StockFlow, type StockSearchResult } from "@/lib/api";
import { useQuotes, type HubQuote } from "@/lib/market";
import { clsChg, fmtPct, fmtWan, fmtYuan } from "@/lib/format";
import { useWatchlist } from "./WatchlistContext";
import { useStockDetail } from "./StockDetailContext";

/** mini自选 独立顺序持久化 key(不影响自选股卡片顺序) */
const MINI_ORDER_KEY = "dash:watchlist-mini-order";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 单行个股: 名称(点击打开小窗) | 涨幅 | 总金额 | 主力净额 | 删除 */
function MiniRow({
  code, quote, flow, dragging, onOpen, onRemove, onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  code: string; quote?: HubQuote; flow?: StockFlow; dragging: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const pct = quote?.pct ?? 0;
  const netIn = flow?.netIn;
  const name = quote?.name || code.replace(/^(sh|sz|bj)/, "");
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title="拖拽调整顺序 · 点击股票名称查看个股"
      className={`flex cursor-grab select-none items-center gap-1.5 rounded border border-[#e0d5c0] bg-[#faf6ee] px-1.5 py-[3px] transition-all active:cursor-grabbing ${
        dragging ? "opacity-40 ring-1 ring-[#d4943a]/50" : "hover:border-[#d4943a]/40"
      }`}
    >
      {/* 拖拽把手(固定宽, 与表头占位对齐) */}
      <span className="w-3 shrink-0 text-center text-[9px] leading-none text-[#c9b99a]">≡</span>
      {/* 名称: 点击打开个股小窗 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold text-[#1d4ed8] transition-colors hover:underline"
        title={`点击打开 ${name} 个股小窗`}
      >
        {name}
      </button>
      {/* 涨幅(固定列宽, 左对齐贴近名称) */}
      <span className={`w-12 shrink-0 text-left text-[10px] font-semibold ${quote ? clsChg(pct) : "text-[#a8987e]"}`} style={TNUM}>
        {quote ? fmtPct(pct) : "—"}
      </span>
      {/* 总金额(万元) */}
      <span className="w-12 shrink-0 text-left text-[10px] text-[#6b5b3e]" style={TNUM}>
        {quote?.amount ? fmtWan(quote.amount) : "—"}
      </span>
      {/* 主力净额(元) */}
      <span className={`w-16 shrink-0 text-left text-[10px] font-semibold ${netIn == null ? "text-[#a8987e]" : clsChg(netIn)}`} style={TNUM}>
        {netIn == null ? "—" : fmtYuan(netIn)}
      </span>
      {/* 删除: 同时从 mini自选 与自选股 中移除 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="从 mini自选 与自选股 中移除"
        className="w-3 shrink-0 rounded text-center text-[10px] font-bold leading-none text-[#b8533a] opacity-60 transition-opacity hover:bg-[#b8533a]/10 hover:opacity-100"
      >×</button>
    </div>
  );
}

/** mini自选: 自选股的单行紧凑视图 */
export function MiniWatchlistPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const { codes, addCode, removeCode } = useWatchlist();
  const { openStockDetail } = useStockDetail();
  const codesKey = codes.join(",");
  const enabled = codes.length > 0;

  /* ---------------- mini 独立顺序(本地持久化, 不影响自选股卡片顺序) ---------------- */
  const [miniOrder, setMiniOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(MINI_ORDER_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length) {
        return arr.filter((c) => typeof c === "string" && /^(sh|sz|bj)\d{6}$/.test(c));
      }
    } catch { /* 损坏则用自选股顺序 */ }
    return [...codes];
  });
  // codes 增删时同步 miniOrder: 已删除的移除, 新增的放头部(与头部添加一致)
  useEffect(() => {
    setMiniOrder((prev) => {
      const kept = prev.filter((c) => codes.includes(c));
      const added = codes.filter((c) => !kept.includes(c));
      return [...added, ...kept];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codesKey]);
  useEffect(() => {
    try { localStorage.setItem(MINI_ORDER_KEY, JSON.stringify(miniOrder)); } catch { /* ignore */ }
  }, [miniOrder]);

  /* ---------------- 数据(价格统一走报价中心 5s 单源; 大单净额 30s) ---------------- */
  const quotes = useQuotes(codes);
  const { data: flows } = useSharedPolling<StockFlow[] | null>(
    "mini:flows",
    () => (enabled ? api.stockFlows(codes).catch(() => null) : Promise.resolve(null)),
    30000
  );
  const flowMap = useMemo(() => new Map((flows || []).map((f) => [f.code, f])), [flows]);

  /* ---------------- 搜索添加(从自选股迁移, 共享列表 + 头部添加) ---------------- */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) { setResults([]); return; }
    let dead = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.stockSearch(q);
        if (!dead) setResults(r || []);
      } catch { if (!dead) setResults([]); }
      finally { if (!dead) setSearching(false); }
    }, 300);
    return () => { dead = true; clearTimeout(timer); };
  }, [query]);

  const handleAdd = (code: string) => {
    addCode(code); // 共享列表: 自选股同步添加(头部)
    setQuery("");
    setResults([]);
  };

  /* ---------------- 拖动排序(HTML5 DnD, 只改 mini 顺序) ---------------- */
  const dragFrom = useRef<string | null>(null);
  const [dragState, setDragState] = useState<string | null>(null);
  const handleDragStart = (e: React.DragEvent, code: string, name?: string) => {
    dragFrom.current = code;
    setDragState(code);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", code);
    // 附带个股名称(自定义 MIME): 供 PHILIA 搜索框作为放置目标时直接填入名称
    e.dataTransfer.setData("application/x-stock", JSON.stringify({ code, name: name || "" }));
  };
  const handleDragOver = (e: React.DragEvent, code: string) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (!from || from === code) return;
    e.dataTransfer.dropEffect = "move";
    setMiniOrder((cur) => {
      const i = cur.indexOf(from), j = cur.indexOf(code);
      if (i < 0 || j < 0 || i === j) return cur;
      const next = [...cur];
      next.splice(i, 1);
      next.splice(j, 0, from);
      return next;
    });
  };
  const endDrag = () => { dragFrom.current = null; setDragState(null); };

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="mini自选"
      icon="▤"
      accent="#d4943a"
      right={
        <div className="relative flex items-center gap-1.5">
          {/* 紧凑搜索框(标题右侧) */}
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索添加…"
              className="w-32 rounded border border-[#e0d5c0] bg-[#faf6ee] px-1.5 py-0.5 pr-6 text-[10px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
            />
            {searching && <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-[#a8987e]">…</span>}
            {/* 搜索结果下拉(向下展开) */}
            {results.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-30 mt-0.5 max-h-44 min-w-[200px] overflow-y-auto rounded border border-[#e0d5c0] bg-[#faf6ee] shadow-md">
                {results.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    onClick={() => handleAdd(s.code)}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[10px] transition-colors hover:bg-[#ede4d4]"
                  >
                    <span className="font-semibold text-[#6b5b3e]">{s.name}</span>
                    <span className="text-[#a8987e]" style={TNUM}>{s.code}</span>
                    {codes.includes(s.code) && <span className="ml-auto text-[9px] text-[#4a6b3f]">已添加</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-1.5">
        {codes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">
            暂无自选 — 在标题右侧搜索添加
          </div>
        ) : (
          <>
            {/* 表头(列宽与数据行一致, 滚动时固定) */}
            <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[#e0d5c0]/60 bg-[#faf6ee] px-1.5 pb-0.5 pt-0.5 text-[9px] text-[#a8987e]">
              <span className="w-3 shrink-0" />
              <span className="min-w-0 flex-1" />
              <span className="w-12 shrink-0 text-left">涨幅</span>
              <span className="w-12 shrink-0 text-left">总金额</span>
              <span className="w-16 shrink-0 text-left">主力净额</span>
            </div>
            {miniOrder.map((code) => {
              const q = quotes?.[code];
              return (
                <MiniRow
                  key={code}
                  code={code}
                  quote={q}
                  flow={flowMap.get(code.replace(/^(sh|sz|bj)/, "")) || flowMap.get(code)}
                  dragging={dragState === code}
                  onOpen={() => openStockDetail(code, q?.name || code.replace(/^(sh|sz|bj)/, ""))}
                  onRemove={() => removeCode(code)}
                  onDragStart={(e) => handleDragStart(e, code, q?.name)}
                  onDragOver={(e) => handleDragOver(e, code)}
                  onDrop={endDrag}
                  onDragEnd={endDrag}
                />
              );
            })}
          </>
        )}
      </div>
    </Panel>
  );
}
