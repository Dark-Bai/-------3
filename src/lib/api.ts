/** 数据 API 客户端
 *  优先走本站 Node 代理(聚合新浪/CNBC 等无跨域源);
 *  代理不可用时,腾讯系接口(qt.gtimg.cn / ifzq.gtimg.cn,天然 CORS)由浏览器直连兜底。
 */

import { useEffect, useState } from "react";
import { usePolling } from "@/hooks/usePolling";
import { FENG_DIM_ORDER, type FengDimKey } from "@/hooks/useFengWeights";

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  prev: number;
  open: number;
  high: number;
  low: number;
  change: number;
  pct: number;
  amount: number; // 万元
  turnover: number;
  time: string;
  /** 成交量(手) */
  vol?: number;
  /** 振幅(%) */
  amplitude?: number;
}

export interface Board {
  code: string;
  name: string;
  price: number;
  change: number;
  pct: number;
  pct5: number;
  pct20: number;
  leadCode: string;
  leadName: string;
  leadPrice: number;
  leadPct: number;
}

export interface BoardStock {
  code: string;
  name: string;
  price: number;
  pct: number;
  turnover: number;
  pe: number;
  speed: number;
  circ_mv: number;
  amount: number; // 元(估算)
}

export interface RankStock {
  symbol: string;
  code: string;
  name: string;
  price: number;
  change: number;
  pct: number;
  amount: number; // 元
  turnover: number;
  pe: number;
  circ_mv: number; // 万元
  time: string;
}

export interface FlowStock {
  symbol: string;
  name: string;
  price: number;
  pct: number;
  amount: number;
  netIn: number; // 元
  netRatio: number;
  r0Net: number;
  turnover: number;
}

/** 个股所属板块(行业/地域/概念) */
export interface StockBoards {
  code: string;
  industry: string;
  area: string;
  concepts: string[];
}

/** 个股资金流(东财, 主力净流入/净占比) */
export interface StockFlow {
  code: string;
  netIn: number; // 主力净流入(元)
  netRatio: number; // 主力净占比(%)
  date?: string;
  close?: number;
  pct?: number;
}

/** 个股实时行情(KPL /api/v2/stock/pankou, 盘口) */
export interface StockQuote {
  code: string;
  name: string;
  price: number;
  prev: number;
  change: number;
  pct: number;
  open: number;
  high: number;
  low: number;
  amount: number; // 成交额(万元)
  vol: number; // 成交量(股)
  turnover: number; // 换手率(%)
  amplitude: number; // 振幅(%)
  volRatio: number; // 量比
  pe: number; // 市盈率
  pb: number; // 市净率
  marketValue: number; // 总市值(元)
  time: string;
}

/** 个股财务指标(KPL /api/v2/f10-finance-info, 最新一期) */
export interface StockFinance {
  code: string;
  date: string;
  revenue: string; // 营业收入
  netProfit: string; // 净利润
  dedProfit: string; // 扣非净利润
  eps: string; // 每股收益
  bvps: string; // 每股净资产
  roe: string; // 净资产收益率(%)
  roeYoY: string; // ROE同比
  grossMargin: string; // 销售毛利率(%)
  inventoryTurnover: string; // 存货周转率
  debtRatio: string; // 资产负债率(%)
  profitYoY: string; // 净利润同比(%)
  revenueYoY: string; // 营收同比(%)
}

/** 个股主力净额(KPL /api/stock/main-forces, 主动买卖口径) */
export interface StockMainForces {
  code: string;
  day: string;
  netAmount: number; // 主力净额(元)
  totalAmount: number; // 主动买卖成交额(元)
  buyAmount: number; // 主动买入额(元)
  sellAmount: number; // 主动卖出额(元)
  buyRatio: number; // 主动买入占比(%)
  sellRatio: number; // 主动卖出占比(%)
  mainForce: string; // "主动买入"/"主动卖出"/...
}

/** 个股详情聚合(本地数据库 + 按需抓取 + 失败回退) */
export interface StockDetail {
  code: string;
  dataSuccess: boolean;
  fromCache: boolean;
  name?: string | null;
  quote?: StockQuote | null;
  minute?: MinuteData | null;
  mainForces?: StockMainForces | null;
  boards?: StockBoards | null;
  profile?: { mainBusiness: string } | null;
  updated: number;
}

/** 板块资金流向曲线(分钟级累计主力净流入) */
export interface BoardFlow {
  code: string;
  name: string;
  netIn: number; // 元
  points: { t: string; v: number }[];
}

export interface NewsItem {
  id: number;
  title: string;
  content: string;
  time: string;
}

export interface Treasury {
  symbol: string;
  name: string;
  yield: number;
  change: number;
  time: string;
}

/** 月度历史收益率曲线快照(财政部官方口径) */
export interface TreasuryCurvePoint {
  date: string; // 该月最后一个交易日
  yields: Record<string, number>; // US3M..US30Y -> 收益率(%)
}

export interface OrUsagePoint {
  date: string;
  name: string;
  tokens: number;
  pct: number;
}

export interface OrUsageDay {
  date: string;
  total: number;
  providers: OrUsagePoint[];
  countries: OrUsagePoint[];
}

export interface MinuteData {
  code: string;
  prec: number;
  /** v = 当分钟成交量(股, A股个股/指数; 全球指数为 0) */
  points: { t: string; p: number; v?: number }[];
  /** 实际数据源: "kpl" | "tencent" | "ths" | "sina"(美债等) */
  source?: string;
}

/** 股票搜索(名称/拼音首字母→代码) */
export interface StockSearchResult {
  code: string;
  name: string;
  pinyin: string;
}

/** 单公司一期主指标(东财 F10 归一化) */
export interface FinanceReport {
  label: string;
  date: string;
  revenue: number;
  netProfit: number;
  revenueYoY: number;
  profitYoY: number;
  roe: number;
  grossMargin: number;
  netMargin: number;
  debtRatio: number;
  roic: number;
  eps: number;
  ocfPerShare: number;
}

export interface FinanceMain {
  name: string;
  reports: FinanceReport[];
}

export interface FinBoardStock {
  code: string;
  name: string;
  industry: string;
  netProfit: number;
  profitYoY: number;
  revenueYoY: number;
  roe: number;
  eps: number;
}

export interface FinIndustry {
  name: string;
  netProfit: number;
  count: number;
  yoy: number;
}

export interface FinCalendarItem {
  date: string;
  code: string;
  name: string;
  period: string;
}

export interface FinanceBoard {
  period: string;
  /** 该报告期已披露公司总数 */
  disclosed?: number;
  stocks: FinBoardStock[];
  industries: FinIndustry[];
  calendar: FinCalendarItem[];
}

export interface FinForecastItem {
  date: string;
  code: string;
  name: string;
  type: string;
  profitLow: number;
  profitHigh: number;
  yoyLow: number;
  yoyHigh: number;
}

export interface FinanceForecast {
  period: string;
  stats: { good: number; bad: number; neutral: number };
  items: FinForecastItem[];
}

const num = (v: unknown) => {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

/** AbortSignal.timeout 兼容封装(Safari <16 无此静态方法, 旧设备直接抛 TypeError) */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/* ---------- 前端 API 调用机制(均衡型): 并发上限 + 超时 + 重试 + 429 冷却 ---------- */
const REQ_CAP = 6;         // 同时在途请求上限(均衡型 8 × 下调20% = 6.4 → 6)
const REQ_TIMEOUT = 8000;  // 单请求超时(ms)
const REQ_MAX_RETRY = 2;   // 幂等 GET 最大重试次数
const RETRY_BASE = 500;    // 首次重试基础退避(ms)
const RETRY_BACKOFF = 4;   // 指数退避倍数(500ms → 2s)
const RETRY_429_WAIT = 30000; // 429 后整体冷却(ms), 不重试当前请求

// 简单信号量: 限制同时在途请求数, 出站请求排队, 防止后端超载
let inFlight = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (inFlight < REQ_CAP) { inFlight++; return Promise.resolve(); }
  return new Promise((r) => waiters.push(r));
}
function release(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) { inFlight++; next(); }
}

let cooldownUntil = 0; // 429 冷却截止时间戳
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => RETRY_BASE * Math.pow(RETRY_BACKOFF, attempt);

async function doGet<T>(path: string, attempt = 0): Promise<T> {
  // 若处于 429 冷却期, 先等待冷却结束再发请求
  if (cooldownUntil > Date.now()) await sleep(cooldownUntil - Date.now());
  let r: Response;
  try {
    r = await fetch(path, { signal: timeoutSignal(REQ_TIMEOUT) });
  } catch (e) {
    // 网络错误/超时: 幂等 GET 可重试, 指数退避
    if (attempt < REQ_MAX_RETRY) {
      await sleep(backoff(attempt));
      return doGet<T>(path, attempt + 1);
    }
    throw e;
  }
  const j = await r.json().catch(() => null);
  if (r.status === 429) {
    cooldownUntil = Date.now() + RETRY_429_WAIT; // 进入冷却, 不重试当前请求
    throw new Error(j?.error || "rate limited");
  }
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  if (!j?.ok) throw new Error(j?.error || "api error");
  return j.data as T;
}

async function get<T>(path: string): Promise<T> {
  await acquire();
  try {
    return await doGet<T>(path);
  } finally {
    release();
  }
}

/** POST 请求(遵循同样的并发/重试机制; timeout 可覆盖默认 8s, 供长耗时任务如 LLM 分析使用) */
async function post<T>(path: string, body?: unknown, timeout = REQ_TIMEOUT): Promise<T> {
  await acquire();
  try {
    let r: Response;
    try {
      r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(timeout),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw new Error("请求超时");
      throw e;
    }
    const j = await r.json().catch(() => null);
    if (r.status === 429) {
      cooldownUntil = Date.now() + RETRY_429_WAIT;
      throw new Error(j?.error || "rate limited");
    }
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    if (!j?.ok) throw new Error(j?.error || "api error");
    return j.data as T;
  } finally {
    release();
  }
}

/* ---------- 浏览器直连腾讯(兜底) ---------- */

function parseTencent(text: string): Record<string, Quote> {
  const out: Record<string, Quote> = Object.create(null); // 上游 symbol 作 key, 防 __proto__ 污染
  for (const line of text.split(";")) {
    const m = line.match(/v_([a-zA-Z0-9_]+)="([^"]*)"/);
    if (!m) continue;
    const symbol = m[1];
    const f = m[2].split("~");
    if (symbol.startsWith("wh") && f.length > 13) {
      out[symbol] = {
        symbol, name: f[1], price: num(f[3]), change: num(f[12]), pct: num(f[13]),
        open: num(f[6]), high: num(f[8]), low: num(f[9]), prev: num(f[3]) - num(f[12]),
        amount: 0, turnover: 0, time: f[5],
      };
    } else if (f.length >= 40) {
      out[symbol] = {
        symbol, name: f[1], price: num(f[3]), prev: num(f[4]), open: num(f[5]),
        change: num(f[31]), pct: num(f[32]), high: num(f[33]), low: num(f[34]),
        amount: num(f[37]), turnover: num(f[38]), time: f[30],
      };
    }
  }
  return out;
}

async function directQuotes(codes: string[]): Promise<Record<string, Quote>> {
  const r = await fetch(`https://qt.gtimg.cn/q=${codes.join(",")}`);
  const text = new TextDecoder("gbk").decode(await r.arrayBuffer());
  return parseTencent(text);
}

function mapBoards(list: Record<string, string>[]): Board[] {
  return (list || []).map((b) => ({
    code: b.bd_code, name: b.bd_name, price: num(b.bd_zxj), change: num(b.bd_zd),
    pct: num(b.bd_zdf), pct5: num(b.bd_zdf5), pct20: num(b.bd_zdf20),
    leadCode: b.nzg_code, leadName: b.nzg_name, leadPrice: num(b.nzg_zxj), leadPct: num(b.nzg_zdf),
  }));
}

async function directBoards(type: "01" | "02", dir: 0 | 1, n: number): Promise<Board[]> {
  const r = await fetch(`https://ifzq.gtimg.cn/appstock/app/mktHs/rank?l=${n}&p=1&t=${type}/averatio&o=${dir}`);
  const j = await r.json();
  return mapBoards(j?.data || []);
}

async function directMinute(code: string): Promise<MinuteData> {
  const r = await fetch(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`);
  const j = await r.json();
  const d = j?.data?.[code];
  const arr: string[] = d?.data?.data || [];
  return {
    code,
    prec: num(d?.data?.prec || d?.qt?.[code]?.[4] || 0),
    points: arr.map((s) => {
      const p = s.split(" ");
      return { t: p[0], p: num(p[1]) };
    }),
  };
}

/** 服务端优先,失败时浏览器直连兜底 */
async function withFallback<T>(serverFn: () => Promise<T>, directFn?: () => Promise<T>): Promise<T> {
  try {
    return await serverFn();
  } catch (e) {
    if (directFn) return directFn();
    throw e;
  }
}

/** 快讯浏览器直连兜底:华尔街见闻(CORS 开放,全球可达) */
interface WscnItem {
  id?: number;
  title?: string;
  content?: string;
  content_text?: string;
  display_time?: number;
}

async function directNews(size: number): Promise<NewsItem[]> {
  const r = await fetch(
    `https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=${Math.min(size, 50)}`
  );
  const j = await r.json();
  const items: WscnItem[] = j?.data?.items || [];
  const fmt = (sec?: number) => {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  return items
    .filter((it) => it.content_text || it.content)
    .map((it, i) => ({
      id: it.id || (it.display_time || 0) * 100 + i,
      title: it.title || "",
      content: (it.content_text || it.content || "").replace(/<[^>]+>/g, ""),
      time: fmt(it.display_time),
    }));
}

/** 个股资金流批量聚合: 60ms 窗口内的 stockFlow 调用合并为一次 /api/stock-flows 请求
 *  (避免每个 QuoteRow 各发一条请求, 把东财队列打爆) */
const flowLoader = (() => {
  let queue: { code: string; resolve: (v: StockFlow | null) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (code: string): Promise<StockFlow | null> =>
    new Promise((resolve) => {
      queue.push({ code, resolve });
      if (timer) return;
      timer = setTimeout(async () => {
        const batch = queue;
        queue = [];
        timer = null;
        const codes = [...new Set(batch.map((b) => b.code))];
        try {
          const rows = await get<StockFlow[]>(`/api/stock-flows?codes=${codes.join(",")}`);
          const map = new Map(rows.map((r) => [r.code, r]));
          for (const b of batch) b.resolve(map.get(b.code) ?? null);
        } catch {
          for (const b of batch) b.resolve(null);
        }
      }, 60);
    });
})();

export const api = {
  quotes: (codes: string[]) =>
    withFallback(() => get<Record<string, Quote>>(`/api/quotes?codes=${codes.join(",")}`), () => directQuotes(codes)),
  minute: (code: string) =>
    withFallback(() => get<MinuteData>(`/api/minute?code=${code}`), () => directMinute(code)),
  /** 批量分时(指数面板一次请求拉取全部指数, 减少 HTTP 往返, 后端按代码独立缓存) */
  minutes: (codes: string[]) =>
    get<Record<string, MinuteData>>(`/api/minutes?codes=${codes.join(",")}`),
  boards: (type: "01" | "02", dir: 0 | 1 = 0, n = 30) =>
    withFallback(() => get<Board[]>(`/api/boards?type=${type}&dir=${dir}&n=${n}`), () => directBoards(type, dir, n)),
  boardStocks: (code: string, n = 12) => get<BoardStock[]>(`/api/board-stocks?code=${encodeURIComponent(code)}&n=${n}`),
  rank: (sort: "changepercent" | "amount" | "turnoverratio", asc: 0 | 1, n = 30) =>
    get<RankStock[]>(`/api/rank?sort=${sort}&asc=${asc}&n=${n}`),
  moneyflow: (n = 15) => get<FlowStock[]>(`/api/moneyflow?n=${n}`),
  stockBoards: (code: string) => get<StockBoards>(`/api/stock-boards?code=${encodeURIComponent(code)}`),
  stockProfile: (code: string) => get<{ code: string; mainBusiness: string }>(`/api/stock-profile?code=${encodeURIComponent(code)}`),
  stockFlow: (code: string) => flowLoader(code),
  /** 批量主力资金流(自选股多股同列: 一次拉全部自选股的主力净流入/净占比) */
  stockFlows: (codes: string[]) =>
    get<StockFlow[]>(`/api/stock-flows?codes=${codes.join(",")}`),
  /** 个股主力净额(KPL main-forces): 主力净额/主动买卖/成交(主动口径) */
  stockMainForces: (code: string) => get<StockMainForces>(`/api/stock-main-forces?code=${encodeURIComponent(code)}`),
  stockQuote: (code: string) => get<StockQuote>(`/api/stock-quote?code=${encodeURIComponent(code)}`),
  /** 个股详情聚合(本地数据库): 一次请求返回 行情/分时/主力/行业概念/主营 */
  stockDetail: (code: string) => get<StockDetail>(`/api/stock-detail?code=${encodeURIComponent(code)}`),
  stockFinance: (code: string) => get<StockFinance>(`/api/stock-finance?code=${encodeURIComponent(code)}`),
  boardFlow: (n = 20) => get<BoardFlow[]>(`/api/board-flow?n=${n}`),
  news: (size = 60) => withFallback(() => get<NewsItem[]>(`/api/news?size=${size}`), () => directNews(size)),
  treasuries: () => get<Treasury[]>(`/api/treasuries`),
  treasuryHistory: () => get<TreasuryCurvePoint[]>(`/api/treasury-history`),
  openRouterUsage: () => get<OrUsageDay[]>(`/api/openrouter-usage`),
  stockSearch: (q: string) => get<StockSearchResult[]>(`/api/stock-search?q=${encodeURIComponent(q)}`),
  financeMain: (code: string) => get<FinanceMain>(`/api/finance-main?code=${encodeURIComponent(code)}`),
  financeBoard: (period = "") => get<FinanceBoard>(`/api/finance-board${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  financeForecast: (period = "") => get<FinanceForecast>(`/api/finance-forecast${period ? `?period=${encodeURIComponent(period)}` : ""}`),
  pluginNewsAnalyst: () => get<PluginNewsAnalystData>(`/api/plugin-news-analyst`),
  pluginMarketSentiment: () => get<PluginMarketSentimentData>(`/api/plugin-market-sentiment`),
  /** 风口聚合: 后端按 date 聚合 dims, 用传入权重计算最终评分 */
  fengkFront: (date = "", weights?: Record<FengDimKey, number>) =>
    get<FengFrontData>(`/api/fengk-front${date ? `?date=${date}` : ""}${weights ? `${date ? "&" : "?"}weights=${FENG_DIM_ORDER.map((k) => weights[k]).join(",")}` : ""}`),
  /**
   * 系统监控接口 — 获取各 API 接口性能指标、服务端内存与本地数据库状态。
   *
   * @returns {Promise<MonitorData>} 监控数据(详见 MonitorData 类型说明)。
   * @throws {Error} 网络错误/超时/429 时抛错, 失败重试由 get() 统一处理。
   * @note 由系统监控面板(MonitorWindow)每 10s 轮询调用; 后端返回内存滚动统计,
   *       无持久化, 服务重启后指标清零。
   * @example
   *   const data = await api.monitor();
   *   data.endpoints.forEach(e => console.log(e.path, e.avg + "ms", e.successRate + "%"));
   */
  monitor: () => get<MonitorData>(`/api/monitor`),
  /* ---------- PHILIA AI 综合分析 ---------- */
  philia: {
    /** 技能列表(读取 youzi-qijie-jinghua 目录) */
    skills: () => get<PhiliaSkill[]>(`/api/philia/skills`),
    /** 可用模型列表(OpenRouter models 过滤) */
    models: () => get<PhiliaModel[]>(`/api/philia/models`),
    /** 读取配置(不含明文 key) */
    getConfig: () => get<PhiliaConfig>(`/api/philia/key`),
    /** 保存配置(含 key 时后端先校验再加密存储) */
    saveConfig: (cfg: PhiliaSaveConfig) => post<PhiliaConfig>(`/api/philia/key`, cfg),
    /** 校验 API Key 有效性 */
    validate: (key: string) => post<PhiliaValidateResult>(`/api/philia/key`, { key, validateOnly: true }),
    /** 触发综合分析(降频缓存; force=1 绕过缓存); LLM 耗时长, 用独立长超时(180s) */
    analyze: (cfg: PhiliaAnalyzeReq) => post<PhiliaAnalysis>(`/api/philia/analyze`, cfg, 180000),
    /** 历史分析列表 */
    history: () => get<PhiliaAnalysis[]>(`/api/philia/history`),
    /** 核心标的参考池(市场实时热点 → 龙头股); force=true 强制重建; weights=打分权重(逗号分隔 4 值) */
    leaderPool: (force = false, weights?: string) => {
      const qs = new URLSearchParams();
      if (force) qs.set("force", "1");
      if (weights) qs.set("weights", weights);
      const s = qs.toString();
      return get<PhiliaLeaderPool>(`/api/philia/leader-pool${s ? `?${s}` : ""}`);
    },
    /** 龙头池与龙头股数据源一致性深度校验 */
    validateLeaderPool: () => get<PhiliaLeaderValidateReport>(`/api/philia/leader-pool/validate`),
    /** 龙头情绪复盘(5 模块): 今日龙头核心/今日情绪周期/今日机会/今日风险/昨日梯队双日对照; force=true 强制重算; LLM 耗时长用独立长超时 */
    marketAnalyze: (cfg: { model?: string; skills?: string[]; force?: boolean }) =>
      post<PhiliaMarketAnalysis>(`/api/philia/market-analyze`, cfg, 180000),
  },
  /* ---------- 同花顺 THS 网关账号 ---------- */
  thsAccount: {
    /** 读取账号配置(GET 不回传明文密码) */
    get: () => get<ThsAccountInfo>(`/api/ths/account`),
    /** 保存账号配置并热重连网关; password 留空则保留原密码 */
    save: (cfg: { username: string; password?: string; mac?: string }) =>
      post<ThsAccountInfo>(`/api/ths/account`, cfg),
  },
};

/**
 * 单个接口路径的性能指标(来自后端 /api/monitor 的 endpoints 数组)。
 */
export interface MonitorEndpoint {
  /** 接口路径(如 "/api/stock-detail") */
  path: string;
  /** 累计调用次数(进程启动以来的总量) */
  count: number;
  /** 平均响应耗时(毫秒) */
  avg: number;
  /** 95 分位响应耗时(毫秒); 无样本时为 0 */
  p95: number;
  /** 最大响应耗时(毫秒) */
  max: number;
  /** 累计错误次数 */
  errors: number;
  /** 成功率(百分比, 保留 1 位小数; 无调用时为 100) */
  successRate: number;
  /** 最近 1 分钟调用次数(用于评估调用速率/资源挤占) */
  rate1m: number;
  /** 最近一次调用时间戳(毫秒) */
  lastTs: number;
  /** 最近一条错误信息; 无错误为 null */
  lastErr: { ts: number; msg: string } | null;
}

/**
 * 系统监控数据(来自后端 /api/monitor)。
 */
export interface MonitorData {
  /** 数据生成时间戳(毫秒) */
  ts: number;
  /** 服务进程已运行时长(秒) */
  uptime: number;
  /** Node 进程内存占用(字节): rss=常驻内存, heapTotal/heapUsed=堆内存, external=外部内存, arrayBuffers=缓冲区 */
  serverMem: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  /** 各接口性能指标数组(按调用次数降序) */
  endpoints: MonitorEndpoint[];
  /** SQLite 本地库状态: stocks=个股缓存条数, trends=趋势记录条数, dbPath=库文件路径 */
  db: { stocks: number; trends: number; dbPath: string; metrics?: { reads: number; writes: number; readMs: number; writeMs: number; errors: number; lastMs: number; lastOp: string } };
  /** 内存缓存状态: entries=内存缓存条目数 */
  cache: { entries: number };
}

/** 新闻分析师插件数据结构 */
export interface PluginPlatformDetail {
  platform: string;
  name: string;
  category: string;
  count: number;
  score: number;
}
export interface PluginFlowData {
  totalScore: number;
  socialScore: number;
  newsScore: number;
  financeScore: number;
  techScore: number;
  level: string;
  analysis: string;
  platformDetails: PluginPlatformDetail[];
}
export interface PluginSentimentData {
  sentimentIndex: number;
  sentimentClass: string;
  flowFactor: number;
  financeFactor: number;
  keywordFactor: number;
  positiveCount: number;
  negativeCount: number;
}
export interface PluginHotTopic {
  topic: string;
  count: number;
  heat: number;
  crossPlatform: number;
  sources: string[];
}
export interface PluginStockNews {
  platform: string;
  category: string;
  title: string;
  content: string;
  matchedKeywords: string[];
  score: number;
}
export interface PluginNewsAnalystData {
  success: boolean;
  fetchTime: string;
  platformStats: { success: number; total: number };
  flowData: PluginFlowData;
  sentimentData: PluginSentimentData;
  hotTopics: PluginHotTopic[];
  stockNews: PluginStockNews[];
}

/** 市场情绪v2: 基于 kpl 接口 (mood / limit-up-ladder / rise-fall) */
export interface MarketMoodData {
  upCount: number;
  downCount: number;
  limitUp: number;
  limitDown: number;
  turnover: number;
  prevTurnover: number;
  ratio: number;
  marketColor: number;
  totalCount: number;
  upRatio: number;
  downRatio: number;
  turnoverChange: number;
  volLevel: string;
}
/** 市场情绪评分(由涨跌比派生, 与多空情绪无直接关系) */
export interface MarketSentimentData {
  sentimentScore: number;
  sentimentLevel: string;
  sentimentDesc: string;
}
/** 连板梯队趋势点(ladder_trend, 升序) */
export interface LadderTrendPoint {
  date: string;
  firstBoard: number;   // 一板
  secondBoard: number;  // 二板
  thirdBoard: number;   // 三板
  highBoard: number;    // 高度板
  ladderRate: number;   // 连板率(%)
}
/** 连板梯队数据(api/market/limit-up-ladder) */
export interface LadderData {
  date: string;               // 最新可用日期(盘中常为空, 取最近可用交易日)
  firstBoard: number;         // 一板
  secondBoard: number;        // 二板
  thirdBoard: number;         // 三板
  highBoard: number;          // 高度板
  ladderRate: number;         // 连板率(%)
  brokenRate: number;         // 今日涨停破板率(%)
  yestLimitUpPerf: number;    // 昨日涨停今表现(%)
  yestLadderPerf: number;     // 昨日连板今表现(%)
  yestBrokenPerf: number;     // 昨日破板今表现(%)
  comment: string;            // 市场评价
  trend: LadderTrendPoint[];  // 近N日梯队趋势(最新在前)
}
export interface MarketRiseFallTrend {
  date: string;
  limitUp: number;
  limitDown: number;
  brokenUp: number;
  blownUp: number;
  blownRate: number;
}
export interface MarketRiseFallData {
  limitUpCount: number;
  limitDownCount: number;
  blownLimitUpCount: number;
  brokenLimitUpCount: number;
  blownLimitUpRate: number;
  yesterdayLimitUpPerf: number;
  yesterdayBrokenPerf: number;
  date: string;
  trendData: MarketRiseFallTrend[];
}
export interface PluginMarketSentimentData {
  dataSuccess: boolean;
  mood: MarketMoodData;
  sentiment: MarketSentimentData;
  ladder: LadderData;
  riseFall: MarketRiseFallData;
}
export function useOpenRouterUsage() {
  return usePolling(() => api.openRouterUsage(), 3600000);
}

/* ---------------- PHILIA AI 综合分析数据结构 ---------------- */

/** 技能(读取 youzi-qijie-jinghua 目录的 SKILL.md) */
export interface PhiliaSkill {
  name: string;
  description: string;
  /** 技能标题(文件/章节名) */
  slug: string;
}

/** 可选模型(OpenRouter) */
export interface PhiliaModel {
  id: string;
  name: string;
  /** 是否默认选中 */
  default?: boolean;
  /** 是否 deepseek-v4-flash 正式版 */
  isDeepSeekV4?: boolean;
}

/** 前端配置(不含明文 key, 由后端掩码返回) */
export interface PhiliaConfig {
  hasKey: boolean;
  /** key 掩码, 如 sk-or-****abcd */
  keyMask?: string | null;
  model: string;
  skills: string[];
}

/** 保存配置请求(含明文 key, 仅发送到后端加密存储) */
export interface PhiliaSaveConfig {
  key?: string;
  model: string;
  skills: string[];
}

/** Key 校验结果 */
export interface PhiliaValidateResult {
  valid: boolean;
  label?: string | null;
  error?: string | null;
}

/** 同花顺 THS 网关账号配置(GET 不含明文密码) */
export interface ThsAccountInfo {
  configured: boolean;
  username: string;
  mac: string;
  /** THS 数据网关是否在线(前端展示连接状态) */
  gatewayAlive: boolean;
}

/** 单条投资机会 */
export interface PhiliaOpportunity {
  type: string;
  sector: string;
  analysis: string;
  expectedReturn: string;
  weight: number;
}

/** 单条风险 */
export interface PhiliaRisk {
  level: "高" | "中" | "低";
  scope: string;
  description: string;
  mitigation: string;
  weight: number;
}

/** 核心标的 */
export interface PhiliaStock {
  name: string;
  code: string;
  reason: string;
  target: string;
  weight: number;
}

/** AI 分析所参考的数据源及其获取时间(分钟级) */
export interface PhiliaDataSource {
  name: string;
  /** 获取时间, 格式 YYYY-MM-DD HH:MM */
  fetchedAt: string;
}

/** 思考过程中的单一步骤(资源加载 / 工具调用), 仅含脱敏摘要, 不含敏感信息 */
export interface PhiliaTraceStep {
  id: number;
  /** agent: 整体流程 | resource: 加载的资源 | tool: 调用的工具/函数 */
  type: "agent" | "resource" | "tool";
  name: string;
  /** ok | failed */
  status: "ok" | "failed";
  /** 开始时间戳(ms) */
  startedAt: number;
  /** 执行耗时(ms) */
  durationMs: number;
  /** 脱敏后的参数摘要 */
  params?: Record<string, unknown>;
  /** 简短结果/说明 */
  summary?: string;
}

/* ---------------- 核心标的参考池(市场实时热点 → 龙头股) ---------------- */
/** 参考池中的单只龙头股 */
export interface PhiliaLeaderStock {
  code: string;
  name: string;
  price: number;
  pct: number;
  /** 封单金额(元) */
  seal: number;
  /** 封单占流通市值比例(%, 打分用维度) */
  sealRatio?: number;
  /** 所属板块 */
  board: string;
  /** 该板块涨停家数 */
  boardLimitUp: number;
  /** 该板块最大连板高度 */
  ladder: number;
  /** 该板块资金流入 */
  capital: number;
  /** 流通市值(亿) */
  floatMarketCap: number;
  /** 总市值(亿) */
  totalMarketCap: number;
  /** 成交额(万元,A股) */
  amount: number;
  /** 换手率(%) */
  turnover: number;
  /** 量化评分 0-100(封单优先) */
  score: number;
  /** 打分权重 */
  weights?: { seal: number; boardLimitUp: number; ladder: number; capital: number };
}
/** 龙头股变动条目(新增/维持) */
export interface PhiliaLeaderChangeItem {
  code: string;
  name: string;
  board: string;
  score: number;
}
/** 龙头股参考池 */
export interface PhiliaLeaderPool {
  date: string;
  /** 更新时间戳(毫秒) */
  updatedAt: number;
  /** 参考池(按评分降序, 上限 30) */
  pool: PhiliaLeaderStock[];
  poolSize: number;
  /** 变动追踪: 新增/移除/维持 */
  change: { added: PhiliaLeaderChangeItem[]; removed: string[]; kept: PhiliaLeaderChangeItem[] };
  /** 打分权重、过滤门槛与数据源追溯说明 */
  meta: {
    weights: { seal: number; boardLimitUp: number; ladder: number; capital: number };
    filters: { totalMarketCapMax: number; excludePrefixes?: string[] };
    /** 数据源标签(展示用) */
    sourceLabel?: string;
    /** 龙头股数据源各上游可用状态(与 fengk-front 一致) */
    source?: { boards?: boolean; ydPlate?: boolean; theme?: boolean; news?: boolean; fengBest?: boolean };
    /** 龙头股数据源构建时间戳(毫秒) */
    baseUpdatedAt?: number;
  };
  /** 定期一致性校验: 龙头池与龙头股数据源逐条比对结果 */
  validation?: {
    consistent: boolean;
    checkedAt: number;
    poolSize: number;
    sourceSectors: number;
    mismatches: { code: string; name: string; field: string; poolVal: unknown; baseVal: unknown }[];
  };
}

/** 龙头池一致性深度校验结果 */
export interface PhiliaLeaderValidateReport {
  date: string;
  checkedAt: number;
  report: {
    consistent: boolean;
    checkedAt: number;
    poolSize: number;
    sourceSectors: number;
    mismatches: { code: string; name: string; field: string; poolVal: unknown; baseVal: unknown }[];
  };
  source?: { boards?: boolean; ydPlate?: boolean; theme?: boolean; news?: boolean; fengBest?: boolean };
  baseUpdatedAt?: number;
  pool: PhiliaLeaderStock[];
  note: string;
}

/** 结构化分析结果 */
export interface PhiliaAnalysisResult {
  sentiment: { score: number; level: string; comment: string };
  opportunities: PhiliaOpportunity[];
  risks: PhiliaRisk[];
  stocks: PhiliaStock[];
  /** AI 生成内容所参考的数据源列表(含获取时间) */
  sources?: PhiliaDataSource[];
}

/** 分析记录(含缓存键/时间) */
export interface PhiliaAnalysis {
  cacheKey: string;
  date: string;
  model: string;
  skillsHash: string;
  result: PhiliaAnalysisResult;
  createdAt: number;
  updatedAt: number;
  /** 是否命中降频缓存(本次未重新计费) */
  fromCache?: boolean;
  /** 本次分析的思考过程(资源加载/工具调用步骤), 仅本次实时返回, 不入历史 */
  trace?: PhiliaTraceStep[];
}

/** 分析请求 */
export interface PhiliaAnalyzeReq {
  model: string;
  skills: string[];
  /** 强制绕过缓存 */
  force?: boolean;
}

/* ---------------- 龙头情绪复盘(5 模块) ---------------- */

/** 今日龙头核心 */
export interface PhiliaMarketLeaderCore {
  title: string;
  summary: string;
  leaders: {
    name: string;
    code: string;
    board: string;
    ladder: number;
    seal: string;
    note: string;
    /** 所参考 skill 思路名称(如 炒股养家·赚钱效应) */
    skill?: string;
    /** 对应战法编号 */
    tactic?: string;
    /** 建议仓位: 固定四级分类之一(小/中/大/满) */
    position?: string;
    /** 精确来源标注(文件名 + 章节编号 + 模型编号) */
    sourceRef?: string;
  }[];
}

/** 今日情绪周期 */
export interface PhiliaMarketSentimentCycle {
  stage: string;
  indicators: string;
  analysis: string;
  /** 整体操作建议(依据 skill 语气风格) */
  suggestion?: string;
}

/** 龙头低吸(今日龙头核心右侧并列模块): 与 PhiliaMarketLeaderCore 结构完全一致 */
export interface PhiliaMarketLowAbsorb {
  title: string;
  summary: string;
  leaders: {
    name: string;
    code: string;
    board: string;
    /** 昨日连板高度 */
    ladder: number;
    /** 今日状态与昨日封单描述(如 今日断板·昨封4.82亿) */
    seal: string;
    /** 低吸点评(辩证分析投资机会与潜在风险) */
    note: string;
    /** 所参考 skill 思路名称 */
    skill?: string;
    /** 对应战法编号 */
    tactic?: string;
    /** 建议仓位: 固定四级分类之一(小/中/大/满) */
    position?: string;
    /** 精确来源标注(文件名 + 章节编号 + 模型编号) */
    sourceRef?: string;
  }[];
}

/** 今日机会 */
export interface PhiliaMarketOpportunity {
  type: string;
  sector: string;
  /** 涉及的具体标的名(用于蓝色高亮标注) */
  targets?: string[];
  analysis: string;
  opportunity: string;
  /** 所参考 skill 思路名称 */
  skill?: string;
  /** 对应战法编号 */
  tactic?: string;
  /** 建议仓位: 固定四级分类之一(小/中/大/满) */
  position?: string;
  /** 精确来源标注(文件名 + 章节编号 + 模型编号) */
  sourceRef?: string;
}

/** 今日风险 */
export interface PhiliaMarketRisk {
  level: string;
  scope: string;
  /** 涉及的具体标的名(用于蓝色高亮标注) */
  targets?: string[];
  description: string;
  mitigation: string;
  /** 所参考 skill 思路名称 */
  skill?: string;
  /** 对应战法编号 */
  tactic?: string;
  /** 精确来源标注(文件名 + 章节编号 + 模型编号) */
  sourceRef?: string;
}

/** 龙头情绪复盘结果(5 模块) */
export interface PhiliaMarketAnalysisResult {
  leaderCore: PhiliaMarketLeaderCore;
  /** 龙头低吸(今日龙头核心右侧并列模块) */
  leaderLowAbsorb: PhiliaMarketLowAbsorb;
  sentimentCycle: PhiliaMarketSentimentCycle;
  opportunities: PhiliaMarketOpportunity[];
  risks: PhiliaMarketRisk[];
  /** 第 5 模块: 昨日连板梯队 · 今日实盘对照验证(双日对照) */
  marketValidation: PhiliaMarketValidation;
  /** 汇总的全部标的名称(龙头 + 机会 + 风险), 用于蓝色高亮标注 */
  targets?: string[];
  /** AI 生成内容所参考的数据源列表(含获取时间) */
  sources?: PhiliaDataSource[];
}

/** 昨日连板梯队 · 今日实盘对照验证(双日对照) */
export interface PhiliaMarketValidation {
  /** 昨日连板梯队复盘摘要(昨日涨停/连板家数、最高高度、总龙头与分支龙头, 须标注日期) */
  yesterdaySummary: string;
  /** 昨日梯队个股今日实盘表现(晋级/维持/断板/炸板/跌停概况, 总龙头今日命运) */
  todayPerformance: string;
  /** 双日对照(今日最高板高度较昨日打开或压制、新老梯队交替、主线延续或切换) */
  comparison: string;
  /** 昨日四大结论逐项验证(命中/偏差/失准) */
  conclusionCheck: {
    /** 昨日结论项(判定的龙头/情绪周期阶段/机会方向/风险信号) */
    conclusion: string;
    /** 今日实盘验证情况 */
    verification: string;
    /** 验证结果: 命中/偏差/失准 */
    result: string;
    /** 偏差或失准的原因说明 */
    reason?: string;
  }[];
}

/** 龙头情绪复盘记录 */
export interface PhiliaMarketAnalysis {
  cacheKey: string;
  date: string;
  model: string;
  skillsHash: string;
  result: PhiliaMarketAnalysisResult;
  createdAt: number;
  updatedAt: number;
  fromCache?: boolean;
  /** 本次分析的思考过程(资源加载/工具调用步骤), 仅本次实时返回, 不入历史 */
  trace?: PhiliaTraceStep[];
}
/* ---------------- 风口聚合数据结构 ---------------- */
export interface FengWindDims {
  limitUp: number;
  ladder: number;
  capital: number;
  theme: number;
  news: number;
}
export interface FengWindLeader {
  code: string;
  name: string;
  price: number;
  pct: number;
  seal: number;
}
export interface FengWindNews {
  title: string;
  time: number;
  stocks: { code: string; name: string; rate: number }[];
}
export interface FengWind {
  name: string;
  dims: FengWindDims;
  /** 后端按请求权重算出的最终评分(0-100) */
  score: number;
  limitUpCount: number;
  maxConsecutive: number;
  capital: number;
  leaders: FengWindLeader[];
  ladders: { days: number; count: number }[];
  news: FengWindNews[];
}
export interface FengFrontData {
  date: string;
  weights: Record<FengDimKey, number>;
  source: Record<string, boolean>;
  windList: FengWind[];
}

/** 风口面板轮询: 15s 刷新, 携带当前权重去后端计算最终评分
 *  粘性数据: 新响应 windList 为空(上游超时/失败聚合为空)时沿用上一次非空数据, 杜绝刷新闪空 */
export function useFengFront(date = "", weights: Record<FengDimKey, number>) {
  const { data: pollData, loading, error, refreshing, refresh } = usePolling(() => api.fengkFront(date, weights), 15000, [date, weights]);
  const [sticky, setSticky] = useState<FengFrontData | null>(null);
  useEffect(() => {
    if (pollData?.windList?.length) setSticky(pollData);
  }, [pollData]);
  const hasData = !!pollData?.windList?.length;
  return {
    data: hasData ? pollData : sticky,
    loading,
    error,
    refreshing,
    refresh,
  };
}
