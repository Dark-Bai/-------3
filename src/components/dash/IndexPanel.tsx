import { Panel, type PanelZoomProps } from "./Panel";
import { Spark } from "./Spark";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes, type HubQuote } from "@/lib/market";
import { api, type MinuteData } from "@/lib/api";
import { INDICES, FOREX, type IndexDef } from "@/config/dashboard";
import { bgChg, clsChg, fmtPct, fmtPrice, fmtWan } from "@/lib/format";

const ALL_CODES = [...INDICES.map((i) => i.code), ...FOREX.map((i) => i.code)];
const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

function IndexRow({ def, q, minute }: { def: IndexDef; q?: HubQuote; minute?: MinuteData }) {
  return (
    <div className="flex items-center gap-1.5 rounded px-1 py-[1.5px] transition-colors hover:bg-[#ede4d4]">
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
          // A股按交易时段映射; 港/美/汇率交易时段不同, 用连续交易时间轴
          <Spark points={minute.points} prec={minute.prec} width={120} height={16} fluid session={def.region === "CN" ? "ashare" : "h24"} />
        )}
      </span>
      <span className="hidden w-[52px] shrink-0 text-right text-[9px] text-[#a8987e] xl:block" style={TNUM}>
        {q?.amount && !def.code.startsWith("us") ? fmtWan(q.amount) : ""}
      </span>
    </div>
  );
}

export function IndexPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  // 指数报价: 统一报价中心(与 Tape 等所有面板同帧)
  const quotes = useQuotes(ALL_CODES);
  const { data: minutes } = usePolling(
    async () => {
      const codes = ALL_CODES.filter((c) => !c.startsWith("wh"));
      const results = await Promise.allSettled(codes.map((c) => api.minute(c)));
      const map: Record<string, MinuteData> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled") map[codes[i]] = r.value;
      });
      return map;
    },
    15000
  );

  const groups = [
    { name: "A股", defs: INDICES.filter((d) => d.region === "CN") },
    { name: "港股 · 美股 · 汇率", defs: [...INDICES.filter((d) => d.region !== "CN"), ...FOREX] },
  ];

  return (
    <Panel className={className} {...zoomProps} title="全球关键指数" icon="▦" accent="#d4943a"
      right={<span className="text-[10px] text-[#a8987e]">5s</span>}>
      <div className="flex h-full flex-col justify-between overflow-y-auto p-1">
        {groups.map((g) => (
          <div key={g.name}>
            <div className="px-1 pb-0.5 pt-1 text-[9px] font-medium uppercase tracking-widest text-[#a8987e]">{g.name}</div>
            {g.defs.map((d) => (
              <IndexRow key={d.code} def={d} q={quotes?.[d.code]} minute={minutes?.[d.code]} />
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}
