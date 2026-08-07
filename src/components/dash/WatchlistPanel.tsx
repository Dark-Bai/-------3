/**
 * 自选股多股同列模块(原「市场情绪」位置)
 *
 * 功能:
 *  - 自选股管理: 搜索(代码/名称) + 添加 + 列表查看/删除, 顺序持久化到 localStorage
 *  - 股票卡片: 实时价格(1s) + 涨跌幅(红涨绿跌) + 成交额 + Level2 大单净额 + 迷你分时图(价格线+成交量柱) + 总市值
 *  - 卡片拖动排序(HTML5 DnD, 无外部依赖)
 *  - 多组轮询: 报价 1s / 分时 10s / 大单净额 30s / 市值 60s, 均批量请求 + 后端缓存, 不阻塞渲染
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type Quote, type MinuteData, type StockFlow, type StockSearchResult } from "@/lib/api";
import { bgChg, clsChg, fmtPct, fmtPrice, fmtWan, fmtYuan } from "@/lib/format";

/** 自选股持久化 key(与 commodity-treasury-order / dash:index-order 同风格) */
const WATCH_KEY = "dash:watchlist";
/** 默认示例自选(首次进入无数据时预置, 便于开箱即用) */
const DEFAULT_WATCH = ["sh600519", "sz300750", "sh601318"];

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 涨跌颜色: 涨红 / 跌绿(与全站一致) */
const hexChgV = (v: number) => (v > 0 ? "#b8533a" : v < 0 ? "#4a6b3f" : "#a8987e");

function loadWatch(): string[] {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length) {
      return arr.filter((c) => typeof c === "string" && /^(sh|sz|bj)\d{6}$/.test(c));
    }
  } catch { /* 损坏则用默认 */ }
  return [...DEFAULT_WATCH];
}

/** 迷你分时图: 价格线 + 面积 + 昨收基准线 + 成交量柱(A股 240 分钟时间轴) */
function MiniChart({ points, prec, width, height }: { points: { t: string; p: number; v?: number }[]; prec: number; width: number; height: number }) {
  const { line, area, refY, color, vols, xs } = useMemo(() => {
    if (!points || points.length < 2 || !prec) return { line: "", area: "", refY: 0, color: "#a8987e", vols: [], xs: [] };
    const OPEN = 9 * 60 + 30, LUNCH_S = 11 * 60 + 30, LUNCH_E = 13 * 60, SESSION = 240;
    const toMinute = (t: string) => {
      const s = t.includes(":") ? (t.trim().split(/\s+/).pop() ?? t) : t;
      if (s.includes(":")) { const [hh, mm] = s.split(":"); return parseInt(hh, 10) * 60 + parseInt(mm, 10); }
      return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2, 4), 10);
    };
    const xs = points.map((d) => {
      const m = toMinute(d.t);
      let e = m - OPEN;
      if (m >= LUNCH_E) e -= LUNCH_E - LUNCH_S;
      return (Math.max(0, Math.min(e, SESSION)) / SESSION) * (width - 4) + 2;
    });
    if (xs.some((x) => !Number.isFinite(x))) {
      points.forEach((_, i) => { xs[i] = 2 + (i / (points.length - 1)) * (width - 4); });
    }
    const ps = points.map((d) => d.p);
    let min = Math.min(...ps, prec), max = Math.max(...ps, prec);
    if (max - min < 1e-9) { max += 1; min -= 1; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    const Y = (v: number) => height - 3 - ((v - min) / (max - min)) * (height - 6);
    const last = ps[ps.length - 1];
    const color = hexChgV(last - prec);
    const line = points.map((d, i) => `${xs[i].toFixed(1)},${Y(d.p).toFixed(1)}`).join(" ");
    const area = `${xs[0].toFixed(1)},${height - 1} ${line} ${xs[xs.length - 1].toFixed(1)},${height - 1}`;
    const vols = points.map((d) => num0(d.v));
    return { line, area, refY: Y(prec), color, vols, xs };
  }, [points, prec, width, height]);

  if (!line) return <div className="flex items-center justify-center text-[10px] text-[#a8987e]" style={{ width, height }}>分时加载中…</div>;

  const maxVol = Math.max(...vols, 1);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block min-w-0">
      {/* 成交量柱(价格区下方, 时间轴上方; 高约 25%) */}
      {vols.map((v, i) => {
        if (v <= 0) return null;
        const bh = Math.max(1.5, (v / maxVol) * (height * 0.25));
        const by = height - bh;
        return <rect key={i} x={xs[i] - 0.4} y={by} width={0.9} height={bh} fill={color} opacity={0.28} />;
      })}
      <polygon points={area} fill={color} opacity={0.1} />
      <line x1={2} y1={refY} x2={width - 2} y2={refY} stroke="#c9b99a" strokeWidth={0.6} strokeDasharray="2,3" />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.1} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const num0 = (v: unknown) => { const n = parseFloat(String(v ?? 0)); return Number.isFinite(n) ? n : 0; };

/** 股票卡片 */
function WatchCard({
  code, quote, minute, flow, marketValue, dragging, onSelect, onRemove, onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  code: string; quote?: Quote; minute?: MinuteData; flow?: StockFlow; marketValue?: number;
  dragging: boolean; onSelect: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const pct = quote?.pct ?? 0;
  const netIn = flow?.netIn;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      title="拖拽调整顺序 · 点击查看详情"
      className={`group relative flex w-[212px] shrink-0 cursor-grab select-none flex-col gap-1 rounded border border-[#e0d5c0] bg-[#faf6ee] p-1.5 transition-all active:cursor-grabbing ${
        dragging ? "opacity-40 ring-2 ring-[#d4943a]/50" : "hover:border-[#d4943a]/50 hover:shadow-sm"
      }`}
    >
      {/* 删除按钮 */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="从自选股移除"
        className="absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-[#b8533a] text-[9px] font-bold text-white opacity-0 transition-opacity hover:bg-[#a33c2a] group-hover:opacity-100"
      >
        ×
      </button>

      {/* 头部: 名称 + 代码 */}
      <div className="flex items-baseline gap-1">
        <span className="truncate text-[12px] font-bold text-[#4a3b28]">{quote?.name || code.replace(/^(sh|sz|bj)/, "")}</span>
        <span className="shrink-0 text-[9px] text-[#a8987e]" style={TNUM}>{code}</span>
      </div>

      {/* 价格 + 涨跌幅 */}
      <div className="flex items-center gap-1.5">
        <span className={`text-[20px] font-bold leading-none ${quote ? clsChg(pct) : "text-[#a8987e]"}`} style={TNUM}>
          {quote ? fmtPrice(quote.price) : "—"}
        </span>
        <span className={`rounded px-1 py-px text-[11px] font-bold ${quote ? bgChg(pct) : ""}`} style={TNUM}>
          {quote ? fmtPct(pct) : ""}
        </span>
      </div>

      {/* 指标行: 成交额 / 大单净额 / 总市值 */}
      <div className="grid grid-cols-3 gap-x-1 border-t border-[#e0d5c0]/60 pt-1 text-[9px]">
        <div>
          <div className="text-[#a8987e]">成交额</div>
          <div className="font-semibold text-[#6b5b3e]" style={TNUM}>{quote?.amount ? fmtWan(quote.amount) : "—"}</div>
        </div>
        <div>
          <div className="text-[#a8987e]">大单净额</div>
          <div className={`font-semibold ${netIn == null ? "text-[#a8987e]" : clsChg(netIn)}`} style={TNUM}>
            {netIn == null ? "—" : fmtYuan(netIn)}
          </div>
        </div>
        <div>
          <div className="text-[#a8987e]">总市值</div>
          <div className="font-semibold text-[#6b5b3e]" style={TNUM}>{marketValue ? fmtYuan(marketValue) : "—"}</div>
        </div>
      </div>

      {/* 迷你分时图(价格线 + 成交量柱) */}
      <div className="rounded bg-[#f5f0e6]/70 p-0.5">
        <MiniChart points={minute?.points ?? []} prec={minute?.prec ?? 0} width={196} height={52} />
      </div>
    </div>
  );
}

export function WatchlistPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  /* ---------------- 自选股列表(本地持久化) ---------------- */
  const [codes, setCodes] = useState<string[]>(loadWatch);
  useEffect(() => {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(codes)); } catch { /* ignore */ }
  }, [codes]);
  const codesKey = codes.join(",");
  const enabled = codes.length > 0;

  /* ---------------- 数据轮询(批量, 不同频率) ---------------- */
  // 报价 1s(后端 1.5s 缓存, 有效数据时效 ≤1.5s)
  const { data: quotes } = usePolling(
    () => (enabled ? api.quotes(codes).catch(() => null) : Promise.resolve(null)),
    1000,
    [codesKey],
    (a, b) => {
      if (!a || !b) return a === b;
      return codes.every((c) => { const x = a[c], y = b[c]; return !x || !y || (x.price === y.price && x.pct === y.pct); });
    },
    enabled
  );
  // 分时 10s(含成交量, 后端 5s 缓存)
  const { data: minutes } = usePolling(
    () => (enabled ? api.minutes(codes).catch(() => null) : Promise.resolve(null)),
    10000,
    [codesKey],
    undefined,
    enabled
  );
  // Level2 大单净额 30s(批量 /api/stock-flows, 后端 30s 缓存)
  const { data: flows } = usePolling(
    () => (enabled ? api.stockFlows(codes).catch(() => null) : Promise.resolve(null)),
    30000,
    [codesKey],
    undefined,
    enabled
  );
  // 总市值 60s(逐只 /api/stock-quote, 后端 10s 缓存; 市值日内低频变化)
  const { data: details } = usePolling(
    () => (enabled ? Promise.all(codes.map((c) => api.stockQuote(c).catch(() => null))) : Promise.resolve(null)),
    60000,
    [codesKey],
    undefined,
    enabled
  );

  const flowMap = useMemo(() => new Map((flows || []).map((f) => [f.code, f])), [flows]);
  const detailMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of details || []) if (d?.code && d.marketValue > 0) m.set(d.code, d.marketValue);
    return m;
  }, [details]);

  /* ---------------- 搜索添加 ---------------- */
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showManage, setShowManage] = useState(false);
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

  const addCode = (code: string) => {
    if (!/^(sh|sz|bj)\d{6}$/.test(code)) return;
    setCodes((cur) => (cur.includes(code) ? cur : [...cur, code]));
    setQuery("");
    setResults([]);
  };
  const removeCode = (code: string) => setCodes((cur) => cur.filter((c) => c !== code));

  /* ---------------- 拖动排序(HTML5 DnD) ---------------- */
  const dragFrom = useRef<string | null>(null);
  const [dragState, setDragState] = useState<string | null>(null);
  const handleDragStart = (e: React.DragEvent, code: string) => {
    dragFrom.current = code;
    setDragState(code);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", code);
  };
  const handleDragOver = (e: React.DragEvent, code: string) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (!from || from === code) return;
    e.dataTransfer.dropEffect = "move";
    setCodes((cur) => {
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
    <Panel className={className} {...zoomProps} title="自选股" icon="☆" accent="#d4943a">
      <div className="flex h-full min-h-0 flex-col p-2">
        {/* 顶部工具条: 搜索 + 管理 */}
        <div className="mb-1.5 flex shrink-0 flex-wrap items-center gap-1.5">
          <div className="relative min-w-0 flex-1 max-w-[280px]">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索股票(代码/名称)添加自选…"
              className="w-full rounded border border-[#e0d5c0] bg-[#faf6ee] px-2 py-1 pr-7 text-[11px] text-[#6b5b3e] outline-none transition-colors placeholder:text-[#c9b99a] focus:border-[#d4943a]/70"
            />
            {searching && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#a8987e]">…</span>}
            {/* 搜索结果下拉 */}
            {results.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-20 mt-0.5 max-h-48 overflow-y-auto rounded border border-[#e0d5c0] bg-[#faf6ee] shadow-md">
                {results.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    onClick={() => addCode(s.code)}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors hover:bg-[#ede4d4]"
                  >
                    <span className="font-semibold text-[#6b5b3e]">{s.name}</span>
                    <span className="text-[#a8987e]" style={TNUM}>{s.code}</span>
                    {codes.includes(s.code) && <span className="ml-auto text-[9px] text-[#4a6b3f]">已添加</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowManage((v) => !v)}
            title="查看/管理自选股列表"
            className="rounded border border-[#d4943a]/40 px-1.5 py-1 text-[10px] text-[#d4943a] transition-colors hover:bg-[#d4943a]/10"
          >
            管理 {codes.length} 只
          </button>
          <span className="ml-auto text-[9px] text-[#a8987e]">拖动卡片排序 · 1s 刷新</span>
        </div>

        {/* 管理列表视图 */}
        {showManage && (
          <div className="mb-1.5 shrink-0 rounded border border-[#e0d5c0] bg-[#f5f0e6]/50 p-1.5">
            <div className="mb-1 text-[10px] font-semibold text-[#8b7a5e]">自选股列表({codes.length})</div>
            <div className="flex flex-wrap gap-1">
              {codes.length === 0 && <span className="text-[10px] text-[#a8987e]">暂无自选, 在上方搜索添加</span>}
              {codes.map((c) => (
                <span key={c} className="flex items-center gap-1 rounded border border-[#e0d5c0] bg-[#faf6ee] px-1.5 py-0.5 text-[10px] text-[#6b5b3e]">
                  {quotes?.[c]?.name || c.replace(/^(sh|sz|bj)/, "")}
                  <span className="text-[#a8987e]" style={TNUM}>{c}</span>
                  <button
                    type="button"
                    onClick={() => removeCode(c)}
                    title="移除"
                    className="text-[#b8533a] hover:font-bold"
                  >×</button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 卡片区 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {codes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[12px] text-[#a8987e]">
              自选股为空 — 在上方搜索股票并添加
            </div>
          ) : (
            <div className="flex flex-wrap content-start gap-1.5">
              {codes.map((code) => (
                <WatchCard
                  key={code}
                  code={code}
                  quote={quotes?.[code]}
                  minute={minutes?.[code]}
                  flow={flowMap.get(code.replace(/^(sh|sz|bj)/, "")) || flowMap.get(code)}
                  marketValue={detailMap.get(code)}
                  dragging={dragState === code}
                  onSelect={() => { /* 预留: 点击打开个股详情 */ }}
                  onRemove={() => removeCode(code)}
                  onDragStart={(e) => handleDragStart(e, code)}
                  onDragOver={(e) => handleDragOver(e, code)}
                  onDrop={endDrag}
                  onDragEnd={endDrag}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
