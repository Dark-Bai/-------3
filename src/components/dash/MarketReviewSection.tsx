/**
 * 龙头情绪复盘(4 模块): 今日龙头核心 / 今日情绪周期 / 今日机会 / 今日风险
 *
 * 由一个「启动 AI 综合分析」按钮触发, 调用后端 /api/philia/market-analyze(LLM),
 * 一次性返回 4 个结构化模块, 前端分卡片清晰展示。
 * 交互: 启动按钮 + 加载状态提示 + 结果展示区 + 重新分析(force)。
 *
 * 本次增强:
 *  - 「今日龙头核心」「今日情绪周期」缩放至 70%(字体/容器), 为「今日机会/今日风险」预留 ≥320px 空间
 *  - 每条主观信息旁标注 skill 来源(参考: 思路 - 战法N)
 *  - 具投资机会的标的标注建议仓位(固定四级分类: 小/中/大/满)
 *  - 「今日情绪周期」旁给出整体操作建议(依据 skill 语气风格)
 *  - 「今日机会」「今日风险」可弹出为独立小窗(FloatingWindow), 彼此并存、支持最小化/最大化/关闭
 */
import { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isMainPageAlive, onPhiliaSync, postPhiliaSync } from "@/lib/philiaSync";
import {
  Sparkles,
  Loader2,
  RefreshCw,
  Crown,
  Gauge,
  TrendingUp,
  AlertTriangle,
  Maximize2,
  History,
  ExternalLink,
} from "lucide-react";
import { api, type PhiliaMarketAnalysis, type PhiliaDataSource } from "@/lib/api";
import { usePhilia } from "./PhiliaContext";
import { FloatingWindow } from "./FloatingWindow";
import { ThinkingProcessButton } from "./ThinkingProcessButton";
import { usePhiliaPolling } from "@/hooks/usePhiliaPolling";
import { MirrorContext } from "./Panel";

/* ---------- 设计参数(需求中的占位符取值) ---------- */
const SPACE_PX = 320; // 为「今日机会/今日风险」预留的最小显示空间(px)
const ANNOTATION_COLOR = "#8b7a5e"; // 来源标注字体颜色
const POSITION_COLOR = "#4a6b3f"; // 建议仓位字体颜色
const POSITION_BG = "#e8f2e8"; // 建议仓位背景色
const SUGGESTION_COLOR = "#d4943a"; // 操作建议颜色
const SUGGESTION_FONT = "font-newspaper-heading"; // 操作建议字体
const SUGGESTION_SIZE = 14; // 操作建议字号(px)

/** 金融标的蓝色标注色(最小字号文本中出现标的时高亮) */
const TARGET_COLOR = "#1d4ed8";

/** 建议仓位四级分类的配色(小/中/大/满) */
const POS_LEVEL_STYLE: Record<string, { color: string; bg: string }> = {
  小: { color: "#3f7d3f", bg: "#e6f2e6" },
  中: { color: "#b8860b", bg: "#faf3d9" },
  大: { color: "#d4943a", bg: "#f8ead0" },
  满: { color: "#b8533a", bg: "#f7e3dc" },
};

/** 将任意仓位输入(四档文字 / 数字 / 百分数 / 历史旧数据)统一归一化为四级分类: 小/中/大/满 */
function toPosLevel(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/满/.test(s)) return "满";
  if (/大/.test(s)) return "大";
  if (/中/.test(s)) return "中";
  if (/小/.test(s)) return "小";
  const n = Number(s.replace(/[%％]/g, ""));
  if (Number.isFinite(n)) {
    // 0-1 小数视为仓位占比(如 0.3=30%), 其余按 0-100 分档
    const pct = n > 0 && n < 1 ? n * 100 : n;
    if (pct <= 25) return "小";
    if (pct <= 50) return "中";
    if (pct <= 75) return "大";
    return "满";
  }
  return null;
}

/** 将文本中的已知金融标的名称(如龙头个股)以蓝色高亮; 证券代码(600519/sh603618)保持原色 */
function highlightTargets(text: string, names: string[] = []): ReactNode {
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const namePats = names
    .map(esc)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!namePats.length) return String(text ?? "");
  const re = new RegExp(`(${namePats.join("|")})`, "gi");
  const parts = String(text ?? "").split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <span key={i} style={{ color: TARGET_COLOR, fontWeight: 600 }}>{p}</span>
    ) : (
      p
    )
  );
}

/** 情绪阶段 → 配色 */
const STAGE_META: Record<string, { color: string; bg: string }> = {
  冰点: { color: "#a8987e", bg: "rgba(168,152,126,0.15)" },
  回暖: { color: "#4a6b3f", bg: "rgba(74,107,63,0.15)" },
  高潮: { color: "#d4943a", bg: "rgba(212,148,58,0.15)" },
  退潮: { color: "#b8533a", bg: "rgba(184,83,58,0.15)" },
};
const stageMeta = (s: string) => {
  const key = (Object.keys(STAGE_META) as (keyof typeof STAGE_META)[]).find((k) => (s || "").includes(k));
  return STAGE_META[key || "回暖"] || STAGE_META["回暖"];
};

/** 风险等级配色 */
const RISK_COLOR: Record<string, string> = { 高: "#b8533a", 中: "#d4943a", 低: "#4a6b3f" };

/** 时间戳 → HH:MM */
const fmtTime = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 来源标注: 具体章节/编号(字体为正文 80%) */
function SourceTag({
  sourceRef,
  skill,
  tactic,
  size = 9,
}: {
  sourceRef?: string;
  skill?: string;
  tactic?: string;
  size?: number;
}) {
  let text = "";
  if (sourceRef) {
    // 去掉文件名前缀, 仅保留「章节 · 模型」等精确条目
    const ref = sourceRef.replace(/^youzi-qijie-jinghua\/SKILL\.md\s*·\s*/, "");
    text = `来源：${ref}`;
  } else if (skill || tactic) {
    text = `来源：${skill || "游资思路"}${tactic ? ` - 战法${tactic}` : ""}`;
  } else {
    return null;
  }
  return (
    <span className="block truncate" title={text} style={{ color: ANNOTATION_COLOR, fontSize: size }}>
      {text}
    </span>
  );
}

/** 建议仓位标识: 固定四级分类(小/中/大/满), 置于标的名称后方, 按档配色凸显 */
function PositionChip({ position, size = 10 }: { position?: string | number | null; size?: number }) {
  const level = toPosLevel(position);
  if (!level) return null;
  const st = POS_LEVEL_STYLE[level] || { color: POSITION_COLOR, bg: POSITION_BG };
  return (
    <span
      className="inline-block shrink-0 rounded px-1 py-px font-bold leading-tight"
      style={{ color: st.color, backgroundColor: st.bg, fontSize: size }}
    >
      建议仓位：{level}
    </span>
  );
}

/** 机会明细列表(供面板预览与独立小窗复用) */
function OpportunitiesBody({ opportunities, names }: { opportunities: PhiliaMarketAnalysis["result"]["opportunities"]; names?: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(opportunities || []).map((o, i) => (
        <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/70 px-2 py-1.5">
          <div className="flex flex-wrap items-center gap-x-1">
            <span className="text-[14px] font-bold text-[#6b5b3e]">
              {o.type} · {o.sector}
            </span>
            <PositionChip position={o.position} size={11} />
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[#8b7a5e]">{highlightTargets(o.analysis, names)}</p>
          {o.opportunity && <p className="mt-1 text-[12px] text-[#4a6b3f]">机会点：{highlightTargets(o.opportunity, names)}</p>}
          <SourceTag sourceRef={o.sourceRef} skill={o.skill} tactic={o.tactic} size={10} />
        </div>
      ))}
    </div>
  );
}

/** 风险明细列表(供面板预览与独立小窗复用) */
function RisksBody({ risks, names }: { risks: PhiliaMarketAnalysis["result"]["risks"]; names?: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(risks || []).map((rk, i) => (
        <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/70 px-2 py-1.5">
          <div className="flex items-center gap-1">
            <span
              className="rounded px-1 py-px text-[12px] font-bold text-white"
              style={{ backgroundColor: RISK_COLOR[rk.level] || "#d4943a" }}
            >
              {rk.level}
            </span>
            <span className="text-[14px] font-bold text-[#6b5b3e]">{rk.scope || "风险"}</span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[#8b7a5e]">{highlightTargets(rk.description, names)}</p>
          {rk.mitigation && <p className="mt-1 text-[12px] text-[#4a6b3f]">应对：{highlightTargets(rk.mitigation, names)}</p>}
          <SourceTag sourceRef={rk.sourceRef} skill={rk.skill} tactic={rk.tactic} size={10} />
        </div>
      ))}
    </div>
  );
}

export interface MarketReviewSectionHandle {
  /** 启动 AI 综合分析; force=true 强制绕过缓存 */
  run: (force?: boolean) => Promise<void>;
}

// 模块级共享分析状态(主面板 + 悬浮小窗共用)。
// 原因: Panel 在放大成悬浮小窗时会同时渲染两份 MarketReviewSection(网格内 section + FloatingWindow 内),
// 若各自持有本地 state, 会造成"小窗显示轮询中、主面板不同步"的错位。这里把结果/加载/刷新/错误/轮询日志
// 全部提升到模块级广播, 所有实例读到同一份值, 小窗仅作为主面板的纯镜像, 不各自持有轮询日志。
interface PollLogEntry {
  id: number;
  /** 触发来源: 手动(启动/重新分析) 或 自动轮询 */
  kind: "manual" | "poll";
  start: string;
  end?: string;
  duration?: number;
  error?: string;
  /** 是否命中 30min 降频缓存(未重新调用 LLM, 数据时间不等于本次触发时间) */
  cached?: boolean;
}
interface SharedReviewState {
  analysis: PhiliaMarketAnalysis | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  pollLogs: PollLogEntry[];
  /** 手动分析(重新分析按钮)版本号: 每次开始一次新的手动分析时递增, 用于"最新一次分析胜出"的并发消解 */
  loadingVer: number;
  /** 自动轮询版本号: 每次开始一次新的轮询时递增, 与手动分析版本号相互独立, 避免并发时无法清除各自的加载态 */
  refreshingVer: number;
}
const reviewState: SharedReviewState = {
  analysis: null,
  loading: false,
  refreshing: false,
  error: "",
  pollLogs: [],
  loadingVer: 0,
  refreshingVer: 0,
};
const reviewListeners = new Set<() => void>();
/** 是否正在套用远端消息: 套用远端时不广播, 避免跨标签页循环同步 */
let applyingRemote = false;
const setReview = (p: Partial<SharedReviewState>) => {
  Object.assign(reviewState, p);
  for (const l of [...reviewListeners]) l();
  // 广播完整共享状态, 让其他标签页(新页面/主页)同步所有按钮的实时状态与数据
  if (!applyingRemote) postPhiliaSync({ type: "philia-state", state: { ...reviewState } });
};
/** 套用远端标签页广播来的完整状态(不反向广播, 防循环)。
 *  版本号守卫: 当本地在「手动分析」与「自动轮询」两个维度都严格领先于远端时,
 *  忽略较旧的远端状态, 避免旧标签页覆盖新状态; 任一维度远端更新则采用远端(保证并发时不丢加载态)。 */
const applyRemoteState = (s: SharedReviewState) => {
  const rLoading = s.loadingVer ?? 0;
  const rRefreshing = s.refreshingVer ?? 0;
  if (rLoading < (reviewState.loadingVer ?? 0) && rRefreshing < (reviewState.refreshingVer ?? 0)) return;
  applyingRemote = true;
  try {
    Object.assign(reviewState, s);
    for (const l of [...reviewListeners]) l();
  } finally {
    applyingRemote = false;
  }
};
const subscribeReview = (fn: () => void) => {
  reviewListeners.add(fn);
  return () => {
    reviewListeners.delete(fn);
  };
};

/** 最近一份配置的技能列表(供模块级轮询用, 与实例无关) */
let sharedSkills: string[] = [];
function setSharedSkills(skills: string[]) {
  sharedSkills = skills;
}

/** 全局轮询序号(跨实例共享, 保证日志 id 唯一) */
let pollSeq = 0;
const fmt = (t = Date.now()) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
/** 记录一次分析/轮询日志的开始, 返回 end(error?, cached?) 回调用于补全结束时间/耗时/错误/缓存命中 */
function beginPollLog(kind: "manual" | "poll" = "poll"): { id: number; end: (err?: string, cached?: boolean) => void } {
  const id = ++pollSeq;
  const t0 = Date.now();
  setReview({ pollLogs: [{ id, kind, start: fmt(t0) }, ...reviewState.pollLogs].slice(0, 20) });
  return {
    id,
    end: (err?: string, cached?: boolean) => {
      const dur = Date.now() - t0;
      setReview({
        pollLogs: reviewState.pollLogs.map((l) =>
          l.id === id ? { ...l, end: fmt(), duration: dur, error: err, cached: cached === true } : l
        ),
      });
    },
  };
}
/** 模块级轮询: 由单例定时器驱动, 更新共享状态与共享日志(主面板与小窗同步显示) */
async function runGlobalPoll(): Promise<void> {
  const t0 = Date.now();
  const log = beginPollLog("poll");
  const refreshingVer = reviewState.refreshingVer + 1;
  setReview({ refreshing: true, refreshingVer });
  console.log(`[PHILIA轮询] 开始 ${fmt(t0)}`);
  let errMsg: string | undefined;
  let cachedHit = false;
  try {
    const d = await api.philia.marketAnalyze({ skills: sharedSkills, force: true });
    // 仅当本次轮询仍是最新(未被新轮询覆盖)时才写入结果, 避免旧轮询覆盖新轮询
    if (reviewState.refreshingVer === refreshingVer) setReview({ analysis: d }); // setReview 会自动广播完整状态, 同步轮询结果到其他标签页
    cachedHit = d.fromCache === true;
  } catch (e) {
    // 失败时保留当前内容, 但必须显式记录错误, 便于确认轮询"已完成却未更新"的真实原因
    errMsg = (e as Error)?.message || "请求失败";
    console.error(`[PHILIA轮询] 失败 ${fmt()} · 耗时 ${Date.now() - t0}ms · ${errMsg}`);
  } finally {
    if (reviewState.refreshingVer === refreshingVer) setReview({ refreshing: false });
    log.end(errMsg, cachedHit);
    console.log(`[PHILIA轮询] 结束 ${fmt()} · ${errMsg ? "失败" : "成功"} · 耗时 ${Date.now() - t0}ms`);
  }
}

export const MarketReviewSection = forwardRef<MarketReviewSectionHandle, { standalone?: boolean }>(
  function MarketReviewSection({ standalone = false }, ref) {
  const { config, configLoaded } = usePhilia();
  // 是否渲染在悬浮小窗内(纯镜像模式): 小窗断开轮询/启动等交互, 仅实时镜像主面板 PHILIA 数据
  const isMirror = useContext(MirrorContext);
  // 主页面心跳: 仅 /philia 独立页面(standalone)需要判断主页面是否仍打开。
  // 主页面存在 → 纯镜像其结果, 不独立轮询/自动查询; 主页面关闭 → 独立调取结果。
  const [mainAlive, setMainAlive] = useState(isMainPageAlive);
  useEffect(() => {
    if (!standalone) return;
    const check = () => setMainAlive(isMainPageAlive());
    check();
    const t = window.setInterval(check, 2000);
    const unsub = onPhiliaSync((msg) => {
      if (msg.type === "philia-main-beat") setMainAlive(true);
    });
    return () => {
      window.clearInterval(t);
      unsub();
    };
  }, [standalone]);
  // 订阅共享状态: 结果/加载/刷新/错误/日志在各实例间保持一致(小窗为纯镜像)
  const analysis = useSyncExternalStore(subscribeReview, () => reviewState.analysis, () => reviewState.analysis);
  const loading = useSyncExternalStore(subscribeReview, () => reviewState.loading, () => reviewState.loading);
  const refreshing = useSyncExternalStore(subscribeReview, () => reviewState.refreshing, () => reviewState.refreshing);
  const error = useSyncExternalStore(subscribeReview, () => reviewState.error, () => reviewState.error);
  const pollLogs = useSyncExternalStore(subscribeReview, () => reviewState.pollLogs, () => reviewState.pollLogs);
  // 同步最新技能列表至模块级(供全局轮询使用)
  useEffect(() => {
    setSharedSkills(config?.skills || []);
  }, [config]);
  // 订阅跨标签页同步: 任意标签页触发分析/轮询后, 把完整共享状态同步到本页(所有按键实时状态一致)。
  // 新标签页(/philia)打开时广播「同步请求」, 主面板收到后把当前完整状态推过来, 避免空白。
  useEffect(() => {
    postPhiliaSync({ type: "philia-sync-request" });
    return onPhiliaSync((msg) => {
      if (msg.type === "philia-sync-request") {
        // 响应其他标签页的同步请求: 把本页当前完整状态(含 loadingVer/refreshingVer)推给对方
        postPhiliaSync({ type: "philia-state", state: { ...reviewState } });
      } else if (msg.type === "philia-state" && msg.state) {
        applyRemoteState(msg.state as SharedReviewState);
      }
    });
  }, []);

  const [showSrc, setShowSrc] = useState(false);
  // 「今日机会」「今日风险」独立小窗: 可同时开启
  const [floats, setFloats] = useState<{ opportunities: boolean; risks: boolean }>({ opportunities: false, risks: false });
  const toggleFloat = (k: "opportunities" | "risks") => setFloats((f) => ({ ...f, [k]: !f[k] }));

  // 并发防抖: 用 ref 记录是否已在分析中, 防止小窗 onClick 冒泡 + 按钮点击造成重复请求
  const runningRef = useRef(false);
  const run = async (force = false) => {
    if (runningRef.current) return;
    // 配置未就绪时跳过: 空技能会命中/写入与轮询不同的缓存槽, 导致显示陈旧数据。
    // 首次挂载的场景由 PhiliaPanel 在 configLoaded 后重新触发兜底。
    if (!config) return;
    const skills = config.skills || [];
    runningRef.current = true;
    // 手动分析使用独立版本号(loadingVer), 与自动轮询(refreshingVer)互不干扰,
    // 保证手动分析与轮询并发时都能在 finally 中正确清除各自的加载态, 避免按钮永久置灰
    const loadingVer = reviewState.loadingVer + 1;
    setReview({ loading: true, error: "", loadingVer });
    // 手动分析(启动/重新分析)同样记录到日志, 便于与轮询日志一同核对触发节奏
    const log = beginPollLog("manual");
    let errMsg: string | undefined;
    let cachedHit = false;
    try {
      const d = await api.philia.marketAnalyze({ skills, force });
      // 仅当本次分析仍是最新(未被新分析覆盖)时才写入结果, 避免旧分析覆盖新分析
      if (reviewState.loadingVer === loadingVer) setReview({ analysis: d });
      cachedHit = d.fromCache === true;
    } catch (e) {
      errMsg = (e as Error)?.message || "分析失败";
      if (reviewState.loadingVer === loadingVer) setReview({ error: errMsg });
    } finally {
      runningRef.current = false;
      // 仅当本次分析仍是最新时才结束 loading, 否则让更新的分析继续持有加载态
      if (reviewState.loadingVer === loadingVer) setReview({ loading: false });
      log.end(errMsg, cachedHit);
    }
  };

  // 暴露给父级(PhiliaPanel)回调的命令式句柄
  useImperativeHandle(ref, () => ({
    run,
  }));

  // 「日志」小窗展开状态(纯 UI, 各实例独立互不影响)
  const [showLogs, setShowLogs] = useState(false);

  // 自动轮询: 单例定时器驱动 runGlobalPoll(模块级共享函数, 更新同一份共享状态)。
  // 注意: 小窗(镜像)也必须注册同一回调, 不能传空回调——否则空回调会覆盖主面板注册的真实回调,
  // 导致打开小窗后单例定时器触发的是空操作, 主页轮询随之暂停。
  // 小窗本身仍无轮询按钮、仍为纯镜像, 只是不抢占/破坏共享的轮询回调。
  // 轮询开关: 主页面(standalone=false)始终自行轮询; /philia 新页面(standalone=true)仅在主页面关闭时
  // 才独立轮询调取结果, 主页面存在时纯镜像其结果、不独立查询, 避免日志出现重复查询。
  const pollTick = useCallback(() => {
    runGlobalPoll();
  }, []);
  const noopTick = useCallback(() => {}, []);
  const pollEnabled = !standalone || !mainAlive;
  const pollOnTick = pollEnabled ? pollTick : noopTick;
  const { enabled, active, transition, toggle } = usePhiliaPolling(pollOnTick);

  // /philia 独立模式兜底: 当主页面关闭、/philia 独立打开时, 自动触发一次分析以直接展示数据。
  // 主页面存在时(镜像模式)不触发, 仅镜像主页结果。
  const standaloneAutoRef = useRef(false);
  useEffect(() => {
    if (standalone && !mainAlive && configLoaded && !standaloneAutoRef.current) {
      standaloneAutoRef.current = true;
      void run(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standalone, mainAlive, configLoaded]);

  const r = analysis?.result;
  const sources: PhiliaDataSource[] = r?.sources || [];
  // 蓝色高亮标的名称集合: 优先取后端汇总的 targets(龙头+机会+风险), 兼容旧数据回退到龙头名
  const leaderNames = (r?.leaderCore?.leaders || []).map((l) => l.name).filter(Boolean);
  const highlightNames = (r?.targets && r.targets.length ? r.targets : leaderNames);
  const highlight = (text: string): ReactNode => highlightTargets(text, highlightNames);

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5 p-2">
      {/* 顶部操作区: 启动按钮 + 状态 + 重新分析(主面板显示; 镜像小窗隐藏, 仅镜像数据) */}
      {!isMirror && (
      <div className="flex flex-wrap items-center gap-2 rounded border border-[#d4943a]/40 bg-gradient-to-b from-[#faf6ee] to-[#ede4d4] px-3 py-1.5">
        <button
          type="button"
          onClick={() => run(false)}
          disabled={loading || refreshing}
          title="启动 AI 综合分析: 一次性生成今日龙头核心/情绪周期/机会/风险"
          className="group flex items-center gap-1.5 rounded border border-[#d4943a]/60 bg-[#4a6b3f] px-2.5 py-1 text-[14px] font-bold text-[#faf6ee] transition-colors hover:bg-[#3d5940] disabled:opacity-60"
        >
          {loading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Sparkles size={16} className="transition-transform group-hover:scale-110" />
          )}
          启动 AI 综合分析
        </button>
        {analysis && (
          <button
            type="button"
            onClick={() => run(true)}
            disabled={loading || refreshing}
            title="强制重新分析(绕过缓存)"
            className="flex items-center gap-1 rounded border border-[#d4943a]/40 px-1.5 py-0.5 text-[13px] text-[#8b7a5e] transition-colors hover:border-[#d4943a]/80 hover:text-[#6b5b3e] disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            重新分析
          </button>
        )}
        {analysis && (
          <ThinkingProcessButton
            trace={analysis.trace || []}
            model={analysis.model}
            date={analysis.date}
            fromCache={analysis.fromCache}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* 新页面: 在新标签页单独打开 PHILIA 复盘, 便于大屏/多窗查看 */}
          <button
            type="button"
            onClick={() => window.open("/philia", "_blank")}
            title="在新页面打开 PHILIA 复盘窗口"
            className="flex items-center gap-1 rounded border border-[#e0d5c0] bg-[#faf6ee] px-1.5 py-0.5 text-[12px] font-bold text-[#8b7a5e] transition-colors hover:border-[#d4943a]/70 hover:text-[#6b5b3e]"
          >
            <ExternalLink size={12} />
            新页面
          </button>
          {/* 轮询日志小按钮: 点击弹出每次轮询的开始/结束时间与耗时, 便于核对 2 分钟触发节奏 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowLogs((v) => !v)}
              title="轮询日志: 查看每次轮询的开始/结束时间与耗时"
              className="flex items-center gap-1 rounded border border-[#e0d5c0] bg-[#faf6ee] px-1.5 py-0.5 text-[12px] font-bold text-[#8b7a5e] transition-colors hover:border-[#d4943a]/70 hover:text-[#6b5b3e]"
            >
              <History size={12} />
              日志
              {pollLogs.some((l) => l.duration === undefined) && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#d4943a]" />
              )}
            </button>
            {showLogs && (
              <div className="absolute right-0 top-full z-30 mt-1 w-[280px] rounded-md border border-[#d8cbb4] bg-[#faf6ee] p-1.5 shadow-lg">
                <div className="mb-1 flex items-center justify-between border-b border-[#e0d5c0] pb-1">
                  <span className="text-[12px] font-bold text-[#6b5b3e]">分析触发日志（最近 20 次）</span>
                  <button type="button" onClick={() => setShowLogs(false)} className="text-[12px] text-[#a8987e] hover:text-[#6b5b3e]">
                    ✕
                  </button>
                </div>
                {pollLogs.length === 0 ? (
                  <p className="text-[12px] text-[#a8987e]">暂无记录。手动「启动/重新分析」或开启「自动轮询」后，每次触发会在此显示。</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto">
                    {pollLogs.map((l) => {
                      // 触发来源徽标: 手动(启动/重新分析) 用橙色, 自动轮询用绿色
                      const isManual = l.kind === "manual";
                      const badge = {
                        text: isManual ? "手动分析" : "自动轮询",
                        cls: isManual ? "bg-[#f8ead0] text-[#b8860b]" : "bg-[#e6f2e6] text-[#3f7d3f]",
                      };
                      // 运行中: 无耗时且无错误
                      const running = l.duration === undefined && !l.error;
                      // 状态词 + 配色: 失败红 / 分析中橙 / 命中缓存棕 / 成功绿
                      const statusWord = l.error ? "失败" : running ? "分析中…" : l.cached ? "命中缓存" : "成功";
                      const statusCls = l.error
                        ? "text-red-600"
                        : running
                          ? "text-[#d4943a]"
                          : l.cached
                            ? "text-[#8b7a5e]"
                            : "text-[#4a6b3f]";
                      // 时间区间: 运行中只显示开始时间; 结束显示「开始 → 结束」
                      const timeSpan = running ? l.start : `${l.start} → ${l.end ?? ""}`;
                      const durText = running ? "" : ` · ${((l.duration ?? 0) / 1000).toFixed(1)}s`;
                      return (
                        <li key={l.id} className="border-b border-[#e0d5c0]/50 py-1 text-[11px]">
                          <div className="flex items-center gap-1.5">
                            <span className={`shrink-0 rounded px-1 py-px text-[10px] font-bold ${badge.cls}`}>{badge.text}</span>
                            <span className="shrink-0 tabular-nums text-[#6b5b3e]">{timeSpan}</span>
                            <span className={`ml-auto shrink-0 tabular-nums font-bold ${statusCls}`}>
                              {statusWord}
                              {durText}
                            </span>
                          </div>
                          {l.error && (
                            <div className="mt-0.5 break-words text-[11px] leading-snug text-red-600" title={l.error}>
                              原因: {l.error}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* 自动轮询开关: 显示状态 + 手动切换 + 切换过渡反馈 */}
          <button
            type="button"
            onClick={toggle}
            title={
              enabled
                ? active
                  ? "自动轮询已开启 · 盘中 09:14-15:01 每2分钟刷新 · 正在轮询中(点击关闭)"
                  : "自动轮询已开启 · 当前非轮询时段(09:14-15:01)(点击关闭)"
                : "自动轮询已关闭 · 盘中 09:14-15:01 每2分钟自动刷新(点击开启)"
            }
            aria-pressed={enabled}
            className={`flex items-center gap-1.5 rounded border px-2 py-0.5 text-[13px] font-bold transition-all duration-300 ${
              enabled
                ? "border-[#4a6b3f]/50 bg-[#4a6b3f]/15 text-[#4a6b3f]"
                : "border-[#e0d5c0] bg-[#faf6ee] text-[#a8987e] hover:border-[#4a6b3f]/50 hover:text-[#6b5b3e]"
            } ${transition ? "scale-105 ring-2 ring-[#4a6b3f]/30" : ""}`}
          >
            <span className="relative flex h-2 w-2 shrink-0">
              {active && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4a6b3f]/50" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${enabled ? "bg-[#4a6b3f]" : "bg-[#c9b99a]"}`}
              />
            </span>
            自动轮询
            <span className={`tabular-nums ${enabled ? "text-[#4a6b3f]" : "text-[#c9b99a]"}`}>
              {enabled ? "开" : "关"}
            </span>
            {refreshing && <RefreshCw size={12} className="animate-spin" />}
          </button>

          <span className={`text-[13px] ${loading ? "text-[#d4943a]" : "text-[#a8987e]"}`}>
            {loading ? "AI 分析中, 请稍候…" : analysis ? `更新于 ${fmtTime(analysis.updatedAt)}` : "龙头情绪复盘 · DeepSeek AI"}
          </span>
        </div>
      </div>
      )}

      {error && (
        <p className="rounded border border-[#b8533a]/40 bg-[#b8533a]/8 px-2 py-1 text-[13px] text-[#b8533a]">{error}</p>
      )}

      {!analysis && !loading && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded border border-dashed border-[#d8cbb4] bg-gradient-to-b from-[#faf6ee]/70 to-[#f5f0e6]/30 px-6 py-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#d4943a]/10">
            <Gauge size={30} className="text-[#d4943a]/70" />
          </div>
          <p className="text-[16px] font-bold text-[#6b5b3e]">做好复盘准备，点击「启动 AI 综合分析」</p>
          <p className="max-w-md text-[13px] leading-relaxed text-[#a8987e]">
            由 AI 基于上游市场数据白皮书，一次性生成以下四项核心分析：
          </p>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {["今日龙头核心", "今日情绪周期", "今日机会", "今日风险"].map((m) => (
              <span
                key={m}
                className="rounded border border-[#e0d5c0] bg-[#faf6ee] px-2 py-0.5 text-[12px] font-semibold text-[#8b7a5e]"
              >
                ◈ {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {analysis && r && (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {/* ===== 今日龙头核心 / 今日情绪周期: 全宽紧凑, 充分利用面板宽度 ===== */}
          <div className="flex flex-col gap-1.5">
            {/* 今日龙头核心 (紧凑) */}
            <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1">
              <div
                className="mb-0.5 flex items-center gap-1 border-b border-[#c9b99a]/50 pb-0.5"
                style={{ color: "#4a6b3f" }}
              >
                <Crown size={12} />
                <span className="text-[12px] font-bold font-newspaper-heading">今日龙头核心</span>
                <button
                  type="button"
                  onClick={() => setShowSrc((v) => !v)}
                  className="ml-auto flex items-center gap-0.5 rounded border border-[#c9b99a]/60 bg-[#faf6ee] px-1 py-px text-[8px] leading-none text-[#8b7a5e]"
                >
                  数据源 {sources.length ? `(${sources.length})` : ""}
                  <span className="text-[8px]">{showSrc ? "▲" : "▼"}</span>
                </button>
              </div>
              {showSrc && sources.length > 0 && (
                <div className="mb-0.5 rounded border border-[#d8cbb4] bg-[#faf6ee] px-1.5 py-0.5 text-[8px] text-[#8b7a5e]">
                  {sources.map((s) => (
                    <div key={s.name} className="flex items-center justify-between gap-2 py-px">
                      <span className="truncate">{s.name}</span>
                      <span className="shrink-0 tabular-nums text-[#a8987e]">{s.fetchedAt}</span>
                    </div>
                  ))}
                </div>
              )}
              {r.leaderCore.title && (
                <p className="mb-0.5 text-[12px] font-bold text-[#6b5b3e]">总龙头：{r.leaderCore.title}</p>
              )}
              {r.leaderCore.summary && (
                <p className="mb-0.5 text-[11px] leading-snug text-[#8b7a5e]">{highlight(r.leaderCore.summary)}</p>
              )}
              <div className="flex flex-col gap-0.5">
                {(r.leaderCore.leaders || []).map((l, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-1 py-0.5"
                  >
                    <span className="shrink-0 rounded bg-[#4a6b3f]/15 px-1 py-px text-[11px] font-bold tabular-nums text-[#4a6b3f]">
                      {l.ladder}板
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-1">
                        <span className="text-[12px] font-bold text-[#6b5b3e]">{l.name}</span>
                        {/* 需求4: 建议仓位置于标的名称后方 */}
                        <PositionChip position={l.position} size={10} />
                      </div>
                      <div className="truncate text-[10px] text-[#a8987e]">
                        {highlight(`${l.code} · ${l.board} · ${l.seal}`)}
                      </div>
                      {/* 需求3: 来源标注 */}
                      <SourceTag sourceRef={l.sourceRef} skill={l.skill} tactic={l.tactic} size={9} />
                    </div>
                    {l.note && <span className="max-w-[38%] shrink-0 truncate text-[10px] text-[#d4943a]">{highlight(l.note)}</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* 今日情绪周期 (70%) + 操作建议 */}
            <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1">
              <div
                className="mb-0.5 flex items-center gap-1 border-b border-[#c9b99a]/50 pb-0.5"
                style={{ color: "#d4943a" }}
              >
                <Gauge size={12} />
                <span className="text-[12px] font-bold font-newspaper-heading">今日情绪周期</span>
                <span
                  className="ml-auto rounded px-1 py-px text-[11px] font-bold text-white"
                  style={{ backgroundColor: stageMeta(r.sentimentCycle.stage).color }}
                >
                  {r.sentimentCycle.stage || "未知"}
                </span>
              </div>
              {r.sentimentCycle.indicators && (
                <p className="mb-0.5 text-[11px] font-semibold text-[#8b7a5e]">{highlight(r.sentimentCycle.indicators)}</p>
              )}
              {r.sentimentCycle.analysis && (
                <p className="text-[11px] leading-snug text-[#6b5b3e]">{highlight(r.sentimentCycle.analysis)}</p>
              )}
              {/* 需求5: 整体操作建议(依据 skill 语气风格) */}
              {r.sentimentCycle.suggestion && (
                <div className="mt-1 rounded border border-[#d4943a]/40 bg-[#d4943a]/10 px-1.5 py-1">
                  <span
                    className={`${SUGGESTION_FONT} font-bold`}
                    style={{ color: SUGGESTION_COLOR, fontSize: SUGGESTION_SIZE }}
                  >
                    操作建议：{highlight(r.sentimentCycle.suggestion)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ===== 今日机会 / 今日风险(主体, 预留 ≥320px) ===== */}
          <div
            className="grid min-h-0 flex-1 grid-cols-1 gap-1.5 lg:grid-cols-2"
            style={{ minHeight: SPACE_PX }}
          >
            {/* 今日机会 */}
            <div className="flex min-h-0 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
              <button
                type="button"
                onClick={() => toggleFloat("opportunities")}
                title="点击弹出「今日机会」独立小窗(可同时与今日风险/自选股并存)"
                className="mb-1 flex w-full items-center gap-1 border-b border-[#c9b99a]/50 pb-1 text-left transition-colors hover:bg-[#faf6ee]/60"
                style={{ color: "#b8533a" }}
              >
                <TrendingUp size={16} />
                <span className="text-[15px] font-bold font-newspaper-heading">今日机会</span>
                <span className="ml-auto flex items-center gap-1 text-[11px] font-normal opacity-70">
                  展开详情 <Maximize2 size={12} />
                </span>
              </button>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {(r.opportunities || []).map((o, i) => (
                  <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-1.5 py-1">
                    <div className="flex flex-wrap items-center gap-x-1">
                      <span className="truncate text-[13px] font-bold text-[#6b5b3e]">
                        {o.type} · {o.sector}
                      </span>
                      {/* 需求4: 建议仓位 */}
                      <PositionChip position={o.position} size={10} />
                    </div>
                    <p className="mt-0.5 text-[12px] leading-snug text-[#8b7a5e]">{highlight(o.analysis)}</p>
                    {o.opportunity && <p className="mt-0.5 text-[12px] text-[#4a6b3f]">机会点：{highlight(o.opportunity)}</p>}
                    {/* 需求3: 来源标注 */}
                    <SourceTag sourceRef={o.sourceRef} skill={o.skill} tactic={o.tactic} size={10} />
                  </div>
                ))}
              </div>
            </div>

            {/* 今日风险 */}
            <div className="flex min-h-0 flex-col rounded border border-[#e0d5c0] bg-[#f5f0e6]/40 p-1.5">
              <button
                type="button"
                onClick={() => toggleFloat("risks")}
                title="点击弹出「今日风险」独立小窗(可同时与今日机会/自选股并存)"
                className="mb-1 flex w-full items-center gap-1 border-b border-[#c9b99a]/50 pb-1 text-left transition-colors hover:bg-[#faf6ee]/60"
                style={{ color: "#b8533a" }}
              >
                <AlertTriangle size={16} />
                <span className="text-[15px] font-bold font-newspaper-heading">今日风险</span>
                <span className="ml-auto flex items-center gap-1 text-[11px] font-normal opacity-70">
                  展开详情 <Maximize2 size={12} />
                </span>
              </button>
              <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                {(r.risks || []).map((rk, i) => (
                  <div key={i} className="rounded border border-[#e0d5c0]/70 bg-[#faf6ee]/60 px-1.5 py-1">
                    <div className="flex items-center gap-1">
                      <span
                        className="shrink-0 rounded px-1 py-px text-[12px] font-bold text-white"
                        style={{ backgroundColor: RISK_COLOR[rk.level] || "#d4943a" }}
                      >
                        {rk.level}
                      </span>
                      <span className="truncate text-[13px] font-bold text-[#6b5b3e]">{rk.scope || "风险"}</span>
                    </div>
                    <p className="mt-0.5 text-[12px] leading-snug text-[#8b7a5e]">{highlight(rk.description)}</p>
                    {rk.mitigation && <p className="mt-0.5 text-[12px] text-[#4a6b3f]">应对：{highlight(rk.mitigation)}</p>}
                    {/* 需求3: 来源标注 */}
                    <SourceTag sourceRef={rk.sourceRef} skill={rk.skill} tactic={rk.tactic} size={10} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== 独立小窗: 今日机会 / 今日风险(可同时显示, 各自支持最小化/最大化/关闭) ===== */}
      {floats.opportunities && r && (
        <FloatingWindow
          id="float-opportunities"
          title="今日机会"
          icon="▲"
          accent="#b8533a"
          onClose={() => toggleFloat("opportunities")}
          defaultWidth={420}
          defaultHeight={520}
          defaultX={24}
          defaultY={70}
        >
          <div className="p-2.5">
            <OpportunitiesBody opportunities={r.opportunities} names={highlightNames} />
          </div>
        </FloatingWindow>
      )}
      {floats.risks && r && (
        <FloatingWindow
          id="float-risks"
          title="今日风险"
          icon="⚠"
          accent="#b8533a"
          onClose={() => toggleFloat("risks")}
          defaultWidth={420}
          defaultHeight={480}
          defaultX={Math.max(24, window.innerWidth - 460)}
          defaultY={70}
        >
          <div className="p-2.5">
            <RisksBody risks={r.risks} names={highlightNames} />
          </div>
        </FloatingWindow>
      )}
    </div>
  );
});