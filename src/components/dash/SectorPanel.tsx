import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { QuoteRow } from "./QuoteRow";
import { usePolling } from "@/hooks/usePolling";
import { api, type Board } from "@/lib/api";
import { clsChg, fmtPct, fmtYuan, hexChg } from "@/lib/format";
import { isTv } from "@/lib/tv";

type Kind = "01" | "02";

const ROTATE_MS = 10000;
// 概念榜近千行, 全量渲染会让千级 DOM 每 15s 重渲染; 截断显示, 搜索可定位完整集合
// TV 弱 GPU: 滚动层是全量光栅化的图层, 进一步压到 40 行
const MAX_BOARD_ROWS = isTv ? 40 : 200;
// 成分股侧栏行数上限: 每个 QuoteRow 带 2 个 Observer + 3 个轮询 hook, 行数直接决定定时器规模
const MAX_STOCK_ROWS = 100;

function BoardRow({ b, maxAbs, active, onClick }: { b: Board; maxAbs: number; active: boolean; onClick: () => void }) {
  const w = maxAbs > 0 ? Math.min(100, (Math.abs(b.pct) / maxAbs) * 100) : 0;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) {
      const activeEl = document.activeElement;
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (activeEl && activeEl instanceof HTMLElement && activeEl !== ref.current)
        activeEl.focus();
    }
  }, [active]);
  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`group grid w-full grid-cols-[24px_1fr_76px_96px] items-center gap-2 rounded px-2 py-[5px] text-left transition-colors ${
        active ? "bg-[#d4943a]/10 ring-1 ring-[#d4943a]/40" : "hover:bg-[#ede4d4]"
      }`}
    >
      <span className="text-[10px] text-[#a8987e]">{b.code.slice(-4)}</span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] text-[#6b5b3e] group-hover:text-[#d4943a]">{b.name}</span>
        <span className="mt-0.5 block h-1 rounded-full bg-[#e0d5c0]">
          <span className="block h-1 rounded-full transition-all" style={{ width: `${w}%`, background: hexChg(b.pct) }} />
        </span>
      </span>
      <span className={`text-right text-[12px] font-semibold ${clsChg(b.pct)}`} style={{ fontVariantNumeric: "tabular-nums" }}>
        {fmtPct(b.pct)}
      </span>
      <span className="truncate text-right text-[11px] text-slate-400">
        {b.leadName} <span className={clsChg(b.leadPct)}>{fmtPct(b.leadPct)}</span>
      </span>
    </button>
  );
}

export function SectorPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [kind, setKind] = useState<Kind>("01");
  const [dir, setDir] = useState<0 | 1>(0);
  const [selected, setSelected] = useState<Board | null>(null);
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(false);
  const [idx, setIdx] = useState(0);

  const { data: boards, error } = usePolling(() => api.boards(kind, dir, kind === "01" ? 300 : 1000), 15000, [kind, dir]);

  const filtered = useMemo(() => boards?.filter((b) => !q || b.name.includes(q)), [boards, q]);
  const visibleBoards = useMemo(() => filtered?.slice(0, MAX_BOARD_ROWS), [filtered]);
  const maxAbs = filtered ? Math.max(...filtered.map((b) => Math.abs(b.pct)), 0.01) : 1;

  // 榜单/搜索变化时轮播索引归零(render-time 派生态调整)
  const filterKey = `${kind}|${dir}|${q}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setIdx(0);
  }

  // 定时推进轮播索引
  useEffect(() => {
    if (!auto || !filtered?.length) return;
    const t = window.setInterval(() => setIdx((i) => i + 1), ROTATE_MS);
    return () => window.clearInterval(t);
  }, [auto, filtered?.length]);

  // 当前生效板块: 轮播取索引位; 非轮播保留用户手动选择, 仅当已不在 filtered 中(榜单/搜索变化)才回落到第一
  const activeBoard = useMemo(() => {
    if (!filtered?.length) return null;
    if (auto) return filtered[idx % filtered.length];
    if (selected) {
      const cur = filtered.find((b) => b.code === selected.code);
      if (cur) return cur;
    }
    return filtered[0];
  }, [auto, filtered, idx, selected]);

  const { data: stocks } = usePolling(
    () => (activeBoard ? api.boardStocks(activeBoard.code, MAX_STOCK_ROWS) : Promise.resolve(null)),
    15000,
    [activeBoard?.code]
  );

  const pick = (b: Board) => {
    setAuto(false);
    setSelected(selected?.code === b.code && !auto ? null : b);
  };

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="市场板块实时热点"
      icon="▤"
      accent="#d4943a"
      right={
        <div className="flex items-center gap-1 text-[11px]">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索板块"
            className="w-20 rounded border border-[#e0d5c0] bg-[#ede4d4] px-1.5 py-0.5 text-[11px] text-[#6b5b3e] outline-none placeholder:text-[#a8987e] focus:border-[#d4943a]/50"
          />
          <button
            onClick={() => setAuto((a) => !a)}
            title={auto ? `轮播中(${ROTATE_MS / 1000}s),点击暂停` : "已暂停,点击恢复轮播"}
            className={`rounded px-2 py-0.5 ${auto ? "bg-[#d4943a]/20 text-[#d4943a]" : "text-[#8b7a5e] hover:text-[#6b5b3e]"}`}
          >
            轮播
          </button>
          {([["01", "行业"], ["02", "概念"]] as [Kind, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setKind(k); setAuto(true); }}
              className={`rounded px-2 py-0.5 ${kind === k ? "bg-[#d4943a]/20 text-[#d4943a]" : "text-[#8b7a5e] hover:text-[#6b5b3e]"}`}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 h-3 w-px bg-[#e0d5c0]" />
          {([0, 1] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDir(d)}
              className={`rounded px-2 py-0.5 ${dir === d ? "bg-[#d4943a]/20 text-[#d4943a]" : "text-[#8b7a5e] hover:text-[#6b5b3e]"}`}
            >
              {d === 0 ? "领涨" : "领跌"}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex h-full min-h-0">
        {/* 板块列表 */}
        <div className="min-w-0 flex-1 overflow-y-auto p-1.5">
          <div className="grid grid-cols-[24px_1fr_76px_96px] gap-2 px-2 py-1 text-[10px] text-[#a8987e]">
            <span>代码</span><span>板块 / 强度{filtered ? ` (${filtered.length})` : ""}</span><span className="text-right">涨跌幅</span><span className="text-right">领涨股</span>
          </div>
          {visibleBoards?.map((b) => (
            <BoardRow key={b.code} b={b} maxAbs={maxAbs} active={activeBoard?.code === b.code}
              onClick={() => pick(b)} />
          ))}
          {filtered && filtered.length > MAX_BOARD_ROWS && (
            <div className="p-2 text-center text-[10px] text-[#a8987e]">
              仅显示前 {MAX_BOARD_ROWS} / 共 {filtered.length} 个板块, 搜索可定位其余
            </div>
          )}
          {!filtered && (
            <div className="p-6 text-center text-[11px] text-[#a8987e]">
              {error ? <span className="text-[#b8533a]">数据源连接失败,自动重试中…<br />{error}</span> : "板块数据加载中…"}
            </div>
          )}
          {filtered?.length === 0 && (
            <div className="p-6 text-center text-[11px] text-[#a8987e]">无匹配「{q}」的板块</div>
          )}
        </div>

        {/* 成分股侧栏 */}
        {activeBoard && (
          <div className="w-[min(440px,52%)] shrink-0 overflow-y-auto border-l border-[#e0d5c0] p-2">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-[#d4943a]">{activeBoard.name}</span>
              <span className={`text-[12px] font-semibold ${clsChg(activeBoard.pct)}`}>{fmtPct(activeBoard.pct)}</span>
            </div>
            <div className="mb-2 grid grid-cols-2 gap-1 text-[10px] text-[#a8987e]">
              <span>5日 <span className={clsChg(activeBoard.pct5)}>{fmtPct(activeBoard.pct5)}</span></span>
              <span>20日 <span className={clsChg(activeBoard.pct20)}>{fmtPct(activeBoard.pct20)}</span></span>
            </div>
            <div className="space-y-0.5">
              {stocks?.map((s) => (
                <QuoteRow
                  key={s.code}
                  code={s.code}
                  name={s.name}
                  amount={s.amount > 0 ? fmtYuan(s.amount) : undefined}
                  turnover={s.turnover > 0 ? `${s.turnover.toFixed(1)}%` : undefined}
                  spark boards flow
                />
              ))}
              {stocks && <div className="px-1.5 pt-1 text-right text-[9px] text-slate-600">领涨前 {stocks.length} 只成分股</div>}
              {!stocks && <div className="p-4 text-center text-[10px] text-slate-600">成分股加载中…</div>}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
