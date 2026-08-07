import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { Spark } from "./Spark";
import { MinuteChart } from "./MinuteChart";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes, type HubQuote } from "@/lib/market";
import { api, type MinuteData } from "@/lib/api";
import { INDICES, type IndexDef } from "@/config/dashboard";
import { bgChg, clsChg, fmtPct, fmtPrice, fmtWan } from "@/lib/format";

// A股关键指数: 上证/深证/创业板/科创50/沪深300 + 恒生指数/恒生科技/纳斯达克 + 日经225/韩国KOSPI
const CN_CODES = [
  "sh000001", "sz399001", "sz399006", "sh000688", "sh000300",
  "hkHSI", "hkHSTECH", "usIXIC",
  "usN225", "usKS11",
];
const TNUM = { fontVariantNumeric: "tabular-nums" } as const;
const SESSION_OF = (region: string) => (region === "HK" || region === "US" ? "h24" : "ashare") as "ashare" | "h24";
// 指数拖动排序持久化 key(localStorage), 与 commodity-treasury-order 同风格
const INDEX_ORDER_KEY = "dash:index-order";

/** 读取持久化的指数顺序: 过滤非法/缺失代码并补全默认项; 未配置/损坏时返回默认 CN_CODES */
function loadIndexOrder(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_ORDER_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(arr)) return [...CN_CODES];
    const known = new Set(CN_CODES);
    const ordered = arr.filter((c) => typeof c === "string" && known.has(c));
    for (const c of CN_CODES) if (!ordered.includes(c)) ordered.push(c);
    return ordered;
  } catch {
    return [...CN_CODES];
  }
}

/** 底部紧凑指数列表行: 拖拽调整顺序(HTML5 DnD) + 点击切换主分时图 */
function IndexListRow({
  def, q, minute, active, onSelect, dragging, onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  def: IndexDef; q?: HubQuote; minute?: MinuteData; active: boolean; onSelect: () => void;
  dragging?: boolean;
  onDragStart?: (e: DragEvent<HTMLButtonElement>) => void;
  onDragOver?: (e: DragEvent<HTMLButtonElement>) => void;
  onDrop?: (e: DragEvent<HTMLButtonElement>) => void;
  onDragEnd?: () => void;
}) {
  const session = SESSION_OF(def.region);
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      title="拖拽调整指数顺序 · 点击切换分时图"
      className={`group flex w-full select-none items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors ${
        active ? "bg-[#e8dcc4] ring-1 ring-[#d4943a]/40" : "hover:bg-[#ede4d4]"
      } ${dragging ? "opacity-40" : ""}`}
    >
      <span className="w-2.5 shrink-0 cursor-grab select-none text-center text-[8px] leading-3 text-[#c9b99a] opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing">⠿</span>
      <span className="w-5 shrink-0 rounded-sm bg-[#e0d5c0] text-center text-[8px] leading-3 text-[#8b7a5e]">{def.region}</span>
      <span className={`w-[58px] shrink-0 truncate text-[11px] ${active ? "font-semibold text-[#6b5b3e]" : "text-[#6b5b3e]"}`}>{def.label}</span>
      <span className={`w-[54px] shrink-0 text-right text-[11px] font-bold ${q ? clsChg(q.pct) : "text-[#a8987e]"}`} style={TNUM}>
        {q ? fmtPrice(q.price) : "—"}
      </span>
      <span className={`w-[42px] shrink-0 rounded px-0.5 text-right text-[10px] font-semibold ${q ? bgChg(q.pct) : ""}`} style={TNUM}>
        {q ? fmtPct(q.pct) : ""}
      </span>
      <span className="hidden min-w-0 flex-1 items-center px-1 md:flex">
        {minute && minute.points.length > 1 && minute.prec > 0 && (
          <Spark points={minute.points} prec={minute.prec} width={70} height={14} fluid session={session} emptyLabel="—" />
        )}
      </span>
      <span className="hidden w-[46px] shrink-0 text-right text-[9px] text-[#a8987e] xl:block" style={TNUM}>
        {q?.amount ? fmtWan(q.amount) : ""}
      </span>
    </button>
  );
}

export function IndexPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const quotes = useQuotes(CN_CODES);
  const { data: minutes } = usePolling(
    async () => (await api.minutes(CN_CODES)) || {},
    10000
  );
  // 指数顺序: 支持拖动重排并持久化到 localStorage(HTML5 Drag and Drop, 无外部依赖)
  const [order, setOrder] = useState<string[]>(loadIndexOrder);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const orderedDefs = useMemo(
    () => order.map((c) => INDICES.find((d) => d.code === c)).filter(Boolean) as IndexDef[],
    [order]
  );
  // 排序持久化: 每次拖动重排后落盘
  useEffect(() => {
    try { localStorage.setItem(INDEX_ORDER_KEY, JSON.stringify(order)); } catch { /* 隐私模式等场景忽略 */ }
  }, [order]);

  // 拖拽重排: 拖起记录源代码, 悬停目标即时插入(实时重排, 视觉无滞后)
  const handleDragStart = (e: DragEvent<HTMLButtonElement>, code: string) => {
    setDragFrom(code);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", code);
  };
  const handleDragOver = (e: DragEvent<HTMLButtonElement>, code: string) => {
    e.preventDefault();
    if (!dragFrom || dragFrom === code) return;
    e.dataTransfer.dropEffect = "move";
    setOrder((cur) => {
      const i = cur.indexOf(dragFrom);
      const j = cur.indexOf(code);
      if (i < 0 || j < 0 || i === j) return cur;
      const next = [...cur];
      next.splice(i, 1);
      next.splice(j, 0, dragFrom);
      return next;
    });
  };
  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragFrom(null);
  };
  const handleDragEnd = () => setDragFrom(null);

  // 选中展示大分时图的指数(默认上证), 仅当订阅数据缺失时回退第一个
  const [active, setActive] = useState(CN_CODES[0]);
  useEffect(() => {
    if (!orderedDefs.find((d) => d.code === active)) setActive(orderedDefs[0]?.code ?? CN_CODES[0]);
  }, [active, orderedDefs]);

  const activeDef = orderedDefs.find((d) => d.code === active) ?? orderedDefs[0];
  const activeQ = quotes?.[activeDef.code];
  const activeMinute = minutes?.[activeDef.code];
  const session = SESSION_OF(activeDef.region);

  // 大分时图高度自适应: 测量图表容器可用高度(减去 MinuteChart 内部 mt-8 悬停框预留),
  // 避免固定高度溢出面板, 同时保证图表填满可用空间
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const [chartH, setChartH] = useState(160);
  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0].contentRect.height;
      if (h > 40) setChartH(Math.max(60, Math.round(h) - 32)); // -32 = mt-8
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <Panel className={className} {...zoomProps} title="A股关键指数" icon="▦" accent="#d4943a"
      right={<span className="text-[10px] text-[#a8987e]">10s</span>}>
      <div className="flex h-full flex-col overflow-hidden p-1">
        {/* 主分时图区: 选中指数的大图(坐标轴+悬停), flex-[1.4] 优先分配高度给图表 */}
        <div className="flex min-h-[60px] flex-[1.4] flex-col px-1 pt-1">
          <div className="flex shrink-0 items-center gap-1.5 px-1 pb-1">
            <span className="rounded-sm bg-[#d4943a]/15 px-1.5 py-px text-[9px] font-medium text-[#b07a2a]">{activeDef.region}</span>
            <span className="text-[12px] font-semibold text-[#6b5b3e]">{activeDef.label}</span>
            <span className={`text-[13px] font-bold ${activeQ ? clsChg(activeQ.pct) : "text-[#a8987e]"}`} style={TNUM}>
              {activeQ ? fmtPrice(activeQ.price) : "—"}
            </span>
            <span className={`rounded px-1 text-[10px] font-semibold ${activeQ ? bgChg(activeQ.pct) : ""}`} style={TNUM}>
              {activeQ ? fmtPct(activeQ.pct) : ""}
            </span>
            <span className="ml-auto hidden text-[9px] text-[#a8987e] sm:block" style={TNUM}>
              {activeQ?.amount ? `成交 ${fmtWan(activeQ.amount)}` : ""}
            </span>
          </div>
          <div ref={chartWrapRef} className="min-h-0 flex-1">
            {activeMinute && activeMinute.points.length > 1 && activeMinute.prec > 0 ? (
              <MinuteChart points={activeMinute.points} prec={activeMinute.prec} height={chartH} session={session} />
            ) : (
              <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">分时数据加载中…</div>
            )}
          </div>
        </div>
        {/* 底部指数列表: 点击切换主图 */}
        <div className="flex shrink-0 flex-col gap-px overflow-y-auto overflow-x-hidden border-t border-[#e0d5c0] pt-1"
          style={{ flex: "0 0 auto", maxHeight: "38%" }}>
          {orderedDefs.map((d) => (
            <IndexListRow
              key={d.code}
              def={d}
              q={quotes?.[d.code]}
              minute={minutes?.[d.code]}
              active={d.code === activeDef.code}
              onSelect={() => setActive(d.code)}
              dragging={dragFrom === d.code}
              onDragStart={(e) => handleDragStart(e, d.code)}
              onDragOver={(e) => handleDragOver(e, d.code)}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
}