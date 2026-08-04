import { useEffect, useMemo, useState } from "react";
import { FloatingWindow } from "./FloatingWindow";
import { api, type Quote } from "@/lib/api";
import { useQuote } from "@/lib/market";
import { clsChg, fmtPct, fmtPrice, fmtYuan } from "@/lib/format";
import { Spark } from "./Spark";
import { usePolling } from "@/hooks/usePolling";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

interface StockDetailWindowProps {
  code: string;
  name: string;
  onClose: () => void;
}

/** 统计数据项: 标签 + 值 */
function StatRow({ label, value, valueCls = "text-[#6b5b3e]", className = "" }: { label: string; value: string; valueCls?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-between border-b border-[#e0d5c0]/30 py-1.5 last:border-0 ${className}`}>
      <span className="text-[11px] text-[#a8987e]">{label}</span>
      <span className={`text-[14px] font-semibold ${valueCls}`} style={TNUM}>{value}</span>
    </div>
  );
}

export function StockDetailWindow({ code, name, onClose }: StockDetailWindowProps) {
  // 统一报价中心: 实时价格/涨跌幅（5s 轮询）
  const hub = useQuote(code);

  // 完整报价详情（含开盘/最高/最低/昨收/成交量/振幅等）
  const [fullQuote, setFullQuote] = useState<Quote | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.quotes([code]).then((data) => {
      if (!cancelled && data[code]) setFullQuote(data[code]);
    });
    return () => { cancelled = true; };
  }, [code]);

  // 分时走势（60s 轮询）
  const { data: minute } = usePolling(
    () => api.minute(code),
    60000,
    [code],
  );

  // 主力净额(KPL main-forces, 15s 轮询)
  const { data: mainForces } = usePolling(
    () => api.stockMainForces(code),
    15000,
    [code],
  );

  // 实时行情(KPL pankou, 5s 轮询, 优先; 失败回退统一报价中心)
  const { data: kq } = usePolling(
    () => api.stockQuote(code),
    5000,
    [code],
  );

  const p = kq?.price ?? hub?.price ?? fullQuote?.price;
  const pc = kq?.pct ?? hub?.pct ?? fullQuote?.pct;
  const change = kq?.change ?? fullQuote?.change;
  const open = kq?.open ?? fullQuote?.open;
  const high = kq?.high ?? fullQuote?.high;
  const low = kq?.low ?? fullQuote?.low;
  const prev = kq?.prev ?? fullQuote?.prev;
  const amount = kq?.amount ?? hub?.amount ?? fullQuote?.amount;
  const turnover = kq?.turnover ?? hub?.turnover ?? fullQuote?.turnover;
  const marketValue = kq?.marketValue;

  // 所属行业/概念（服务端 24h 缓存，前端 5min 重试）
  const { data: boards } = usePolling(
    () => api.stockBoards(code),
    5 * 60 * 1000,
    [code],
  );

  // 主营业务（用于概念权重排序）
  const { data: profile } = usePolling(
    () => api.stockProfile(code),
    5 * 60 * 1000,
    [code],
  );

  // 根据主营业务关键词对概念进行排序
  const sortedConcepts = useMemo(() => {
    if (!boards?.concepts || boards.concepts.length === 0) return boards?.concepts || [];
    const mainBiz = profile?.mainBusiness || "";
    if (!mainBiz) return boards.concepts; // 无主营业务数据，保持原顺序

    // 提取主营业务关键词（按常见分隔符拆分）
    const keywords = mainBiz
      .split(/[、，,；;。. 　]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);

    // 计算每个概念与主营业务的匹配度
    const scored = boards.concepts.map((concept) => {
      let score = 0;
      for (const kw of keywords) {
        if (concept.includes(kw)) score += 10; // 概念包含关键词 → 高权重
        if (kw.includes(concept)) score += 5;  // 关键词包含概念 → 中权重
      }
      return { concept, score };
    });

    // 按分数降序排序，同分保持原顺序
    return scored.sort((a, b) => b.score - a.score).map((s) => s.concept);
  }, [boards?.concepts, profile?.mainBusiness]);

  return (
    <FloatingWindow
      id={`stock-detail-${code}`}
      title={name}
      icon="◆"
      accent="#d4943a"
      onClose={onClose}
      defaultWidth={460}
      defaultHeight={430}
    >
      <div className="flex h-full flex-col gap-3 p-4">
        {/* 顶部: 代码 + 价格 + 涨跌幅 */}
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[10px] text-[#a8987e]">{code}</div>
            <div className="text-[30px] font-bold leading-tight tracking-tight text-[#6b5b3e]" style={TNUM}>
              {p != null ? fmtPrice(p) : "—"}
            </div>
          </div>
          <div className="text-right">
            {pc != null && (
              <div className={`text-[20px] font-bold leading-tight ${clsChg(pc)}`} style={TNUM}>
                {fmtPct(pc)}
              </div>
            )}
            {change != null && (
              <div className={`mt-0.5 text-[13px] font-semibold ${clsChg(change)}`} style={TNUM}>
                {change > 0 ? "+" : ""}{change.toFixed(2)}
              </div>
            )}
          </div>
        </div>

        {/* 分时走势图 */}
        <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6] p-2">
          {minute && minute.points.length > 1 ? (
            <Spark points={minute.points} prec={minute.prec} width={428} height={52} fluid session="ashare" />
          ) : (
            <div className="flex h-[52px] items-center justify-center text-[10px] text-[#a8987e]">
              {minute ? "暂无分时数据" : "分时数据加载中..."}
            </div>
          )}
        </div>

        {/* 核心数据格 */}
        <div className="grid grid-cols-2 gap-x-5 rounded border border-[#e0d5c0] bg-[#f5f0e6] p-3">
          <StatRow label="昨收" value={prev != null ? fmtPrice(prev) : "—"} />
          <StatRow label="开盘" value={open != null ? fmtPrice(open) : "—"} />
          <StatRow label="最高" value={high != null ? fmtPrice(high) : "—"} />
          <StatRow label="最低" value={low != null ? fmtPrice(low) : "—"} />
          <StatRow label="成交额" value={amount != null && amount > 0 ? fmtYuan(amount * 10000) : "—"} />
          <StatRow label="换手率" value={turnover != null ? `${turnover.toFixed(2)}%` : "—"} />
          <StatRow
            label="主力净额"
            value={mainForces ? fmtYuan(mainForces.netAmount) : "—"}
            valueCls={mainForces ? clsChg(mainForces.netAmount) : "text-[#6b5b3e]"}
          />
          <StatRow
            label="主动买/卖"
            value={mainForces ? `${fmtYuan(mainForces.buyAmount)} / ${fmtYuan(mainForces.sellAmount)}` : "—"}
          />
          <StatRow
            label="总市值"
            className="col-span-2"
            value={marketValue != null && marketValue > 0 ? fmtYuan(marketValue) : "—"}
          />
        </div>

        {/* 所属行业/概念 */}
        {boards && (
          <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6] p-2.5">
            {boards.industry && (
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[10px] text-[#a8987e]">行业</span>
                <span className="rounded-sm bg-[#d4943a]/15 px-1.5 py-0.5 text-[11px] font-medium text-[#d4943a]">
                  {boards.industry}
                </span>
                {boards.area && (
                  <span className="ml-auto rounded-sm bg-[#c9b99a]/20 px-1.5 py-0.5 text-[10px] text-[#8b7a5e]">
                    {boards.area}
                  </span>
                )}
              </div>
            )}
            {sortedConcepts.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-[10px] text-[#a8987e]">概念</span>
                <div className="flex flex-wrap gap-1">
                  {sortedConcepts.map((c) => (
                    <span
                      key={c}
                      className="rounded-sm border border-[#4a6b3f]/20 bg-[#4a6b3f]/10 px-1.5 py-0.5 text-[10px] text-[#4a6b3f]"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 底部时间戳 */}
        <div className="mt-auto flex items-center justify-between border-t border-[#e0d5c0] pt-2 text-[9px] text-[#a8987e]">
          <span>数据来源: 开盘啦 KPL · 实时</span>
          <span>更新: {hub?.updated ? new Date(hub.updated).toLocaleTimeString("zh-CN") : "—"}</span>
        </div>
      </div>
    </FloatingWindow>
  );
}