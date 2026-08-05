import { useEffect, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { Spark } from "./Spark";
import { MinuteChart } from "./MinuteChart";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes, type HubQuote } from "@/lib/market";
import { api, type MinuteData } from "@/lib/api";
import { INDICES, type IndexDef } from "@/config/dashboard";
import { bgChg, clsChg, fmtPct, fmtPrice, fmtWan } from "@/lib/format";

// A股关键指数: 上证/深证/创业板/科创50/沪深300 + 恒生指数/恒生科技/纳斯达克
const CN_CODES = [
  "sh000001", "sz399001", "sz399006", "sh000688", "sh000300",
  "hkHSI", "hkHSTECH", "usIXIC",
];
const CN_DEFS = CN_CODES.map((c) => INDICES.find((d) => d.code === c)).filter(Boolean) as IndexDef[];
const TNUM = { fontVariantNumeric: "tabular-nums" } as const;
const SESSION_OF = (region: string) => (region === "HK" || region === "US" ? "h24" : "ashare") as "ashare" | "h24";

/** 底部紧凑指数列表行: 点击切换主分时图 */
function IndexListRow({
  def, q, minute, active, onSelect,
}: { def: IndexDef; q?: HubQuote; minute?: MinuteData; active: boolean; onSelect: () => void }) {
  const session = SESSION_OF(def.region);
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors ${
        active ? "bg-[#e8dcc4] ring-1 ring-[#d4943a]/40" : "hover:bg-[#ede4d4]"
      }`}
    >
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
  // 选中展示大分时图的指数(默认上证), 仅当订阅数据缺失时回退第一个
  const [active, setActive] = useState(CN_CODES[0]);
  useEffect(() => {
    if (!CN_DEFS.find((d) => d.code === active)) setActive(CN_CODES[0]);
  }, [active]);

  const activeDef = CN_DEFS.find((d) => d.code === active) ?? CN_DEFS[0];
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
          {CN_DEFS.map((d) => (
            <IndexListRow
              key={d.code}
              def={d}
              q={quotes?.[d.code]}
              minute={minutes?.[d.code]}
              active={d.code === activeDef.code}
              onSelect={() => setActive(d.code)}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
}