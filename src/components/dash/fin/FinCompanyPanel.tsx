import { useEffect, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "../Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type StockSearchResult } from "@/lib/api";
import { useFin } from "./FinContext";
import { SkeletonRows } from "./SkeletonRows";
import { TNUM, fmtYi, prefixCode, quarterLabel } from "./utils";

const pctCls = (v: number) => (v > 0 ? "text-[#b8533a]" : v < 0 ? "text-[#4a6b3f]" : "text-[#8b7a5e]");

/** 公司财报: 搜索框 + 最近查看 chips + 最新报告期指标卡 2×3 */
export function FinCompanyPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const { company, recent, select } = useFin();
  const [retry, setRetry] = useState(0);
  const { data, error, loading } = usePolling(() => api.financeMain(company.code), 1800000, [company.code, retry]);

  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<StockSearchResult[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 点击外部关闭候选
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setShowSuggest(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const triggerSearch = (val: string) => {
    setInput(val);
    clearTimeout(timerRef.current);
    const t = val.trim();
    if (t.length < 1) {
      setSuggestions([]);
      setShowSuggest(false);
      return;
    }
    timerRef.current = setTimeout(async () => {
      try {
        const res = await api.stockSearch(t);
        setSuggestions(res.slice(0, 8));
        setShowSuggest(res.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 200);
  };

  const pick = (code: string, name: string) => {
    select(prefixCode(code), name);
    setInput("");
    setSuggestions([]);
    setShowSuggest(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      if (suggestions.length > 0) pick(suggestions[0].code, suggestions[0].name);
      else if (/^(sh|sz|bj)?\d{6}$/i.test(input.trim())) pick(input.trim(), input.trim());
    } else if (e.key === "Escape") {
      setShowSuggest(false);
    }
  };

  const r0 = data?.reports?.[0];
  const displayName = data?.name || company.name;

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="公司财报"
      icon="◈"
      accent="#d4943a"
      right={<span className="max-w-[110px] truncate text-[10px] text-[#d4943a]">{displayName}</span>}
    >
      <div className="flex h-full min-h-0 flex-col gap-1 p-1.5">
        {/* 搜索框 */}
        <div ref={boxRef} className="relative shrink-0">
          <input
            value={input}
            onChange={(e) => triggerSearch(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length > 0 && setShowSuggest(true)}
            placeholder="输入代码/名称"
            className="h-[24px] w-full rounded bg-[#ede4d4] px-2 text-[11px] text-[#6b5b3e] placeholder:text-[9px] placeholder:text-[#a8987e] focus:outline-none focus:ring-1 focus:ring-[#d4943a]/50"
          />
          {showSuggest && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-[26px] z-20 overflow-hidden rounded border border-[#e0d5c0] bg-[#faf6ee] shadow-lg">
              {suggestions.map((s) => (
                <button
                  key={s.code}
                  onClick={() => pick(s.code, s.name)}
                  className="flex h-[22px] w-full items-center gap-2 px-2 text-left hover:bg-[#ede4d4]"
                >
                  <span className="w-[62px] shrink-0 text-[9px] text-[#a8987e]" style={TNUM}>
                    {s.code}
                  </span>
                  <span className="truncate text-[11px] text-[#6b5b3e]">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 最近查看 chips: 单行 18px */}
        {recent.length > 0 && (
          <div className="flex h-[18px] shrink-0 flex-nowrap items-center gap-1 overflow-hidden">
            {recent.map((c) => (
              <button
                key={c.code}
                onClick={() => select(c.code, c.name)}
                className={`shrink-0 rounded border px-1.5 text-[9px] leading-[14px] ${
                  c.code === company.code
                    ? "border-[#d4943a]/60 bg-[#d4943a]/10 text-[#d4943a]"
                    : "border-[#e0d5c0] text-[#8b7a5e] hover:border-[#a8987e] hover:text-[#6b5b3e]"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        {/* 指标卡区: 3列×3行, 卡高 32px */}
        {!company.code ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[#a8987e]">
            ← 从榜单或搜索选入公司
          </div>
        ) : !data ? (
          loading ? (
            <SkeletonRows rows={6} />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center text-[11px]">
              <button className="h-full w-full text-[#a8987e]" onClick={() => setRetry((r) => r + 1)}>
                数据获取失败，点击重试{error ? `(${error})` : ""}
              </button>
            </div>
          )
        ) : !r0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-[11px] text-[#a8987e]">暂无财报数据</div>
        ) : (
          <>
            <div className="flex shrink-0 items-center justify-between px-0.5 text-[9px] text-[#a8987e]">
              <span>
                报告期 <span className="text-[#8b7a5e]">{quarterLabel(r0.date) || r0.label}</span>
              </span>
              <span>
                {data.name.length > 8 ? data.name.slice(0, 8) + "…" : data.name}
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-3 content-start gap-1">
              <Card label="营收" value={fmtYi(r0.revenue)} sub={`${r0.revenueYoY > 0 ? "+" : ""}${r0.revenueYoY.toFixed(1)}%`} subCls={pctCls(r0.revenueYoY)} />
              <Card label="净利" value={fmtYi(r0.netProfit)} sub={`${r0.profitYoY > 0 ? "+" : ""}${r0.profitYoY.toFixed(1)}%`} subCls={pctCls(r0.profitYoY)} />
              <Card label="ROE" value={`${r0.roe.toFixed(1)}%`} />
              <Card label="EPS" value={r0.eps.toFixed(2)} />
              <Card label="毛利率" value={`${r0.grossMargin.toFixed(0)}%`} />
              <Card label="净利率" value={`${r0.netMargin.toFixed(0)}%`} />
              <Card label="资产负债率" value={`${r0.debtRatio.toFixed(1)}%`} />
              <Card label="ROIC" value={`${r0.roic.toFixed(1)}%`} />
              <Card label="每股OCF" value={r0.ocfPerShare.toFixed(2)} />
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function Card({ label, value, sub, subCls }: { label: string; value: string; sub?: string; subCls?: string }) {
  return (
    <div className="flex h-[32px] min-w-0 flex-col justify-between rounded bg-[#ede4d4] px-1.5 py-1">
      <div className="text-[8.5px] leading-[10px] text-[#a8987e]">{label}</div>
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[12px] font-semibold text-[#6b5b3e]" style={TNUM}>
          {value}
        </span>
        {sub && (
          <span className={`shrink-0 text-[8.5px] ${subCls ?? "text-[#a8987e]"}`} style={TNUM}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}
