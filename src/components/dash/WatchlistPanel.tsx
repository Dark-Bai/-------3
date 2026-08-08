/**
 * 自选股卡片模块(原「市场情绪」位置)
 *
 * 功能:
 *  - 自选股管理: 列表查看/删除(搜索添加已移至 mini自选 面板)
 *  - 股票卡片: 实时价格(1s) + 涨跌幅(红涨绿跌) + 成交额 + Level2 大单净额 + 迷你分时图 + 总市值
 *  - 卡片拖动排序(HTML5 DnD, 无外部依赖), 顺序独立于 mini自选
 *  - 多组轮询: 报价 1s / 分时 10s / 大单净额 30s / 市值 60s, 均批量请求 + 后端缓存, 不阻塞渲染
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type Quote, type MinuteData, type StockFlow } from "@/lib/api";
import { bgChg, clsChg, fmtPct, fmtPrice, fmtWan, fmtYuan } from "@/lib/format";
import { useWatchlist } from "./WatchlistContext";

/** 卡片统一宽度持久化 key */
const CARDW_KEY = "dash:watchlist-card-w";
/** 卡片统一高度(分时图高度)持久化 key */
const CARDH_KEY = "dash:watchlist-card-h";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 涨跌颜色: 涨红 / 跌绿(与全站一致) */
const hexChgV = (v: number) => (v > 0 ? "#b8533a" : v < 0 ? "#4a6b3f" : "#a8987e");

/** 迷你分时图: 价格线 + 面积 + 昨收基准线 + 涨跌幅纵轴 + 时间横轴(A股 240 分钟) */
function MiniChart({ points, prec, width, height }: { points: { t: string; p: number }[]; prec: number; width: number; height: number }) {
  // 布局: 左侧 30px 放 Y 轴涨跌幅, 底部 14px 放 X 轴时间, 其余为绘图区
  const padL = 30, padR = 4, padT = 4, padB = 14;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const { line, area, refY, color, yTicks, xTicks } = useMemo(() => {
    if (!points || points.length < 2 || !prec) return { line: "", area: "", refY: 0, color: "#a8987e", yTicks: [], xTicks: [] };
    const OPEN = 9 * 60 + 30, LUNCH_S = 11 * 60 + 30, LUNCH_E = 13 * 60, SESSION = 240;
    const toMinute = (t: string) => {
      const s = t.includes(":") ? (t.trim().split(/\s+/).pop() ?? t) : t;
      if (s.includes(":")) { const [hh, mm] = s.split(":"); return parseInt(hh, 10) * 60 + parseInt(mm, 10); }
      return parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2, 4), 10);
    };
    // X 轴: A股交易时间映射(09:30-11:30, 13:00-15:00, 共 240 分钟), 基准为绘图区左缘 padL
    const xOf = (m: number) => {
      let e = m - OPEN;
      if (m >= LUNCH_E) e -= LUNCH_E - LUNCH_S;
      return padL + (Math.max(0, Math.min(e, SESSION)) / SESSION) * chartW;
    };
    const xs = points.map((d) => xOf(toMinute(d.t)));
    if (xs.some((x) => !Number.isFinite(x))) {
      points.forEach((_, i) => { xs[i] = padL + (i / (points.length - 1)) * chartW; });
    }
    // Y 轴: 以昨收为 0% 的涨跌幅坐标
    const ps = points.map((d) => d.p);
    const pctArr = ps.map((p) => ((p - prec) / prec) * 100);
    const span = Math.max(...pctArr, 0) - Math.min(...pctArr, 0);
    const step = span < 1.5 ? 0.5 : span < 4 ? 1 : 2; // 刻度步长(%), 自适应
    let min = Math.floor(Math.min(...pctArr, 0) / step) * step;
    let max = Math.ceil(Math.max(...pctArr, 0) / step) * step;
    if (max - min < 1e-9) { max = step; min = -step; }
    const Y = (v: number) => padT + ((max - v) / (max - min)) * chartH;
    const ys = pctArr.map(Y);
    const last = ps[ps.length - 1];
    const color = hexChgV(last - prec);
    const line = points.map((_, i) => `${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
    const area = `${xs[0].toFixed(1)},${padT + chartH} ${line} ${xs[xs.length - 1].toFixed(1)},${padT + chartH}`;
    // Y 轴刻度(涨跌幅 %)
    const yTicks: { y: number; label: string }[] = [];
    for (let v = min; v <= max + 1e-9; v += step) {
      const abs = Math.abs(v);
      yTicks.push({ y: Y(v), label: abs < 0.05 ? "0" : `${v > 0 ? "+" : ""}${v.toFixed(step < 1 ? 1 : 0)}%` });
    }
    // X 轴刻度(关键时间, 避开 11:30/13:00 重叠; 09:30/15:00 标签分别贴左/贴右防边框裁剪)
    const xTicks = [9 * 60 + 30, 10 * 60 + 30, 11 * 60 + 30, 14 * 60, 15 * 60].map((m) => ({
      x: xOf(m),
      label: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
    }));
    return { line, area, refY: Y(0), color, yTicks, xTicks };
  }, [points, prec, width, height]);

  if (!line) return <div className="flex items-center justify-center text-[10px] text-[#a8987e]" style={{ width, height }}>分时加载中…</div>;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block min-w-0">
      {/* Y 轴网格线与涨跌幅刻度 */}
      {yTicks.map((t, i) => (
        <g key={`y${i}`}>
          <line x1={padL} y1={t.y} x2={width - padR} y2={t.y} stroke="#e0d5c0" strokeWidth={0.4} strokeDasharray="1,3" />
          <text x={padL - 3} y={t.y + 2.5} textAnchor="end" fontSize="7" fill="#a8987e">{t.label}</text>
        </g>
      ))}
      {/* 面积 + 昨收基准线 + 价格线 */}
      <polygon points={area} fill={color} opacity={0.1} />
      <line x1={padL} y1={refY} x2={width - padR} y2={refY} stroke="#c9b99a" strokeWidth={0.6} strokeDasharray="2,3" />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.1} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {/* X 轴时间刻度: 首尾贴边对齐避免被边框裁剪 */}
      {xTicks.map((t, i) => (
        <text
          key={`x${i}`}
          x={t.x}
          y={height - 3}
          textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
          fontSize="7"
          fill="#a8987e"
        >{t.label}</text>
      ))}
    </svg>
  );
}

/** 股票卡片(width/height: 卡片宽度与分时图高度, 均由面板统一调节并持久化) */
function WatchCard({
  code, quote, minute, flow, marketValue, width, chartH, dragging, onSelect, onRemove, onHexin, onDragStart, onDragOver, onDrop, onDragEnd,
}: {
  code: string; quote?: Quote; minute?: MinuteData; flow?: StockFlow; marketValue?: number; width: number; chartH: number;
  dragging: boolean; onSelect: () => void;
  onRemove: () => void;
  onHexin: () => void;
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
      onDoubleClick={(e) => { e.preventDefault(); onHexin(); }}
      title="拖拽调整顺序 · 双击唤起同花顺"
      style={{ width }}
      className={`group relative flex shrink-0 cursor-grab select-none flex-col gap-1 rounded border border-[#e0d5c0] bg-[#faf6ee] p-1.5 transition-all active:cursor-grabbing ${
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

      {/* 头部: 名称 + 同花顺唤起按钮 + 代码 + 右侧股价/涨跌幅(缩小同排) */}
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#4a3b28]">{quote?.name || code.replace(/^(sh|sz|bj)/, "")}</span>
        {/* 唤起同花顺: 后台启动 hexin.exe 并输入股票代码跳转(加大按钮, 紧贴名称右侧) */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onHexin(); }}
          title="在同花顺中打开该股票"
          className="-ml-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-[#e0d5c0] bg-[#f5f0e6] transition-colors hover:border-[#d4943a]/60 hover:bg-[#d4943a]/10"
        >
          <img src="/hexin.ico" alt="同花顺" className="h-[13px] w-[13px]" draggable={false} />
        </button>
        <span className="shrink-0 text-[9px] text-[#a8987e]" style={TNUM}>{code}</span>
        <span className={`shrink-0 text-[14px] font-bold leading-none ${quote ? clsChg(pct) : "text-[#a8987e]"}`} style={TNUM}>
          {quote ? fmtPrice(quote.price) : "—"}
        </span>
        <span className={`shrink-0 rounded px-1 py-px text-[10px] font-semibold ${quote ? bgChg(pct) : ""}`} style={TNUM}>
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

      {/* 迷你分时图(涨跌幅纵轴 + 时间横轴, 宽高随卡片联动) */}
      <div className="rounded bg-[#f5f0e6]/70 p-0.5">
        <MiniChart points={minute?.points ?? []} prec={minute?.prec ?? 0} width={Math.max(150, width - 18)} height={chartH} />
      </div>
    </div>
  );
}

export function WatchlistPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  /* ---------------- 自选股列表(共享 context: 增删/持久化见 WatchlistContext) ---------------- */
  const { codes, removeCode, moveCode } = useWatchlist();
  const codesKey = codes.join(",");
  const enabled = codes.length > 0;
  const [showManage, setShowManage] = useState(false);

  /* ---------------- 卡片统一宽度(调节控件同步缩放所有卡片, 本地持久化) ---------------- */
  const [cardW, setCardW] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(CARDW_KEY) || "", 10);
      return v >= 160 && v <= 320 ? v : 212;
    } catch { return 212; }
  });
  useEffect(() => {
    try { localStorage.setItem(CARDW_KEY, String(cardW)); } catch { /* ignore */ }
  }, [cardW]);

  /* ---------------- 卡片统一高度(调节分时图高度 → 卡片高度同步, 本地持久化) ---------------- */
  const [cardH, setCardH] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(CARDH_KEY) || "", 10);
      return v >= 60 && v <= 150 ? v : 92;
    } catch { return 92; }
  });
  useEffect(() => {
    try { localStorage.setItem(CARDH_KEY, String(cardH)); } catch { /* ignore */ }
  }, [cardH]);

  /* ---------------- 数据轮询(批量, 不同频率) ---------------- */
  // 报价 1s(后端 1.5s 缓存, 有效数据时效 ≤1.5s)
  const { data: quotes } = usePolling(
    () => (enabled ? api.quotes(codes).catch(() => null) : Promise.resolve(null)),
    1000,
    [codesKey],
    (a, b) => {
      if (!a || !b) return a === b;
      // 任一 code 在旧/新数据中缺失(如新增股票首帧) → 判定不同, 立即更新, 避免新卡片数据永远不落地
      return codes.every((c) => {
        const x = a[c], y = b[c];
        if (!x || !y) return false;
        return x.price === y.price && x.pct === y.pct;
      });
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

  /* ---------------- 唤起同花顺(后台启动 hexin.exe + 输入代码跳转) ---------------- */
  const [hexinBusy, setHexinBusy] = useState(false);
  const handleHexin = async (code: string) => {
    if (hexinBusy) return; // 防连点并发唤起
    setHexinBusy(true);
    try {
      await api.launchHexin(code);
    } catch { /* 唤起失败静默(后台已尝试), 用户可手动打开同花顺 */ }
    finally { setHexinBusy(false); }
  };

  /* ---------------- 拖动排序(HTML5 DnD) ---------------- */
  const dragFrom = useRef<string | null>(null);
  const [dragState, setDragState] = useState<string | null>(null);
  const handleDragStart = (e: React.DragEvent, code: string, name?: string) => {
    dragFrom.current = code;
    setDragState(code);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", code);
    // 附带个股名称(自定义 MIME): 供 PHILIA 搜索框作为放置目标时直接填入名称
    e.dataTransfer.setData("application/x-stock", JSON.stringify({ code, name: name || "" }));
  };
  const handleDragOver = (e: React.DragEvent, code: string) => {
    e.preventDefault();
    const from = dragFrom.current;
    if (!from || from === code) return;
    e.dataTransfer.dropEffect = "move";
    moveCode(from, code);
  };
  const endDrag = () => { dragFrom.current = null; setDragState(null); };

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="自选股"
      icon="☆"
      accent="#d4943a"
      right={
        <div className="relative flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowManage((v) => !v)}
            title="查看/管理自选股列表"
            className="rounded border border-[#d4943a]/40 px-1.5 py-0.5 text-[10px] text-[#d4943a] transition-colors hover:bg-[#d4943a]/10"
          >
            管理 {codes.length}
          </button>
          {/* 卡片统一宽度调节: 同时缩放所有卡片(160-320px) */}
          <div className="flex items-center gap-0.5 rounded border border-[#e0d5c0] px-1 py-0.5" title="同时调节所有卡片宽度(160-320px)">
            <button
              type="button"
              onClick={() => setCardW((w) => Math.max(160, w - 10))}
              className="px-0.5 text-[11px] font-bold leading-none text-[#8b7a5e] transition-colors hover:text-[#b8533a]"
            >−</button>
            <span className="min-w-[30px] text-center text-[9px] text-[#a8987e]" style={TNUM}>{cardW}</span>
            <button
              type="button"
              onClick={() => setCardW((w) => Math.min(320, w + 10))}
              className="px-0.5 text-[11px] font-bold leading-none text-[#8b7a5e] transition-colors hover:text-[#4a6b3f]"
            >＋</button>
          </div>
          {/* 卡片统一高度调节: 同步缩放所有卡片分时图高度(60-150px) */}
          <div className="flex items-center gap-0.5 rounded border border-[#e0d5c0] px-1 py-0.5" title="同时调节所有卡片高度(60-150px)">
            <button
              type="button"
              onClick={() => setCardH((h) => Math.max(60, h - 10))}
              className="px-0.5 text-[11px] font-bold leading-none text-[#8b7a5e] transition-colors hover:text-[#b8533a]"
            >−</button>
            <span className="min-w-[30px] text-center text-[9px] text-[#a8987e]" style={TNUM}>{cardH}</span>
            <button
              type="button"
              onClick={() => setCardH((h) => Math.min(150, h + 10))}
              className="px-0.5 text-[11px] font-bold leading-none text-[#8b7a5e] transition-colors hover:text-[#4a6b3f]"
            >＋</button>
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col p-2">
        {/* 点击管理列表外任意区域: 关闭管理列表 */}
        {showManage && <div className="fixed inset-0 z-[15]" onClick={() => setShowManage(false)} />}
        {/* 管理列表视图 */}
        {showManage && (
          <div className="relative z-[20] mb-1.5 shrink-0 rounded border border-[#e0d5c0] bg-[#f5f0e6]/50 p-1.5">
            <div className="mb-1 text-[10px] font-semibold text-[#8b7a5e]">自选股列表({codes.length})</div>
            <div className="flex flex-wrap gap-1">
              {codes.length === 0 && <span className="text-[10px] text-[#a8987e]">暂无自选, 在 mini自选 面板搜索添加</span>}
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
              自选股为空 — 在 mini自选 面板搜索添加
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
                  width={cardW}
                  chartH={cardH}
                  dragging={dragState === code}
                  onSelect={() => { /* 预留: 点击打开个股详情 */ }}
                  onRemove={() => removeCode(code)}
                  onHexin={() => handleHexin(code)}
                  onDragStart={(e) => handleDragStart(e, code, quotes?.[code]?.name)}
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
