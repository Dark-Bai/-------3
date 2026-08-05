import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { FloatingWindow } from "./FloatingWindow";
import { QuoteRow } from "./QuoteRow";
import { useQuote } from "@/lib/market";
import { api, type StockSearchResult } from "@/lib/api";
import { fmtWan } from "@/lib/format";

const LS_KEY = "dash:watchlist";
/** 默认自选: 沪硅产业 / 沪电股份 / 云天化 / 立讯精密 */
const DEFAULT_LIST = ["sh688126", "sz002463", "sh600096", "sz002475"];

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && x)) return v;
  } catch { /* 忽略损坏数据 */ }
  return DEFAULT_LIST;
}

/** 输入归一化为腾讯代码: 6/9→sh, 0/2/3→sz, 4/8→bj; 已带 sh/sz/bj 前缀则原样 */
function normalizeCode(input: string): string | null {
  const s = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    const c = s[0];
    if (c === "6" || c === "9") return `sh${s}`;
    if (c === "0" || c === "2" || c === "3") return `sz${s}`;
    if (c === "4" || c === "8") return `bj${s}`;
  }
  return null;
}

/** 自选股行: 报价取自统一报价中心(名称/价格/额/换), memo 让未变化的行跳过重渲染 */
const WatchRow = memo(function WatchRow({
  code, onRemoveCode,
}: {
  code: string;
  onRemoveCode: (code: string) => void;
}) {
  const q = useQuote(code);
  return (
    <QuoteRow
      code={code}
      name={q?.name || code}
      amount={q?.amount && q.amount > 0 ? fmtWan(q.amount) : undefined}
      turnover={q?.turnover && q.turnover > 0 ? `${q.turnover.toFixed(1)}%` : undefined}
      spark
      boards
      flow
      onRemove={() => onRemoveCode(code)}
    />
  );
});

/** 自选股主体: 添加输入 + 列表。codes 由外部持有, 使网格面板与独立小窗共享同一份列表 */
function WatchlistBody({
  codes,
  onChange,
}: {
  codes: string[];
  onChange: (codes: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [suggestions, setSuggestions] = useState<StockSearchResult[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const suggestRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 卸载时清理搜索防抖定时器
  useEffect(() => () => clearTimeout(timerRef.current), []);

  // 防抖搜索
  const triggerSearch = (val: string) => {
    clearTimeout(timerRef.current);
    const t = val.trim();
    // 纯数字/代码格式不搜索
    if (/^[\d]{3,6}$/.test(t) || /^(sh|sz|bj)\d{6}$/i.test(t)) {
      setSuggestions([]);
      setShowSuggest(false);
      return;
    }
    if (t.length < 1) { setSuggestions([]); setShowSuggest(false); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const res = await api.stockSearch(t);
        setSuggestions(res);
        setShowSuggest(res.length > 0);
        setHighlightIdx(-1);
      } catch { setSuggestions([]); }
    }, 200);
  };

  const add = (code?: string) => {
    const c = code || normalizeCode(input);
    if (!c) { setInvalid(true); return; }
    setInvalid(false);
    setInput("");
    setSuggestions([]);
    setShowSuggest(false);
    onChange(codes.includes(c) ? codes : [...codes, c]);
  };

  const pickSuggestion = (s: StockSearchResult) => {
    add(s.code);
  };

  const removeCode = useCallback((code: string) => {
    onChange(codes.filter((c) => c !== code));
  }, [codes, onChange]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法选词期间的 Enter 不触发添加
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      if (showSuggest && highlightIdx >= 0 && highlightIdx < suggestions.length) {
        pickSuggestion(suggestions[highlightIdx]);
        return;
      }
      add();
      return;
    }
    if (!showSuggest || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      setShowSuggest(false);
    }
  };

  // 点击外部关闭建议
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowSuggest(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 添加 */}
      <div className="relative flex shrink-0 gap-1 border-b border-slate-700/30 p-1.5">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); setInvalid(false); triggerSearch(e.target.value); }}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length > 0 && setShowSuggest(true)}
          placeholder="代码/名称/拼音, 如 688126 / 茅台 / gzmt"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggest}
          aria-controls="watchlist-suggest"
          aria-activedescendant={
            highlightIdx >= 0 && suggestions[highlightIdx]
              ? `watchlist-opt-${suggestions[highlightIdx].code}`
              : undefined
          }
          className={`min-w-0 flex-1 rounded border bg-[#ede4d4] px-1.5 py-0.5 text-[11px] text-[#6b5b3e] outline-none placeholder:text-[#a8987e] ${
            invalid ? "border-rose-500/60" : "border-[#e0d5c0] focus:border-amber-500/50"
          }`}
        />
        <button
          onClick={() => add()}
          className="shrink-0 rounded bg-amber-500/20 px-2 text-[11px] text-amber-300 hover:bg-amber-500/30"
        >
          加
        </button>
        {/* 建议下拉 */}
        {showSuggest && (
          <div
            ref={suggestRef}
            id="watchlist-suggest"
            role="listbox"
            aria-label="股票搜索建议"
            className="absolute left-1.5 right-1.5 top-full z-50 mt-0.5 max-h-52 overflow-y-auto rounded border border-slate-600/50 bg-slate-800 shadow-lg"
          >
            {suggestions.map((s, i) => (
              <button
                key={s.code}
                id={`watchlist-opt-${s.code}`}
                role="option"
                aria-selected={i === highlightIdx}
                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                onMouseEnter={() => setHighlightIdx(i)}
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] transition-colors ${
                  i === highlightIdx ? "bg-amber-500/20 text-amber-200" : "text-[#6b5b3e] hover:bg-[#e0d5c0]"
                }`}
              >
                <span className="font-medium text-slate-100">{s.name}</span>
                <span className="text-[#a8987e]">{s.code}</span>
                {s.pinyin && <span className="ml-auto text-[#a8987e]">{s.pinyin}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {codes.map((code) => (
          <WatchRow key={code} code={code} onRemoveCode={removeCode} />
        ))}
        {codes.length === 0 && (
          <div className="p-4 text-center text-[10px] text-[#a8987e]">列表为空,输入代码/名称/拼音添加自选股</div>
        )}
      </div>
    </div>
  );
}

/** 自选股 / 持仓面板 — localStorage 持久化, 报价经统一报价中心; 支持弹出独立小窗 */
export function WatchlistPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [codes, setCodes] = useState<string[]>(load);
  const [floatOpen, setFloatOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(codes)); } catch { /* 隐私模式/配额满时忽略 */ }
  }, [codes]);

  return (
    <>
      <Panel
        className={className}
        {...zoomProps}
        title="自选股"
        icon="★"
        accent="#d4943a"
        right={
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#a8987e]">{codes.length}只 · 5s</span>
            <button
              type="button"
              onClick={() => setFloatOpen((v) => !v)}
              title={floatOpen ? "收回自选股小窗" : "弹出自选股独立小窗(可最小化/最大化/关闭)"}
              className="flex h-[18px] items-center gap-0.5 rounded border border-[#e0d5c0] bg-[#ede4d4] px-1 text-[10px] text-[#8b7a5e] transition-colors hover:border-[#d4943a]/60 hover:text-[#d4943a]"
            >
              {floatOpen ? "收回" : "弹出"}
            </button>
          </div>
        }
      >
        <WatchlistBody codes={codes} onChange={setCodes} />
      </Panel>

      {/* 独立自选股小窗: 与网格面板共享同一份 codes 状态 */}
      {floatOpen && (
        <FloatingWindow
          id="float-watchlist"
          title="自选股"
          icon="★"
          accent="#d4943a"
          onClose={() => setFloatOpen(false)}
          defaultWidth={420}
          defaultHeight={560}
          defaultX={Math.max(24, window.innerWidth - 460)}
          defaultY={560}
        >
          <div className="h-full">
            <WatchlistBody codes={codes} onChange={setCodes} />
          </div>
        </FloatingWindow>
      )}
    </>
  );
}