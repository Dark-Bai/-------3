import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { Inbox, Search, Loader2 } from "lucide-react";
import { api, type StockSearchResult } from "@/lib/api";
import { setSharedPollStock } from "./MarketReviewSection";
import { onPhiliaSync, postPhiliaSync } from "@/lib/philiaSync";

/* ---------------- 模块级「当前个股」共享状态 ----------------
 * 主面板 / PHILIA 小窗 / /philia 独立页共用同一份状态:
 *  - 同页面内任一实例编辑(输入/选中/拖入) → setStockState → 其他实例(主面板/小窗)实时镜像;
 *  - 跨标签页经 philia-stock 广播: 模块加载时订阅一次, 收到即更新本页状态(不反向广播, 防循环);
 *  - 每次变更同时同步 setSharedPollStock(自动轮询带个股再判断)。
 */
interface StockState { stock: { code?: string; name?: string } | null; }
let stockState: StockState = { stock: null };
const stockListeners = new Set<() => void>();
function subscribeStockState(fn: () => void) {
  stockListeners.add(fn);
  return () => { stockListeners.delete(fn); };
}
function setStockState(s: { code?: string; name?: string } | null) {
  stockState.stock = s;
  for (const l of [...stockListeners]) l();
  setSharedPollStock(s); // 同步自动轮询个股
}
// 模块级订阅跨页个股广播(每个标签页一次): 主页→/philia 镜像, /philia 独立模式编辑→主页同步
onPhiliaSync((msg) => {
  if (msg.type === "philia-stock") setStockState(msg.stock || null);
});

export interface PhiliaStockBoxProps {
  /** 镜像模式(/philia 页主页面存在时): 输入/拖放禁用, 仅展示共享状态中的个股 */
  mirror?: boolean;
  /** 点「查收」回调(与分析键共享, 生成个股意见) */
  onCheck?: (stock: { code?: string; name?: string }) => void;
  /** 当前个股变化回调(编辑或外部同步时) */
  onStockChange?: (stock: { code?: string; name?: string } | null) => void;
}

/**
 * PHILIA 个股输入小窗(搜索索引 + 拖放 + 查收), 主面板 / PHILIA 小窗 / /philia 独立页共用。
 * 值来自模块级共享状态: 同页面实例(主面板↔小窗)自动镜像; 跨标签页经 philia-stock 广播。
 *  - 非镜像(主面板/小窗/独立模式): 编辑时更新共享状态并跨页广播, 自动轮询带该个股再判断;
 *  - 镜像(/philia 页主页面存在时): 输入禁用, 仅镜像共享状态(主页广播来的个股), 不独立查询。
 */
export function PhiliaStockBox({ mirror = false, onCheck, onStockChange }: PhiliaStockBoxProps) {
  // 受控于模块级共享状态: 任一实例编辑/跨页广播都会同步到所有实例
  const stock = useSyncExternalStore(subscribeStockState, () => stockState.stock, () => stockState.stock);
  const stockQ = stock?.name || stock?.code || "";
  const stockCode = stock?.code || "";
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 搜索意图: 仅「手动击键输入」置 true → 才触发索引下拉; 拖入/索引选中/外部同步置 false(内容已完整正确, 不出现索引栏)
  const searchIntent = useRef(false);
  // 本实例最近一次编辑标记: 手动输入/选中/拖入置 true, 供「stock 变化」effect 区分本实例编辑与外部同步,
  // 避免本实例输入后被 effect 误关 searchIntent 导致索引栏不出现
  const localEditRef = useRef(false);

  // 个股变化(本实例编辑或外部同步)时通知父级(供手动「重新分析」带上个股), 并清空本实例搜索下拉
  const lastStock = useRef(stock);
  useEffect(() => {
    // 外部同步/镜像更新: 非本实例编辑, 关闭搜索意图(防止其他实例输入时本实例也弹索引)
    if (!localEditRef.current) searchIntent.current = false;
    localEditRef.current = false;
    if (lastStock.current !== stock) { setSearchResults([]); lastStock.current = stock; }
    onStockChange?.(stock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock]);

  /** 编辑路径: 更新共享状态(同页所有实例镜像) + 跨页广播(非镜像时) */
  const updateStock = (s: { code?: string; name?: string } | null) => {
    setStockState(s);
    if (!mirror) postPhiliaSync({ type: "philia-stock", stock: s });
  };

  // 搜索索引(防抖 300ms, 与自选股搜索同源): 仅手动输入时触发; 镜像模式/拖入/索引选中/外部同步均不出现索引栏
  useEffect(() => {
    if (mirror || !searchIntent.current) { setSearchResults([]); return; }
    const q = stockQ.trim();
    if (q.length < 1) { setSearchResults([]); return; }
    let dead = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.stockSearch(q);
        if (!dead) setSearchResults(r || []);
      } catch { if (!dead) setSearchResults([]); }
      finally { if (!dead) setSearching(false); }
    }, 300);
    return () => { dead = true; clearTimeout(timer); };
  }, [stockQ, mirror]);

  /** 查收: 精确代码优先(搜索选中/拖入), 其次 6 位代码, 最后按名称 */
  const handleCheck = () => {
    const q = stockQ.trim();
    if (!q) return;
    if (stockCode) onCheck?.({ code: stockCode });
    else if (/^\d{6}$/.test(q)) onCheck?.({ code: q });
    else onCheck?.({ name: q });
  };

  /** 点击搜索索引结果: 输入框显示名称, 记录精确代码, 更新共享状态并广播(内容已完整, 不再触发索引) */
  const handlePickStock = (s: StockSearchResult) => {
    searchIntent.current = false;
    localEditRef.current = true;
    setSearchResults([]);
    updateStock({ code: s.code, name: s.name });
  };

  /** 搜索框拖放目标: 仅接受自选股卡片/词条拖入(x-stock / text/plain); 镜像模式不响应 */
  const handleStockDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (mirror) return;
    if (e.dataTransfer.types.includes("application/x-stock") || e.dataTransfer.types.includes("text/plain")) {
      e.preventDefault();
      // dropEffect 必须在源 effectAllowed 允许的范围内(HTML5 DnD 规范):
      // 自选股卡片/词条 dragstart 设 effectAllowed="move", 若此处设 "copy" 会因效果不兼容导致 drop 不触发
      const allowed = e.dataTransfer.effectAllowed;
      e.dataTransfer.dropEffect = ["copy", "copyLink", "copyMove", "all", "uninitialized"].includes(allowed) ? "copy" : "move";
      setDragOver(true);
    }
  };
  /** 松开拖放: 名称填入输入框 + 记录精确代码, 更新共享状态并广播(内容已完整正确, 不出现索引栏) */
  const handleStockDrop = (e: DragEvent<HTMLDivElement>) => {
    if (mirror) return;
    e.preventDefault();
    setDragOver(false);
    let code = "";
    let name = "";
    const raw = e.dataTransfer.getData("application/x-stock");
    if (raw) {
      try {
        const p = JSON.parse(raw);
        if (p?.code) code = String(p.code);
        if (p?.name) name = String(p.name);
      } catch { /* 非法数据忽略 */ }
    }
    if (!code) code = e.dataTransfer.getData("text/plain");
    code = String(code || "").replace(/\D/g, "").slice(-6);
    if (!code) return;
    searchIntent.current = false; // 拖入: 非手动输入, 关闭搜索意图(不出现索引栏)
    localEditRef.current = true;
    setSearchResults([]);
    updateStock({ code, name });
  };

  /** 手动编辑: 清空已选代码, 按当前文本更新共享状态; 仅此路径开启搜索意图(索引下拉) */
  const handleInputChange = (v: string) => {
    searchIntent.current = true; // 手动击键: 允许索引下拉
    localEditRef.current = true;
    setSearchResults([]);
    const t = v.trim();
    updateStock(/^\d{6}$/.test(t) ? { code: t } : t ? { name: t } : null);
  };

  return (
    <div
      className={`relative flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors ${
        dragOver ? "border-[#d4943a] bg-[#f8ead0]" : "border-[#e0d5c0] bg-[#f5f0e6]"
      } ${mirror ? "opacity-80" : ""}`}
      onDragOver={handleStockDragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={handleStockDrop}
      title={dragOver ? "松开填入该个股" : mirror ? "镜像主页个股(主页面打开时 /philia 纯镜像, 不可编辑)" : "输入/搜索或拖入自选股填入个股"}
    >
      <Search size={11} className="shrink-0 text-[#c9b99a]" />
      <input
        type="text"
        value={stockQ}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleCheck();
          else if (e.key === "Escape") setSearchResults([]);
        }}
        disabled={mirror}
        placeholder={mirror ? "镜像主页个股…" : "填个股(代码/名称/拼音)"}
        title="支持搜索索引: 输入名称/代码/拼音后下拉联想, 点击选中即按精确代码查收; 也可直接输入6位代码或拖入自选股"
        className="w-32 bg-transparent text-[12px] text-[#6b5b3e] outline-none placeholder:text-[#c9b99a] disabled:cursor-not-allowed"
      />
      {searching && <Loader2 size={11} className="shrink-0 animate-spin text-[#a8987e]" />}
      {stockCode && <span className="shrink-0 text-[9px] text-[#4a6b3f]">{stockCode}</span>}
      <button
        type="button"
        onClick={() => handleCheck()}
        disabled={!stockQ.trim()}
        title="查收: 仅显示该个股已有分析结果(不触发新分析); 缓存无数据时提示用『重新分析』生成"
        className="flex items-center gap-0.5 rounded bg-[#4a6b3f] px-1.5 py-0.5 text-[11px] font-bold text-[#faf6ee] transition-colors hover:bg-[#3d5940] disabled:opacity-40"
      >
        <Inbox size={11} />
        查收
      </button>
      {/* 搜索索引下拉(名称/代码/拼音联想) */}
      {!mirror && searchResults.length > 0 && (
        <div className="absolute right-0 top-full z-40 mt-1 max-h-56 w-64 overflow-y-auto rounded border border-[#e0d5c0] bg-[#faf6ee] shadow-md">
          {searchResults.map((s) => (
            <button
              key={s.code}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // 阻止先触发 blur, 保证点击可选中
              onClick={() => handlePickStock(s)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[#ede4d4]"
              title={`${s.name} ${s.code}`}
            >
              <span className="font-semibold text-[#6b5b3e]">{s.name}</span>
              <span className="tabular-nums text-[#a8987e]">{s.code}</span>
              {s.pinyin && <span className="text-[9px] text-[#c9b99a]">{s.pinyin}</span>}
              {s.code === stockCode && <span className="ml-auto text-[9px] text-[#4a6b3f]">已选</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
