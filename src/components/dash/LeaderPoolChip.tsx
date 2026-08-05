/**
 * 核心标的参考池(市场实时热点 → 龙头股)状态组件
 *
 * 功能:
 *  - 每 15s 自动轮询 /api/philia/leader-pool, 与后端刷新节奏一致, 保证龙头股名单时效性
 *  - 手动刷新按钮(force=1 强制重建)
 *  - 变动追踪展示: 自上次刷新以来的 新增/移除/维持, 高亮区分
 *  - 打分权重与过滤门槛说明(可追溯、可验证)
 *
 * 定位方案: 下拉面板通过 createPortal 渲染到 document.body, 用 fixed 定位(基于触发按钮的
 * getBoundingClientRect ), 避免被面板/Grid 的 overflow 裁剪, 也避免与背景遮罩层产生 z-index
 * 拦截——从而根治"位置异常"与"刷新键点击失效"问题。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Layers, ArrowUpRight, ArrowDownRight, GitCompareArrows, ShieldCheck } from "lucide-react";
import { api, type PhiliaLeaderPool, type PhiliaLeaderValidateReport } from "@/lib/api";

const REFRESH_MS = 15000; // 与后端 15s 缓存一致

/** 评分 → 配色(越高越强) */
const scoreColor = (s: number) => (s >= 70 ? "#4a6b3f" : s >= 45 ? "#d4943a" : "#a8987e");

/** 封单占流通市值比例(%) → 可读字符串(保留两位小数) */
const fmtSealRatio = (v?: number) => (v == null ? "—" : `${v.toFixed(2)}%`);

/** 龙头股数据源各上游可用状态 → 可读标签 */
const metaSourceText = (s?: { boards?: boolean; ydPlate?: boolean; theme?: boolean; news?: boolean; fengBest?: boolean }) => {
  if (!s) return "市场板块实时热点(fengk-front) + 腾讯行情";
  const on = Object.values(s).filter(Boolean).length;
  return `市场实时热点(fengk-front)${on > 0 ? ` · ${on}源就绪` : ""}+ 腾讯行情`;
};

/** 时间戳 → HH:MM:SS */
const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function LeaderPoolChip() {
  const [pool, setPool] = useState<PhiliaLeaderPool | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);
  const [validateReport, setValidateReport] = useState<PhiliaLeaderValidateReport | null>(null);
  /** 打分权重手动输入(4 维百分比草稿, 顺序 seal,boardLimitUp,ladder,capital) */
  const [weightDraft, setWeightDraft] = useState({ seal: "40", boardLimitUp: "25", ladder: "20", capital: "15" });
  /** 已生效的权重字符串(用于轮询/重建), 未应用时为 undefined → 后端默认 */
  const weightsRef = useRef<string | undefined>(undefined);
  /** 下拉面板固定定位(视口坐标) */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = async (force = false, weights?: string) => {
    setLoading(true);
    try {
      const d = await api.philia.leaderPool(force, weights ?? weightsRef.current);
      setPool(d);
      setError("");
    } catch (e) {
      setError((e as Error)?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  };

  // 手动深度校验: 强制取最新数据源并全量比对龙头池
  const runValidate = async () => {
    setValidating(true);
    setError("");
    try {
      const r = await api.philia.validateLeaderPool();
      setValidateReport(r);
    } catch (e) {
      setError((e as Error)?.message || "校验失败");
    } finally {
      setValidating(false);
    }
  };

  // 应用手动输入的权重: 记录生效权重并强制重建龙头池
  const applyWeights = () => {
    const w = `${weightDraft.seal},${weightDraft.boardLimitUp},${weightDraft.ladder},${weightDraft.capital}`;
    weightsRef.current = w;
    load(true, w);
  };

  // 重置权重到默认(清空生效权重, 回退后端默认值)
  const resetWeights = () => {
    setWeightDraft({ seal: "40", boardLimitUp: "25", ladder: "20", capital: "15" });
    weightsRef.current = undefined;
    load(true);
  };

  // 15s 自动刷新 + 初始加载
  useEffect(() => {
    load();
    timer.current = setInterval(() => load(), REFRESH_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开时计算面板位置(相对按钮下方, 空间不足则翻转到上方), 并随滚动/缩放保持对齐
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const b = btn.getBoundingClientRect();
      const p = panelRef.current;
      const h = p ? p.offsetHeight : 360;
      const below = b.bottom + 4;
      // 下方放不下且上方有空间 → 翻转到按钮上方; 否则尽量贴近可见区域
      const top =
        below + h > window.innerHeight && b.top - h - 4 > 0
          ? b.top - h - 4
          : Math.max(8, Math.min(below, window.innerHeight - h - 4));
      setPos({ top, right: Math.max(8, window.innerWidth - b.right) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const added = pool?.change?.added?.length || 0;
  const removed = pool?.change?.removed?.length || 0;
  const kept = pool?.change?.kept?.length || 0;
  const pct = (w: number) => `${Math.round(w * 100)}%`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="核心标的参考池 · 市场实时热点龙头股(15s 自动刷新，点击展开)"
        className="flex items-center gap-1 rounded border border-[#4a6b3f]/40 bg-[#faf6ee] px-1.5 py-0.5 text-[9px] text-[#6b5b3e] transition-colors hover:border-[#4a6b3f]/80"
      >
        <Layers size={10} className="text-[#4a6b3f]" />
        <span className="font-bold">龙头池</span>
        <span className="tabular-nums text-[#4a6b3f]">{pool?.poolSize ?? "—"}</span>
        {added > 0 && (
          <span className="flex items-center gap-px rounded bg-[#4a6b3f]/15 px-1 text-[8px] font-bold text-[#4a6b3f]">
            <ArrowUpRight size={8} /> {added}
          </span>
        )}
        {removed > 0 && (
          <span className="flex items-center gap-px rounded bg-[#b8533a]/15 px-1 text-[8px] font-bold text-[#b8533a]">
            <ArrowDownRight size={8} /> {removed}
          </span>
        )}
        <span className="text-[8px] tabular-nums text-[#a8987e]">{pool ? fmtTime(pool.updatedAt) : ""}</span>
      </button>

      {open &&
        createPortal(
          <>
            {/* 背景遮罩: 点击关闭; 低于面板 z 层级, 不拦截面板内交互 */}
            <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
            {/* 下拉面板: 渲染到 body 顶层, 固定定位, 超高 z 层, 保证不被裁剪/不被遮罩拦截 */}
            <div
              ref={panelRef}
              className="fixed z-[70] w-80 max-w-[calc(100vw-16px)] rounded border border-[#d8cbb4] bg-[#faf6ee] p-2 shadow-newspaper-lg"
              style={{ top: pos?.top ?? 8, right: pos?.right ?? 8, visibility: pos ? "visible" : "hidden" }}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-[#e0d5c0]/70 pb-1">
                <span className="truncate text-[10px] font-bold text-[#4a6b3f]">核心标的参考池 · 龙头股</span>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-[8px] text-[#a8987e]">更新 {pool ? fmtTime(pool.updatedAt) : "—"}</span>
                  {/* 深度校验: 强制取最新数据源并全量比对龙头池 */}
                  <button
                    type="button"
                    onClick={runValidate}
                    disabled={validating}
                    title="校验龙头池与龙头股数据源是否一致"
                    className="flex items-center gap-0.5 rounded border border-[#4a6b3f]/30 px-1 py-0.5 text-[8px] text-[#8b7a5e] transition-colors hover:border-[#4a6b3f]/70 hover:text-[#6b5b3e] disabled:opacity-50"
                  >
                    <ShieldCheck size={9} className={validating ? "animate-pulse text-[#4a6b3f]" : "text-[#4a6b3f]"} />
                    校验
                  </button>
                  {/* 手动刷新(force 重建); 面板内触发, 优先于遮罩接收点击 */}
                  <button
                    type="button"
                    onClick={() => load(true)}
                    disabled={loading}
                    title="强制重建龙头股池"
                    className="flex items-center gap-0.5 rounded border border-[#4a6b3f]/30 px-1 py-0.5 text-[8px] text-[#8b7a5e] transition-colors hover:border-[#4a6b3f]/70 hover:text-[#6b5b3e] disabled:opacity-50"
                  >
                    <RefreshCw size={9} className={loading ? "animate-spin" : ""} />
                    刷新
                  </button>
                </div>
              </div>

              {/* 变动追踪 + 一致性校验状态 */}
              <div className="mb-1.5 flex items-center gap-2 text-[8px]">
                <span className="flex items-center gap-0.5 text-[#4a6b3f]">
                  <GitCompareArrows size={9} /> 新增 {added}
                </span>
                <span className="text-[#b8533a]">移除 {removed}</span>
                <span className="text-[#8b7a5e]">维持 {kept}</span>
                {pool?.validation && (
                  <span
                    className={`ml-auto flex items-center gap-0.5 rounded px-1 py-px font-bold ${
                      pool.validation.consistent
                        ? "bg-[#4a6b3f]/15 text-[#4a6b3f]"
                        : "bg-[#b8533a]/15 text-[#b8533a]"
                    }`}
                    title={pool.validation.consistent ? "与龙头股数据源一致, 无偏差" : `与数据源存在 ${pool.validation.mismatches.length} 处偏差`}
                  >
                    {pool.validation.consistent ? "✓ 数据一致" : `✗ 偏差 ${pool.validation.mismatches.length}`}
                  </span>
                )}
                {error && <span className="ml-auto text-[#b8533a]">{error}</span>}
              </div>

              {/* 打分权重手动输入 + 过滤说明(可追溯) */}
              {pool?.meta && (
                <div className="mb-1.5 rounded border border-[#e0d5c0]/60 bg-[#f5f0e6]/50 px-1.5 py-1 text-[8px] leading-relaxed text-[#8b7a5e]">
                  <div className="mb-1 flex items-center gap-1">
                    <span className="shrink-0 text-[#6b5b3e]">打分权重</span>
                    {(
                      [
                        ["seal", "封单"],
                        ["boardLimitUp", "涨停"],
                        ["ladder", "连板"],
                        ["capital", "资金"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-0.5">
                        <span className="text-[#a8987e]">{label}</span>
                        <input
                          type="number"
                          min={0}
                          value={weightDraft[key]}
                          onChange={(e) => setWeightDraft((d) => ({ ...d, [key]: e.target.value }))}
                          className="w-9 rounded border border-[#d8cbb4] bg-white px-0.5 py-px text-center text-[8px] text-[#6b5b3e] focus:border-[#4a6b3f] focus:outline-none"
                        />
                      </label>
                    ))}
                    <span className="text-[#a8987e]">%</span>
                  </div>
                  <div className="mb-1 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={applyWeights}
                      disabled={loading}
                      title="按输入权重强制重建龙头池"
                      className="rounded border border-[#4a6b3f]/40 px-1 py-px text-[8px] font-bold text-[#4a6b3f] transition-colors hover:bg-[#4a6b3f]/10 disabled:opacity-50"
                    >
                      应用权重
                    </button>
                    <button
                      type="button"
                      onClick={resetWeights}
                      disabled={loading}
                      title="恢复默认权重(40/25/20/15)"
                      className="rounded border border-[#d8cbb4] px-1 py-px text-[8px] text-[#a8987e] transition-colors hover:border-[#b8533a]/50 hover:text-[#b8533a] disabled:opacity-50"
                    >
                      重置
                    </button>
                    <span className="ml-auto text-[#a8987e]">
                      当前: {pct(pool.meta.weights.seal)}/{pct(pool.meta.weights.boardLimitUp)}/{pct(pool.meta.weights.ladder)}/
                      {pct(pool.meta.weights.capital)}
                    </span>
                  </div>
                  <div>
                    过滤: 总市值 ≤ {pool.meta.filters.totalMarketCapMax}亿
                    {pool.meta.filters.excludePrefixes?.length
                      ? ` · 剔除 ${pool.meta.filters.excludePrefixes.map((p) => (p === "688" ? "科创板" : p === "300" ? "创业板" : `${p}*`)).join("/")}`
                      : ""}{" "}
                    · {pool.meta.sourceLabel || metaSourceText(pool.meta.source)}
                  </div>
                </div>
              )}

              {/* 深度校验报告 */}
              {validateReport && (
                <div
                  className={`mb-1.5 rounded border px-1.5 py-1 text-[8px] leading-relaxed ${
                    validateReport.report.consistent
                      ? "border-[#4a6b3f]/40 bg-[#4a6b3f]/8 text-[#4a6b3f]"
                      : "border-[#b8533a]/40 bg-[#b8533a]/8 text-[#b8533a]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold">
                      {validateReport.report.consistent ? "✓ 深度校验通过" : `✗ 深度校验发现 ${validateReport.report.mismatches.length} 处偏差`}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[#8b7a5e]">
                    {validateReport.report.consistent
                      ? validateReport.note
                      : validateReport.report.mismatches.map((m) => `${m.name}(${m.code}) ${m.field} 池=${m.poolVal} 源=${m.baseVal}`).join("；")}
                  </div>
                  <div className="mt-0.5 text-[#a8987e]">
                    数据源 {validateReport.report.poolSize} 只 · 板块 {validateReport.report.sourceSectors} · 校验于 {fmtTime(validateReport.checkedAt)}
                  </div>
                </div>
              )}

              {/* 龙头股列表 */}
              <div className="max-h-64 min-h-0 overflow-y-auto">
                {(pool?.pool || []).map((s) => (
                  <div
                    key={s.code}
                    className="flex items-center gap-1.5 rounded border border-transparent px-1 py-0.5 hover:border-[#e0d5c0]"
                  >
                    <span
                      className="w-6 shrink-0 text-center text-[9px] font-bold tabular-nums"
                      style={{ color: scoreColor(s.score) }}
                    >
                      {s.score}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[9px] font-bold text-[#6b5b3e]">
                        {s.name} <span className="font-normal text-[#a8987e]">{s.code}</span>
                      </span>
                      <span className="block truncate text-[8px] text-[#a8987e]">
                        {s.board} · 连板{s.ladder} · {s.boardLimitUp}家涨停 · 流通{s.floatMarketCap}亿
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[8px] tabular-nums text-[#8b7a5e]">
                        封单占流通 {fmtSealRatio(s.sealRatio)}
                      </span>
                      <span className="block text-[8px] tabular-nums text-[#a8987e]">分{s.score}</span>
                    </span>
                  </div>
                ))}
                {!pool?.pool?.length && (
                  <p className="py-3 text-center text-[9px] text-[#a8987e]">
                    {loading ? "加载中…" : "暂无可用的龙头股数据"}
                  </p>
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </>
  );
}