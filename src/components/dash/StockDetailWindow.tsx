import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FloatingWindow } from "./FloatingWindow";
import { api, type MinuteData, type Quote } from "@/lib/api";
import { useQuote } from "@/lib/market";
import { clsChg, fmtPct, fmtPrice, fmtYuan } from "@/lib/format";
import { MinuteChart } from "./MinuteChart";
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
    <div className={`flex items-center justify-between border-b border-[#e0d5c0]/30 py-[5px] last:border-0 ${className}`}>
      <span className="text-[10px] text-[#a8987e]">{label}</span>
      <span className={`text-[12px] font-semibold ${valueCls}`} style={TNUM}>{value}</span>
    </div>
  );
}

const MINUTE_H_KEY = "stock-detail-minute-height";
const MINUTE_H_MIN = 52;
const MINUTE_H_MAX = 320;

/** 可调高度的分时图容器: 底部拖拽手柄调整高度, 结果持久化到 localStorage */
function ResizableMinuteChart({ minute, onDoubleClick }: { minute: MinuteData | null; onDoubleClick?: () => void }) {
  const [h, setH] = useState(() => {
    const saved = Number(localStorage.getItem(MINUTE_H_KEY));
    return Number.isFinite(saved) && saved > 0 ? Math.min(MINUTE_H_MAX, Math.max(MINUTE_H_MIN, saved)) : 200;
  });
  const hRef = useRef(h);
  const rafRef = useRef(0);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = hRef.current;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(MINUTE_H_MAX, Math.max(MINUTE_H_MIN, startH + (ev.clientY - startY)));
      hRef.current = next;
      if (rafRef.current) return; // 单帧合并, 保证拖拽流畅
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setH(hRef.current);
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      localStorage.setItem(MINUTE_H_KEY, String(hRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]">
      <div className="p-2">
        {minute && minute.points.length > 1 ? (
          <MinuteChart points={minute.points} prec={minute.prec} height={h} onDoubleClick={onDoubleClick} />
        ) : (
          <div className="flex items-center justify-center text-[10px] text-[#a8987e]" style={{ height: h }}>
            {minute ? "暂无分时数据" : "分时数据加载中..."}
          </div>
        )}
      </div>
      <div
        className="group flex cursor-ns-resize touch-none items-center justify-center py-1"
        onPointerDown={onPointerDown}
        title="拖动调整分时图高度"
      >
        <span className="h-[3px] w-8 rounded-full bg-[#d4943a]/40 transition group-hover:bg-[#d4943a]/80" />
      </div>
    </div>
  );
}

export function StockDetailWindow({ code, name, onClose }: StockDetailWindowProps) {
  // 统一报价中心: 实时价格/涨跌幅（5s 轮询）
  const hub = useQuote(code);

  // 完整报价详情(报价中心, 快速, 一次性) — 提供 OHLC/涨跌 快速兜底
  const [fullQuote, setFullQuote] = useState<Quote | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.quotes([code]).then((data) => {
      if (!cancelled && data[code]) setFullQuote(data[code]);
    });
    return () => { cancelled = true; };
  }, [code]);

  // 个股详情聚合(本地数据库: 按需抓取 + 失败回退 + 行业概念永久保留)轮询。
  // 行业/概念未加载时快速轮询(2s), 保证首次打开时尽快显示; 加载后松弛为 10s。
  const [boardsFast, setBoardsFast] = useState(true);
  const { data: detail } = usePolling(() => api.stockDetail(code), boardsFast ? 2000 : 10000, [code, boardsFast]);
  useEffect(() => {
    const loaded = !!detail?.boards && (detail.boards.industry || detail.boards.concepts.length > 0);
    if (loaded) setBoardsFast(false);
  }, [detail]);

  const kq = detail?.quote ?? null;
  const minute = detail?.minute ?? null;
  const mainForces = detail?.mainForces ?? null;
  const boards = detail?.boards ?? null;
  const profile = detail?.profile ?? null;

  const p = hub?.price ?? kq?.price ?? fullQuote?.price;
  const pc = hub?.pct ?? kq?.pct ?? fullQuote?.pct;
  const change = kq?.change ?? fullQuote?.change;
  const open = kq?.open ?? fullQuote?.open;
  const high = kq?.high ?? fullQuote?.high;
  const low = kq?.low ?? fullQuote?.low;
  const prev = kq?.prev ?? fullQuote?.prev;
  const amount = hub?.amount ?? kq?.amount ?? fullQuote?.amount;
  const turnover = hub?.turnover ?? kq?.turnover ?? fullQuote?.turnover;
  const marketValue = kq?.marketValue;

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

  /* ---------------- 唤起同花顺(后台启动 hexin.exe + 输入代码跳转) ---------------- */
  const [hexinBusy, setHexinBusy] = useState(false);
  const handleHexin = async () => {
    if (hexinBusy) return; // 防连点并发唤起
    setHexinBusy(true);
    try { await api.launchHexin(code); } catch { /* 唤起失败静默(后台已尝试), 用户可手动打开同花顺 */ }
    finally { setHexinBusy(false); }
  };

  return (
    <FloatingWindow
      id={`stock-detail-${code}`}
      title={name}
      icon="◆"
      accent="#d4943a"
      onClose={onClose}
      defaultWidth={460}
      defaultHeight={600}
    >
      <div className="flex h-full flex-col gap-3 p-4">
        {/* 顶部: 代码 + 同花顺按钮 + 价格 + 涨跌幅 */}
        <div className="flex items-baseline justify-between">
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-[#a8987e]">{code}</span>
              {/* 唤起同花顺: 后台启动 hexin.exe 并输入股票代码跳转 */}
              <button
                type="button"
                onClick={handleHexin}
                disabled={hexinBusy}
                title="在同花顺中打开该股票"
                className="flex h-[16px] w-[16px] items-center justify-center rounded border border-[#e0d5c0] bg-[#f5f0e6] transition-colors hover:border-[#d4943a]/60 hover:bg-[#d4943a]/10 disabled:opacity-50"
              >
                <img src="/hexin.ico" alt="同花顺" className="h-[12px] w-[12px]" draggable={false} />
              </button>
            </div>
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

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {/* 昨收/最高/最低/开盘: 纯文本, 无边框 */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[#a8987e]">昨收</span>
          <span className="font-semibold text-[#6b5b3e]" style={TNUM}>{prev != null ? fmtPrice(prev) : "—"}</span>
          <span className="text-[#a8987e]">最高</span>
          <span className="font-semibold text-[#6b5b3e]" style={TNUM}>{high != null ? fmtPrice(high) : "—"}</span>
          <span className="text-[#a8987e]">最低</span>
          <span className="font-semibold text-[#6b5b3e]" style={TNUM}>{low != null ? fmtPrice(low) : "—"}</span>
          <span className="text-[#a8987e]">开盘</span>
          <span className="font-semibold text-[#6b5b3e]" style={TNUM}>{open != null ? fmtPrice(open) : "—"}</span>
        </div>

        {/* 可拖拽调整高度的分时走势图(双击分时图唤起同花顺) */}
        <ResizableMinuteChart minute={minute} onDoubleClick={handleHexin} />

        {/* 核心数据格 */}
        <div className="grid grid-cols-4 gap-x-3">
          <StatRow label="成交额" value={amount != null && amount > 0 ? fmtYuan(amount * 10000) : "—"} />
          <StatRow label="换手率" value={turnover != null ? `${turnover.toFixed(2)}%` : "—"} />
          <StatRow
            label="主力净额"
            value={mainForces ? fmtYuan(mainForces.netAmount) : "—"}
            valueCls={mainForces ? clsChg(mainForces.netAmount) : "text-[#6b5b3e]"}
          />
          <StatRow
            label="总市值"
            value={marketValue != null && marketValue > 0 ? fmtYuan(marketValue) : "—"}
          />
        </div>

        {/* 所属行业/概念 */}
        {!boards && (
          <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6] p-2.5">
            <div className="flex items-center gap-2 text-[10px] text-[#a8987e]">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#d4943a]/30 border-t-[#d4943a]" />
              行业/概念加载中...
            </div>
          </div>
        )}
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
        </div>

        {/* 底部时间戳 */}
        <div className="flex items-center justify-between border-t border-[#e0d5c0] pt-2 text-[9px] text-[#a8987e]">
          <span>数据来源: 开盘啦 KPL · 实时</span>
          <span>更新: {hub?.updated ? new Date(hub.updated).toLocaleTimeString("zh-CN") : "—"}</span>
        </div>
      </div>
    </FloatingWindow>
  );
}