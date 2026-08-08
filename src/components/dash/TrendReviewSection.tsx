/**
 * 趋势波段复盘 · 三段式 UI(大盘与波段环境 / 主线板块与趋势方向 / 趋势标的池)
 *
 * 由 MarketReviewSection 在「趋势波段模式」(技能仅选 qushi-boduan)时渲染,
 * 对应后端 buildTrendPrompt 的三段式 JSON 输出。精炼卡片风格, 适配报纸版式。
 * 同时导出 StockAdviceView(个股意见), 供标题栏「查收」独立小窗复用。
 */
import type { ReactNode } from "react";
import type { PhiliaMarketAnalysisResult, PhiliaStockAdvice, PhiliaTrendStock } from "@/lib/api";

/** 金融标的蓝色标注 */
const TARGET_COLOR = "#1d4ed8";
/** 仓位四级配色 */
const POS_LEVEL_STYLE: Record<string, { color: string; bg: string }> = {
  小: { color: "#3f7d3f", bg: "#e6f2e6" },
  中: { color: "#b8860b", bg: "#faf3d9" },
  大: { color: "#d4943a", bg: "#f8ead0" },
  满: { color: "#b8533a", bg: "#f7e3dc" },
};
/** 阶段配色 */
const STAGE_COLOR: Record<string, string> = { 启动: "#4a6b3f", 发酵: "#d4943a", 高潮: "#b8533a", 退潮: "#8b7a5e" };
/** 资金持续性配色 */
const CAPITAL_COLOR: Record<string, string> = { 持续流入: "#4a6b3f", 回流: "#d4943a", 退潮: "#b8533a" };

function PosTag({ v }: { v?: string }) {
  const s = (v || "").trim();
  if (!s) return null;
  const st = POS_LEVEL_STYLE[s] || POS_LEVEL_STYLE["小"];
  return (
    <span className="rounded px-1 py-px text-[10px] font-bold" style={{ color: st.color, background: st.bg }}>
      仓位 {s}
    </span>
  );
}

/** 蓝色高亮标的名(可点击唤起同花顺) */
function HighlightName({ name, code, onOpenStock }: { name: string; code?: string; onOpenStock?: (c: string) => void }) {
  const clickable = !!code && !!onOpenStock;
  return (
    <span
      style={{ color: TARGET_COLOR, fontWeight: 600 }}
      onClick={clickable ? (e) => { e.stopPropagation(); onOpenStock!(code!); } : undefined}
      title={clickable ? `单击在同花顺中打开 ${name}` : undefined}
      className={clickable ? "cursor-pointer select-none hover:underline" : undefined}
    >
      {name}
    </span>
  );
}

/** 个股意见内容(供独立小窗展示) */
export function StockAdviceView({ advice, nameToCode, onOpenStock }: { advice: PhiliaStockAdvice; nameToCode?: Record<string, string>; onOpenStock?: (c: string) => void }) {
  const rows: { label: string; value: ReactNode }[] = [];
  // 顶部「标的」卡: 股票名称 + 建议仓位 + 风险提示 合并展示(风险提示用红色强调)
  if (advice.stock || advice.positionAdvice || advice.risk) {
    rows.push({
      label: "标的",
      value: (
        <div className="flex flex-col gap-1">
          {(advice.stock || advice.positionAdvice) && (
            <div className="flex flex-wrap items-center gap-2">
              {advice.stock && <HighlightName name={advice.stock} code={nameToCode?.[advice.stock]} onOpenStock={onOpenStock} />}
              {advice.positionAdvice && <PosTag v={advice.positionAdvice} />}
            </div>
          )}
          {advice.risk && <p className="leading-relaxed" style={{ color: "#b8533a" }}>{advice.risk}</p>}
        </div>
      ),
    });
  }
  if (advice.auction) rows.push({ label: "竞价情绪", value: advice.auction });
  if (advice.position) rows.push({ label: "位置趋势", value: advice.position });
  if (advice.opinion) rows.push({ label: "综合建议", value: advice.opinion });
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 px-2 py-1.5">
          <div className="mb-0.5 text-[11px] font-bold text-[#8b7a5e]">{r.label}</div>
          <div className="text-[12px] leading-relaxed text-[#6b5b3e]">{r.value}</div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-[12px] text-[#a8987e]">暂无可展示的个股意见(未填写个股或未完成分析)。</p>}
    </div>
  );
}

/** 趋势波段三段式渲染 */
export function TrendReviewSection({
  result,
  sources,
  onOpenStock,
}: {
  result: PhiliaMarketAnalysisResult;
  sources: { name: string; fetchedAt: string }[];
  onOpenStock?: (code: string) => void;
}) {
  const me = result.marketEnvironment;
  const mainLines = result.mainLines || [];
  const trendStocks = result.trendStocks || [];
  const nameToCode = result.targetCodes || {};
  const codeMap = new Map(Object.entries(nameToCode));
  const openStock = (name: string) => {
    const c = codeMap.get(name);
    if (c && onOpenStock) onOpenStock(c);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
      {/* 第一段 · 大盘与波段环境 */}
      {me && (
        <section className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
          <div className="mb-1 flex items-center gap-1.5 border-b border-[#c9b99a]/50 pb-1">
            <span className="inline-block h-3 w-1 rounded-sm bg-[#d4943a]" />
            <span className="text-[12px] font-bold font-newspaper-heading text-[#6b5b3e]">① 大盘与波段环境</span>
            {me.strength && (
              <span
                className="rounded px-1.5 py-px text-[10px] font-bold"
                style={{
                  color: me.strength === "强" ? "#4a6b3f" : me.strength === "弱" ? "#b8533a" : "#d4943a",
                  background: me.strength === "强" ? "#e6f2e6" : me.strength === "弱" ? "#f7e3dc" : "#f8ead0",
                }}
              >
                强度 {me.strength}
              </span>
            )}
            {me.style && <span className="rounded bg-[#ede4d4] px-1.5 py-px text-[10px] font-bold text-[#8b7a5e]">{me.style}</span>}
            {me.basePosition && <PosTag v={me.basePosition} />}
            <span className="ml-auto text-[10px] text-[#a8987e]">{sources.length ? `数据源 ${sources.length} 路` : ""}</span>
          </div>
          {me.environment && <p className="text-[12px] leading-relaxed text-[#6b5b3e]">{me.environment}</p>}
          {me.analysis && <p className="mt-1 text-[12px] leading-relaxed text-[#6b5b3e]">{me.analysis}</p>}
        </section>
      )}

      {/* 第二段 · 主线板块与趋势方向 */}
      <section className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
        <div className="mb-1 flex items-center gap-1.5 border-b border-[#c9b99a]/50 pb-1">
          <span className="inline-block h-3 w-1 rounded-sm bg-[#4a6b3f]" />
          <span className="text-[12px] font-bold font-newspaper-heading text-[#6b5b3e]">② 主线板块与趋势方向</span>
        </div>
        {mainLines.length === 0 ? (
          <p className="text-[12px] text-[#a8987e]">暂无可展示的主线方向。</p>
        ) : (
          <div className="space-y-1">
            {mainLines.map((m, i) => (
              <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-2 py-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] font-bold text-[#6b5b3e]">{m.name}</span>
                  {m.stage && (
                    <span className="rounded px-1 py-px text-[10px] font-bold" style={{ color: STAGE_COLOR[m.stage] || "#8b7a5e", background: "#f5f0e6" }}>
                      {m.stage}
                    </span>
                  )}
                  {m.capital && (
                    <span className="rounded px-1 py-px text-[10px] font-bold" style={{ color: CAPITAL_COLOR[m.capital] || "#8b7a5e", background: "#f5f0e6" }}>
                      资金{m.capital}
                    </span>
                  )}
                </div>
                {m.direction && <p className="mt-0.5 text-[11px] leading-relaxed text-[#6b5b3e]">{m.direction}</p>}
                {m.note && <p className="mt-0.5 text-[11px] leading-relaxed text-[#8b7a5e]">{m.note}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 第三段 · 趋势标的池 */}
      <section className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
        <div className="mb-1 flex items-center gap-1.5 border-b border-[#c9b99a]/50 pb-1">
          <span className="inline-block h-3 w-1 rounded-sm bg-[#b8860b]" />
          <span className="text-[12px] font-bold font-newspaper-heading text-[#6b5b3e]">③ 趋势标的池</span>
          <span className="ml-auto text-[10px] text-[#a8987e]">{trendStocks.length} 只</span>
        </div>
        {trendStocks.length === 0 ? (
          <p className="text-[12px] text-[#a8987e]">暂无满足条件的趋势票。</p>
        ) : (
          <div className="space-y-1">
            {trendStocks.map((s: PhiliaTrendStock, i) => (
              <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-2 py-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <HighlightName name={s.name} code={codeMap.get(s.name)} onOpenStock={onOpenStock} />
                  {s.trendState && <span className="rounded bg-[#ede4d4] px-1 py-px text-[10px] font-bold text-[#8b7a5e]">{s.trendState}</span>}
                  {s.buyPoint && <span className="rounded bg-[#e6f2e6] px-1 py-px text-[10px] font-bold text-[#3f7d3f]">{s.buyPoint}</span>}
                  {s.position && <PosTag v={s.position} />}
                </div>
                {(s.support || s.resistance) && (
                  <p className="mt-0.5 text-[11px] text-[#6b5b3e]">
                    {s.support ? `支撑 ${s.support}` : ""}
                    {s.support && s.resistance ? " · " : ""}
                    {s.resistance ? `压力 ${s.resistance}` : ""}
                  </p>
                )}
                {s.logic && <p className="mt-0.5 text-[11px] leading-relaxed text-[#8b7a5e]">{s.logic}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="px-1 text-[10px] text-[#a8987e]">市场有风险，仅作复盘参考，不构成投资建议。</p>
    </div>
  );
}
