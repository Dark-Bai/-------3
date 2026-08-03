import { Panel, type PanelZoomProps } from "./Panel";
import { Spark } from "./Spark";
import { usePolling } from "@/hooks/usePolling";
import { useQuotes } from "@/lib/market";
import { api, type MinuteData } from "@/lib/api";
import { COMMODITIES } from "@/config/dashboard";
import { clsChg, fmtPct, fmtPrice } from "@/lib/format";

/** 大宗商品纵向紧凑面板:金 / 银 / 铜 / 油 / 沪金 / BTC */
export function CommodityPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  // 报价: 统一报价中心(与 Tape / 商品页同帧)
  const data = useQuotes(COMMODITIES.map((c) => c.code));
  const { data: minutes } = usePolling(
    async () => {
      const results = await Promise.allSettled(COMMODITIES.map((c) => api.futureMinute(c.code)));
      const map: Record<string, MinuteData> = {};
      results.forEach((r, i) => {
        if (r.status === "fulfilled") map[COMMODITIES[i].code] = r.value;
      });
      return map;
    },
    60000
  );

  return (
    <Panel className={className} {...zoomProps} title="大宗商品" icon="◆" accent="#f5c542"
      right={<span className="text-[10px] text-[#a8987e]">10s</span>}>
      <div className="flex h-full flex-col divide-y divide-slate-800/60">
        {COMMODITIES.map((c) => {
          const q = data?.[c.code];
          const m = minutes?.[c.code];
          return (
            <div key={c.code} className="relative flex min-h-0 flex-1 items-center justify-between gap-2 px-2.5 transition-colors hover:bg-slate-800/30">
              <div className="absolute left-0 top-0 h-full w-[3px]" style={{ background: c.accent, opacity: 0.55 }} />
              <div className="w-[92px] shrink-0">
                <div className="text-[11px] font-medium text-[#6b5b3e]">{c.label}</div>
                <div className="text-[9px] text-[#a8987e]">{c.unit}</div>
              </div>
              <div className="flex min-w-0 flex-1 items-center justify-center">
                {m && m.points.length > 1 && <Spark points={m.points} prec={m.prec} width={100} height={22} fluid emptyLabel="—" session="h24" />}
              </div>
              <div className="w-[84px] shrink-0 text-right">
                <div className={`text-[12px] font-semibold leading-5 ${q ? clsChg(q.pct) : "text-[#a8987e]"}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {q ? fmtPrice(q.price) : "——"}
                </div>
                <div className={`text-[10px] font-semibold ${q ? clsChg(q.pct) : ""}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {q ? fmtPct(q.pct) : ""}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
