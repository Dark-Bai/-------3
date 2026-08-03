import { Panel, type PanelZoomProps } from "./Panel";
import { Spark } from "./Spark";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes, type HubQuote } from "@/lib/market";
import { api, type MinuteData } from "@/lib/api";
import { INDICES, type IndexDef } from "@/config/dashboard";
import { bgChg, clsChg, fmtPct, fmtPrice, fmtWan } from "@/lib/format";

const CN_CODES = INDICES.filter((d) => d.region === "CN").map((i) => i.code);
const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

function IndexRow({ def, q, minute }: { def: IndexDef; q?: HubQuote; minute?: MinuteData }) {
  return (
    <div className="flex flex-1 items-center gap-1.5 rounded px-1 transition-colors hover:bg-[#ede4d4]">
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
          <Spark points={minute.points} prec={minute.prec} width={120} height={16} fluid session="ashare" />
        )}
      </span>
      <span className="hidden w-[52px] shrink-0 text-right text-[9px] text-[#a8987e] xl:block" style={TNUM}>
        {q?.amount ? fmtWan(q.amount) : ""}
      </span>
    </div>
  );
}

export function IndexPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const quotes = useQuotes(CN_CODES);
  const { data: minutes } = usePolling(
    async () => {
      const results = await Promise.allSettled(CN_CODES.map((c) => api.minute(c)));
      const map: Record<string, MinuteData> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled") map[CN_CODES[i]] = r.value;
      });
      return map;
    },
    15000
  );

  return (
    <Panel className={className} {...zoomProps} title="A股关键指数" icon="▦" accent="#d4943a"
      right={<span className="text-[10px] text-[#a8987e]">5s</span>}>
      <div className="flex h-full flex-col overflow-y-auto p-1">
        <div className="px-1 pb-0.5 pt-1 text-[9px] font-medium uppercase tracking-widest text-[#a8987e]">A股</div>
        {INDICES.filter((d) => d.region === "CN").map((d) => (
          <IndexRow key={d.code} def={d} q={quotes?.[d.code]} minute={minutes?.[d.code]} />
        ))}
      </div>
    </Panel>
  );
}
