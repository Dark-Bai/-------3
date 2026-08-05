/**
 * PHILIA AI 综合分析 - 后端核心
 *
 * 职责:
 *  - 技能库解析(youzi-qijie-jinghua/SKILL.md)
 *  - OpenRouter 模型列表 / Key 校验
 *  - 市场数据白皮书组装(本地库 + KPL 实时)
 *  - LLM 调用(OpenRouter, response_format=json_object) + 结构化校验
 *  - 降频缓存(按 日期+模型+技能 哈希, 命中不重复计费)
 *  - 配置的加密读写(密钥经 server/philia-keystore.cjs, 不出服务端)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
// push2.eastmoney.com 对本机 IPv6 连接不稳定, 强制优先 IPv4 以保证网页数据源稳定抓取
dns.setDefaultResultOrder("ipv4first");
const { encrypt, decrypt, maskKey } = require("./philia-keystore.cjs");
const {
  getAiKey, upsertAiKey, getAiAnalysis, upsertAiAnalysis, listAiAnalyses,
  getTrends, getLadderTrend,
} = require("./stock-db.cjs");

/* ---------------- 常量 ---------------- */
const ROOT = path.join(__dirname, "..");
const SKILL_DIR = path.join(ROOT, "youzi-qijie-jinghua");
// 次要客观数据方法论来源(龙头情绪复盘): 仅吸收其客观数据信息, 优先级低于 youzi-qijie-jinghua
const LUOTOU_SKILL_PATH = path.join(ROOT, ".trae", "skills", "luotou-qingxu-sipan", "SKILL.md");
const OR_BASE = "https://openrouter.ai/api/v1";
const DS_BASE = "https://api.deepseek.com";

/** 依据 key 前缀识别 provider: sk-or- 为 OpenRouter, 其余 sk- 视为 DeepSeek */
const isOpenRouterKey = (key) => typeof key === "string" && key.startsWith("sk-or-");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MODEL_CACHE_TTL = 30 * 60 * 1000; // 模型列表缓存 30min
const CONTEXT_CACHE_TTL = 5 * 60 * 1000; // 数据白皮书缓存 5min
const ANALYSIS_CACHE_TTL = 30 * 60 * 1000; // 分析结果降频缓存 30min
const MAX_PROMPT_SKILL_CHARS = 20000; // 注入技能提示词上限(容纳全部技能+全览, SKILL.md 全文约 13K 字符)

/* ---------------- 思考过程追踪器 ----------------
 * 记录一次分析中「加载的资源」与「调用的工具/函数」, 含时间戳、耗时与执行状态,
 * 随结果返回前端「查看思考过程」弹窗展示。
 * 数据安全: 仅记录脱敏后的摘要(资源名/工具名/模型名/耗时/状态),
 * 绝不记录明文 API Key、完整 prompt 或原始 LLM 响应。
 */
function createTracer() {
  const steps = [];
  let seq = 0;
  const add = (step) => {
    seq += 1;
    steps.push({ id: seq, ...step });
  };
  return { steps, add };
}

/** 兜底模型列表(OpenRouter 接口失败/未配置时使用) */
const DEFAULT_MODELS = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash（正式版）", default: true, isDeepSeekV4: true },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", default: false },
  { id: "openai/gpt-4o", name: "OpenAI GPT-4o", default: false },
  { id: "anthropic/claude-3.5-sonnet", name: "Anthropic Claude Sonnet", default: false },
];

/** 允许的模型白名单(防模型 id 注入导致成本/安全风险) */
const MODEL_WHITELIST = new Set(DEFAULT_MODELS.map((m) => m.id));

/* ---------------- 网页数据源(东方财富 push2ex / push2delay) ----------------
 * 自 2026-08 起「重新分析」的数据白皮书改为直连东方财富公开网页数据接口,
 * 完全断开与本地 KPL 代理接口的连接, 数据来源为网页抓取。
 *  - push2ex.eastmoney.com/getTopic*Pool : 涨停/炸板/跌停池(实时)
 *  - push2delay.eastmoney.com/api/qt    : 全市场涨跌家数
 * 注: 大部分接口对本机 IPv6 连接不稳定, 已在文件顶部 setDefaultResultOrder("ipv4first")。
 */
const EM_UT = "7eea3edcaed734bea9cbfc24409ed989"; // push2ex 校验码(客户端固定, 每日不变)
const emSymbol = (code6) => `${"689".includes(code6[0]) ? "sh" : code6[0] === "4" || code6[0] === "8" ? "bj" : "sz"}${code6}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抓取文本(fetch 失败时回退 curl, 兼容 TLS 指纹敏感上游) */
async function fetchTextEM(url, { referer = "https://quote.eastmoney.com/", timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*", Referer: referer },
      signal: ctrl.signal,
    });
    return Buffer.from(await resp.arrayBuffer()).toString("utf-8");
  } catch {
    return await execCurl(url, { referer, timeout });
  } finally {
    clearTimeout(timer);
  }
}

/** 调用系统 curl 兜底(避免依赖额外依赖) */
function execCurl(url, { referer, timeout = 8000 } = {}) {
  const { spawnSync } = require("child_process");
  const args = ["-s", "--max-time", String(Math.ceil(timeout / 1000)), "-H", "User-Agent: " + UA];
  if (referer) args.push("-H", "Referer: " + referer);
  args.push(url);
  const r = spawnSync("curl.exe", args, { encoding: "utf-8", timeout: timeout + 2000 });
  if (r.status !== 0) throw new Error("curl failed: " + (r.stderr || r.error?.message || ""));
  return r.stdout;
}

/** 解析东财 JSON(fetch→curl 双重回退, 带小间隔节流) */
async function emGet(url) {
  let lastErr = new Error("em web request failed");
  for (const via of ["fetch", "curl"]) {
    try {
      const text = via === "fetch" ? await fetchTextEM(url) : await execCurl(url, {});
      await sleep(60);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await sleep(250);
    }
  }
  throw lastErr;
}

/** 当前交易日 YYYYMMDD(与 dashToday 一致, 跳过周末) */
function todayCompact() {
  const d = new Date();
  let off = 0;
  const w = d.getDay();
  if (w === 0) off = -2; else if (w === 6) off = -1;
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 抓取涨停/炸板/跌停池: kind ∈ {ZTPool, ZBPool, DTPool} */
async function fetchTopicPool(kind) {
  const url = `https://push2ex.eastmoney.com/getTopic${kind}?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${todayCompact()}`;
  const j = await emGet(url).catch((e) => { console.error(`[philia] fetchTopicPool ${kind} failed:`, e.message); return null; });
  if (!j || !j.data) return null;
  const pool = Array.isArray(j.data.pool) ? j.data.pool : [];
  return { count: typeof j.data.tc === "number" ? j.data.tc : pool.length, pool };
}

/** 全市场涨跌家数(按上证+深证指数聚合 f104/f105/f106) */
async function fetchBreadth() {
  const url = "https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001&fields=f104,f105,f106&np=1&fltt=2&invt=2";
  const j = await emGet(url).catch((e) => { console.error("[philia] fetchBreadth failed:", e.message); return null; });
  const diff = j?.data?.diff || [];
  const sum = (f) => diff.reduce((a, b) => a + (Number(b[f]) || 0), 0);
  return { up: sum("f104"), down: sum("f105"), flat: sum("f106") };
}

/** 由涨停池按行业板块聚合「热门题材」(按涨停家数降序) */
function hotThemesFromPool(pool) {
  const boardMap = new Map();
  for (const s of pool || []) {
    const b = s.hybk || "其他";
    boardMap.set(b, (boardMap.get(b) || 0) + 1);
  }
  return [...boardMap.entries()]
    .map(([name, cnt]) => ({ 板材: name, 涨停家数: cnt }))
    .sort((a, b) => b.涨停家数 - a.涨停家数)
    .slice(0, 12);
}

/** 由涨停池头部(按封单资金/连板)派生的资金-龙头动向(替代原「游资动向」) */
function leaderMomentumFromPool(pool) {
  if (!pool || !pool.length) return [];
  return [...pool]
    .sort((a, b) => (b.fund || 0) - (a.fund || 0))
    .slice(0, 8)
    .map((s) => ({
      名称: `${s.n}(连${s.lbc || s.zttj?.days || 1}板)`,
      买入: `${((s.fund || 0) / 1e8).toFixed(2)}亿封单`,
      卖出: s.hybk || "—",
    }));
}

/** 由涨停池统计连板梯队(一板/二板/三板/高度板/连板率) */
function ladderFromPool(pool) {
  const counts = new Map();
  for (const s of pool || []) {
    const l = s.lbc || s.zttj?.days || 1;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  const get = (n) => counts.get(n) || 0;
  const total = (pool || []).length || 1;
  const firstBoard = get(1);
  const secondBoard = get(2);
  const thirdBoard = get(3);
  const highBoard = [...counts.entries()].reduce((a, b) => (a > b[0] ? a : b[0]), 1);
  return {
    firstBoard,
    secondBoard,
    thirdBoard,
    highBoard: get(highBoard),
    最高连板: highBoard,
    ladderRate: Math.round(((total - firstBoard) / total) * 1000) / 10,
    blownRate: null,
    comment: `最高${highBoard}连板, 连板股${total - firstBoard}只`,
  };
}

function dashToday() {
  const d = new Date();
  let off = 0;
  const w = d.getDay();
  if (w === 0) off = -2; else if (w === 6) off = -1;
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------------- 技能库解析 ---------------- */

/** 解析 SKILL.md, 提取 front-matter 与各「游资」小节为可选技能 */
function loadSkills() {
  const file = path.join(SKILL_DIR, "SKILL.md");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf-8");
  // front-matter name/description
  let docDesc = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const d = fm[1].match(/description:\s*"(.+?)"/);
    if (d) docDesc = d[1];
  }
  // 按 "## " 切分小节, 识别 "X、名称（标签）" 标题
  const skills = [];
  const parts = text.split(/^## /m);
  for (const part of parts) {
    const firstLine = part.split("\n")[0].trim();
    const m = firstLine.match(/^[一二三四五六七八九十]、(.+?)(?:[（(](.+?)[）)])?$/);
    if (!m) continue;
    let name = m[1].trim();
    let tag = (m[2] || "").trim();
    // 兼容 "名称 · 标签" 形式(如 "炒股养家 · 情绪流交易系统")
    const sep = name.indexOf("·");
    if (sep > 0) {
      if (!tag) tag = name.slice(sep + 1).trim();
      name = name.slice(0, sep).trim();
    }
    skills.push({
      name,
      description: tag || "游资交易思维",
      slug: `yg-${name}`,
      content: part.trim(),
    });
  }
  // 提供"全览"选项(注入各游资核心决策启发式)
  if (skills.length) {
    skills.unshift({
      name: "七大游资全览",
      description: docDesc || "七大顶级游资交易思维精华合集",
      slug: "all",
      content: text,
    });
  }
  return skills;
}

/* ---------------- 客观数据过滤(龙头情绪复盘技能) ----------------
 * 仅从 luotou-qingxu-sipan/SKILL.md 中提取「客观数据方法论」:
 * 数据来源 URL、采集完整性要求、数据提取要点、来源标注规范。
 * 完全排除任何主观观点、情绪倾向、结论性/指导性研判等非事实性杂质内容。
 * 该内容在 Prompt 中作为「次要参考」注入, 优先级严格低于 youzi-qijie-jinghua。
 */
// 仅保留以下客观数据章节(以 `## ` 二级标题识别), 其余(分析维度/输出原则等主观研判)一律剔除
const LUOTOU_KEEP_HEADERS = [
  "一、数据来源",
  "一·补、数据采集完整性要求",
  "一·补2、数据提取要点",
];
// 主观/情绪/结论性词汇(命中即整行过滤)
const LUOTOU_SUBJECTIVE_RE =
  /(主观看好|情绪面|心理层面|资金情绪正盛|予以追捧|谨慎对待|不宜追高|逢高减磅|切勿|大胆|果断|坚决|重仓|满仓|强烈看|后市可期|值得期待|抄底|逃顶|恐慌|贪婪|狂热|杀跌|诱多|诱空|我判断|我倾向|我认为|我觉得|方可进入)/;

/** 读取并严格过滤「龙头情绪复盘」技能的客观数据部分 */
function loadLuotouObjectiveData() {
  if (!fs.existsSync(LUOTOU_SKILL_PATH)) return "";
  const md = fs.readFileSync(LUOTOU_SKILL_PATH, "utf-8");
  const sections = md.split(/^##\s+/m);
  const kept = [];
  for (const sec of sections) {
    const firstLine = sec.split("\n")[0].trim();
    if (!LUOTOU_KEEP_HEADERS.some((h) => firstLine.includes(h))) continue;
    const body = sec.split("\n").slice(1).join("\n");
    kept.push(`## ${firstLine}\n${body}`);
  }
  // 二次清洗: 逐行剔除主观/情绪/结论性语句, 仅保留客观事实与数据
  const cleaned = kept
    .join("\n")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      if (LUOTOU_SUBJECTIVE_RE.test(t)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned;
}

/* ---------------- 模型列表 / Key 校验(OpenRouter) ---------------- */

let modelCache = { ts: 0, data: null };
async function listModels(orKey) {
  if (modelCache.data && Date.now() - modelCache.ts < MODEL_CACHE_TTL) return modelCache.data;
  let data = DEFAULT_MODELS;
  if (orKey) {
    try {
      const resp = await fetch(`${OR_BASE}/models`, {
        headers: { Authorization: `Bearer ${orKey}` },
        signal: AbortSignal.timeout(8000),
      });
      const j = await resp.json();
      const available = new Set((j?.data || []).map((x) => x.id));
      // 仅保留白名单内且上游存在的模型(保持默认顺序)
      const picked = DEFAULT_MODELS.filter((m) => available.has(m.id));
      if (picked.length) data = picked;
    } catch (e) {
      console.error("[philia] listModels failed:", e.message);
    }
  }
  modelCache = { ts: Date.now(), data };
  return data;
}

/** 校验 API Key 有效性(OpenRouter / DeepSeek 自动识别) */
async function validateKey(key) {
  const or = isOpenRouterKey(key);
  try {
    if (or) {
      const resp = await fetch(`${OR_BASE}/auth/key`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(8000),
      });
      const j = await resp.json().catch(() => null);
      if (resp.ok && j?.data) return { valid: true, label: j.data.label || null };
      return { valid: false, error: `Key 无效或被拒绝: ${j?.error?.message || `HTTP ${resp.status}`}` };
    }
    // DeepSeek: 直接发最小 chat 请求校验(analyze 路径已验证可行; /models 偶发 401 故不用它判定)
    const poke = await fetch(`${DS_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "输出合法 JSON: {\"ok\":true}" }],
        max_tokens: 16,
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(12000),
    }).catch((e) => {
      console.error("[philia][validate] poke error:", e.message);
      return null;
    });
    if (poke?.ok) return { valid: true, label: "DeepSeek" };
    const j = await poke?.json().catch(() => null);
    return { valid: false, error: `Key 无效或被拒绝: ${j?.error?.message || (poke ? `HTTP ${poke.status}` : "网络错误")}` };
  } catch (e) {
    return { valid: false, error: `校验失败: ${e.message}` };
  }
}

/* ---------------- 市场数据白皮书组装 ---------------- */

let contextCache = { ts: 0, data: null };
/** 龙头股参考池提供者(由 index.cjs 注入, 避免循环依赖); 未注入则跳过 */
let leaderPoolGetter = null;
function setLeaderPoolGetter(fn) { leaderPoolGetter = fn; }
/** Epoch ms → "YYYY-MM-DD HH:MM"(分钟级) */
function fmtMin(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 网页数据源名称(与 Promise.allSettled 结果下标对齐) */
const SRC_NAMES = ["东方财富·涨停池", "东方财富·炸板池", "东方财富·跌停池", "东方财富·全市场涨跌家数"];

/** 组装市场数据白皮书 —— 数据源全部来自网页抓取(东方财富公开接口), 不再连接本地 KPL 代理 */
async function assembleContext(tracer) {
  const t0 = Date.now();
  if (contextCache.data && Date.now() - contextCache.ts < CONTEXT_CACHE_TTL) {
    tracer?.add({
      type: "resource", name: "数据白皮书(缓存命中)", status: "ok",
      startedAt: Date.now(), durationMs: 0,
      params: { cacheTtlSec: CONTEXT_CACHE_TTL / 1000 },
      summary: "CONTEXT_CACHE_TTL 内直接复用, 未重新拉取网页数据源",
    });
    return contextCache.data;
  }
  const today = dashToday();
  // 并行抓取 4 路网页数据源, 任一失败不影响整体(Promise.allSettled)
  const results = await Promise.allSettled([
    fetchTopicPool("ZTPool"),   // 涨停池
    fetchTopicPool("ZBPool"),   // 炸板池
    fetchTopicPool("DTPool"),   // 跌停池
    fetchBreadth(),             // 全市场涨跌家数
  ]);
  const zt = results[0].status === "fulfilled" ? results[0].value : null;
  const zb = results[1].status === "fulfilled" ? results[1].value : null;
  const dt = results[2].status === "fulfilled" ? results[2].value : null;
  const breadth = results[3].status === "fulfilled" ? results[3].value : null;

  // 记录 4 路网页数据源加载步骤(并行, 统一使用本次组装起点时间戳)
  const srcMeta = [
    { name: "东方财富·涨停池", kind: "ZTPool" },
    { name: "东方财富·炸板池", kind: "ZBPool" },
    { name: "东方财富·跌停池", kind: "DTPool" },
  ];
  srcMeta.forEach((m, i) => {
    const ok = results[i]?.status === "fulfilled";
    tracer?.add({
      type: "resource", name: m.name, status: ok ? "ok" : "failed",
      startedAt: t0, durationMs: Date.now() - t0,
      params: { kind: m.kind, date: today },
      summary: ok ? `获取成功` : `获取失败(已降级, 不影响整体)`,
    });
  });
  tracer?.add({
    type: "resource", name: "东方财富·全市场涨跌家数", status: breadth ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 范围: "上证 + 深证聚合" },
    summary: breadth ? `上涨${breadth.up} 下跌${breadth.down} 平${breadth.flat}` : "获取失败",
  });

  const ztCount = zt?.count ?? (zt?.pool ? zt.pool.length : 0);
  const zbCount = zb?.count ?? (zb?.pool ? zb.pool.length : 0);
  const dtCount = dt?.pool ? dt.pool.length : 0;
  const up = breadth?.up ?? 0;
  const down = breadth?.down ?? 0;
  const flat = breadth?.flat ?? 0;

  // 组装 LLM 所需各字段(字段口径与原 KPL 白皮书保持一致, 避免 prompt 结构变化)
  const mood = {
    上涨家数: up,
    下跌家数: down,
    涨停家数: ztCount,
    跌停家数: dtCount,
    涨跌比: down > 0 ? (up / down).toFixed(2) : "—",
    全市场流通量: null,
  };
  const riseFall = {
    limit_up_count: ztCount,
    limit_down_count: dtCount,
    broken_limit_up_count: zbCount,
    blown_limit_up_rate: ztCount + zbCount > 0 ? Math.round((zbCount / (ztCount + zbCount)) * 1000) / 10 : 0,
    yesterday_limit_up_performance: null,
  };
  const themeHot = hotThemesFromPool(zt?.pool);
  const youzi = leaderMomentumFromPool(zt?.pool);
  const liveLadder = ladderFromPool(zt?.pool); // 实时连板梯队(由涨停池统计)

  const trends = getTrends().slice(-30);       // 近 30 日情绪趋势(本地库)
  const ladder = getLadderTrend().slice(-10);  // 近 10 日连板梯队(本地库)
  tracer?.add({
    type: "resource", name: "本地情绪趋势 + 连板梯队", status: "ok",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 趋势天数: trends.length, 梯队天数: ladder.length },
    summary: `近 ${trends.length} 日情绪趋势, 近 ${ladder.length} 日连板梯队`,
  });

  // 记录数据源名称与获取时间(分钟级, 供前端追溯时效性)
  const fetchedMin = fmtMin(Date.now());
  const sources = [];
  SRC_NAMES.forEach((name, i) => {
    if (results[i]?.status === "fulfilled" && results[i].value != null) {
      sources.push({ name, fetchedAt: fetchedMin });
    }
  });
  if (trends.length) sources.push({ name: "本地情绪趋势", fetchedAt: fetchedMin });
  if (ladder.length) sources.push({ name: "本地连板梯队", fetchedAt: fetchedMin });

  // 核心标的参考池(主板热点 → 龙头股): 由 index.cjs 注入的 getter 获取, 失败不影响整体分析
  let leaderPool = null;
  if (typeof leaderPoolGetter === "function") {
    try { leaderPool = await leaderPoolGetter(); } catch (e) { console.error("[philia] leaderPool get failed:", e?.message || e); }
  }
  tracer?.add({
    type: "resource", name: "龙头股参考池(网页热点)", status: leaderPool ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 池内数量: leaderPool?.pool?.length ?? 0 },
    summary: leaderPool?.pool?.length ? `获取 ${leaderPool.pool.length} 只龙头参考股` : "未获取或获取失败",
  });
  if (leaderPool && leaderPool.pool && leaderPool.pool.length) {
    sources.push({ name: "龙头股参考池(网页热点)", fetchedAt: fmtMin(leaderPool.updatedAt || Date.now()) });
  }

  const ctx = {
    date: today,
    mood: mood || null,
    riseFall: riseFall || null,
    limitUpDown: zt?.pool || null,   // 涨停池明细
    broken: zb?.pool || null,        // 炸板池明细
    themeHot: themeHot || null,
    youzi: youzi || null,
    liveLadder,   // 实时连板梯队(网页数据源统计)
    trends,       // 近 30 日情绪趋势
    ladder,       // 近 10 日连板梯队(本地库)
    leaderPool,   // 核心标的参考池(龙头股)
    sources,      // 数据源清单(名称 + 获取时间)
  };
  contextCache = { ts: Date.now(), data: ctx };
  return ctx;
}

/** 把白皮书压缩为文本(供 LLM 上下文), 控制 token 长度 */
function contextToText(ctx) {
  const lines = [];
  lines.push(`分析日期: ${ctx.date}`);
  const m = ctx.mood || {};
  lines.push(`[市场情绪] 上涨家数:${m["上涨家数"] ?? m.upCount ?? "—"} 下跌家数:${m["下跌家数"] ?? m.downCount ?? "—"} 涨停:${m["涨停家数"] ?? "—"} 跌停:${m["跌停家数"] ?? "—"} 涨跌比:${m["涨跌比"] ?? "—"} 流通量:${m["全市场流通量"] ?? "—"}`);
  if (ctx.themeHot) {
    let th = Array.isArray(ctx.themeHot?.data) ? ctx.themeHot.data : Array.isArray(ctx.themeHot) ? ctx.themeHot : [];
    th = th.slice(0, 10);
    lines.push(`[热门题材 TOP] ` + th.map((t) => `${t["板材"] ?? t.name ?? t["题材"] ?? "?"}(${t["涨停家数"] ?? "?"}家涨停)`).join("、"));
  }
  if (Array.isArray(ctx.youzi) && ctx.youzi.length) {
    const yz = ctx.youzi.slice(0, 8);
    lines.push(`[游资动向] ` + yz.map((y) => `${y["名称"] ?? y["营业部"] ?? "?"} 买:${y["买入"] ?? "—"} 卖:${y["卖出"] ?? "—"}`).join("；"));
  }
  const rf = ctx.riseFall || {};
  lines.push(`[涨跌停统计] 涨停:${rf["limit_up_count"] ?? "—"} 跌停:${rf["limit_down_count"] ?? "—"} 炸板:${rf["broken_limit_up_count"] ?? "—"} 炸板率:${rf["blown_limit_up_rate"] ?? "—"}% 昨日涨停今表现:${rf["yesterday_limit_up_performance"] ?? "—"}%`);
  // 优先使用网页数据源实时统计的连板梯队, 其次本地库
  const liveLadder = ctx.liveLadder;
  if (liveLadder && (liveLadder.firstBoard != null || liveLadder.highBoard != null)) {
    lines.push(`[连板梯队(实时网页统计)] 一板:${liveLadder.firstBoard} 二板:${liveLadder.secondBoard} 三板:${liveLadder.thirdBoard} 高度板:${liveLadder.highBoard} 最高连板:${liveLadder["最高连板"]}板 连板率:${liveLadder.ladderRate}% ${liveLadder.comment || ""}`);
  } else if (ctx.ladder && ctx.ladder.length) {
    const last = ctx.ladder[ctx.ladder.length - 1];
    lines.push(`[连板梯队] 一板:${last.firstBoard} 二板:${last.secondBoard} 三板:${last.thirdBoard} 高度板:${last.highBoard} 连板率:${last.ladderRate}% 破板率:${last.blownRate}% 评价:${last.comment || "—"}`);
  }
  // 涨停池明细(网页数据源): 连板/封单/行业, 供 LLM 识别龙头与题材
  if (Array.isArray(ctx.limitUpDown) && ctx.limitUpDown.length) {
    const top = ctx.limitUpDown.slice(0, 12);
    lines.push(`[涨停池 TOP] ` + top.map((s) => `${s.n}(${emSymbol(s.c)}) 连${s.lbc || s.zttj?.days || 1}板 封单${((s.fund || 0) / 1e8).toFixed(2)}亿 行业:${s.hybk || "—"}`).join("；"));
  }
  if (ctx.trends && ctx.trends.length) {
    const recent = ctx.trends.slice(-5).map((t) => `${t.date} 涨停${t.limitUp}/跌停${t.limitDown}/炸板率${t.blownRate}%`).join("；");
    lines.push(`[近5日情绪趋势] ${recent}`);
  }
  // 核心标的参考池(市场实时热点 → 龙头股): 供 LLM 从中挑选核心标的
  if (ctx.leaderPool && Array.isArray(ctx.leaderPool.pool) && ctx.leaderPool.pool.length) {
    const top = ctx.leaderPool.pool.slice(0, 15);
    const w = ctx.leaderPool.meta?.weights || {};
    lines.push(`[龙头股参考池] 打分权重=封单占流通市值${Math.round((w.seal||0)*100)}% 板块涨停${Math.round((w.boardLimitUp||0)*100)}% 连板${Math.round((w.ladder||0)*100)}% 板块资金${Math.round((w.capital||0)*100)}%(池内归一化,0-100)`);
    lines.push(`[龙头股 TOP] ` + top.map((s) => `${s.name}(${s.code}) 板块=${s.board} 分${s.score} 封单占流通${s.sealRatio!=null?s.sealRatio.toFixed(2):"—"}% 涨停${s.boardLimitUp}家 连板${s.ladder} 流通${s.floatMarketCap}亿`).join("；"));
    lines.push(`提示: 核心标的(stocks)应优先从上述「龙头股参考池」中挑选, 并结合其板块热度与量化评分给出权重与目标。`);
  }
  return lines.join("\n");
}

/* ---------------- Prompt 组装 & LLM 调用 ---------------- */

function buildPrompt(ctx, skills) {
  const sys = `
你是一位深耕A股短线与题材的资深市场分析师, 擅长以游资视角解读市场情绪、识别机会与风险、锁定龙头核心标的。
请基于给定的市场数据, 输出严格合法的 JSON(不要任何多余文字/注释/代码块标记), 结构如下:
{
  "sentiment": { "score": 0-100整数, "level": "情绪周期阶段", "comment": "一两句文字说明" },
  "opportunities": [ { "type": "机会类型", "sector": "领域/题材", "analysis": "逻辑分析", "expectedReturn": "预期收益区间", "weight": 0-1权重数字 } ],
  "risks": [ { "level": "高/中/低", "scope": "全市场/板块/个股", "description": "风险描述", "mitigation": "缓解建议", "weight": 0-1权重数字 } ],
  "stocks": [ { "name": "公司名", "code": "带交易所前缀代码如sh600519", "reason": "推荐依据", "target": "目标价区间", "weight": 0-1权重数字 } ]
}
要求:
- opportunities 至少 3 个, risks 至少 3 个, stocks 3-5 只。
- 每个机会/风险/股票必须带 weight(0-1), 且所有 weight 之和应接近 1(归一化)。
- 只依据给定数据与游资思维推断, 不编造具体价格/数据; 目标价为区间估计, 需说明依据逻辑。
- 当前仅作研究参考, 不含任何投资建议免责条款。`;
  let user = `以下是当前市场数据白皮书:\n${contextToText(ctx)}`;
  if (skills && skills.length) {
    // 注入所选技能原文(截断控制成本)
    let skillText = "";
    for (const s of skills) {
      if (skillText.length >= MAX_PROMPT_SKILL_CHARS) break;
      const c = s.content || "";
      skillText += (skillText ? "\n\n" : "") + c.slice(0, MAX_PROMPT_SKILL_CHARS - skillText.length);
    }
    user += `\n\n请结合以下「游资交易思维」进行研判(融入相应视角):\n${skillText}`;
  } else {
    user += `\n\n(未指定技能, 请以通用市场分析视角研判。)`;
  }
  // 注入「客观数据方法论」(次要参考, 优先级低于上方 youzi-qijie-jinghua 游资交易思维)
  const luotou = loadLuotouObjectiveData();
  if (luotou) {
    user += `\n\n【客观数据方法论 · 次要参考·仅数据】以下为数据采集与来源标注的客观规则, 优先级低于上述「游资交易思维」, 仅用于确保数据来源可追溯、结构化完整, 禁止据此输出任何主观研判或情绪化结论:\n${luotou}`;
  }
  return { system: sys, user };
}

async function callLLM(apiKey, model, prompt) {
  const or = isOpenRouterKey(apiKey);
  const base = or ? OR_BASE : DS_BASE;
  // DeepSeek 官方模型 id 形如 deepseek-v4-flash, 将 OpenRouter 风格 id(deepseek/xxx)映射为末尾段
  const actualModel = or ? model : (model.includes("/") ? model.split("/").pop() : model) || "deepseek-v4-flash";
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (or) {
    headers["HTTP-Referer"] = "http://localhost:3000/";
    headers["X-Title"] = "Market Research Cockpit - PHILIA";
  }
  const resp = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: actualModel,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.3,
      // DeepSeek V4 为推理模型, 先消费大量 token 于 reasoning, 需更大预算才能落到 content
      max_tokens: or ? 4096 : 8192,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(150000),
  });
  const j = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = j?.error?.message || `HTTP ${resp.status}`;
    throw Object.assign(new Error(`LLM 调用失败: ${err}`), { status: 502 });
  }
  const msg = j?.choices?.[0]?.message;
  let content = msg?.content;
  // 推理模型可能只输出 reasoning_content; 从中尽力提取 JSON 块兜底
  if (!content && msg?.reasoning_content) {
    const m = String(msg.reasoning_content).match(/\{[\s\S]*\}/);
    if (m) content = m[0];
  }
  if (!content) throw Object.assign(new Error("LLM 未返回内容"), { status: 502 });
  try {
    return JSON.parse(content);
  } catch {
    throw Object.assign(new Error("LLM 返回非合法 JSON"), { status: 502 });
  }
}

/** 结构化结果校验与规范化(容错 + 权重归一化) */
function normalizeResult(raw) {
  const num = (v, lo = 0, hi = 1) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
  };
  const s = raw?.sentiment || {};
  const sentiment = {
    score: Math.round(Math.min(100, Math.max(0, num(s.score, 0, 100)))),
    level: String(s.level || "未知"),
    comment: String(s.comment || ""),
  };
  const opportunities = (Array.isArray(raw?.opportunities) ? raw.opportunities : []).slice(0, 6)
    .map((o) => ({
      type: String(o.type || "题材"),
      sector: String(o.sector || ""),
      analysis: String(o.analysis || ""),
      expectedReturn: String(o.expectedReturn || ""),
      weight: num(o.weight),
    }));
  const risks = (Array.isArray(raw?.risks) ? raw.risks : []).slice(0, 6)
    .map((r) => ({
      level: ["高", "中", "低"].includes(r.level) ? r.level : "中",
      scope: String(r.scope || ""),
      description: String(r.description || ""),
      mitigation: String(r.mitigation || ""),
      weight: num(r.weight),
    }));
  const stocks = (Array.isArray(raw?.stocks) ? raw.stocks : []).slice(0, 5)
    .map((x) => ({
      name: String(x.name || ""),
      code: String(x.code || ""),
      reason: String(x.reason || ""),
      target: String(x.target || ""),
      weight: num(x.weight),
    }));
  // 权重归一化: 各段内部权重保持, 整体越界时按比例收缩到 1
  const all = [...opportunities.map((o) => o.weight), ...risks.map((r) => r.weight), ...stocks.map((x) => x.weight)];
  const total = all.reduce((a, b) => a + b, 0) || 1;
  if (total > 1.0001) {
    const scale = 1 / total;
    opportunities.forEach((o) => (o.weight = Math.round(o.weight * scale * 100) / 100));
    risks.forEach((r) => (r.weight = Math.round(r.weight * scale * 100) / 100));
    stocks.forEach((x) => (x.weight = Math.round(x.weight * scale * 100) / 100));
  }
  return { sentiment, opportunities, risks, stocks };
}

/* ---------------- 对外接口 ---------------- */

/** 读取配置(不含明文 key) */
function getConfig() {
  const k = getAiKey();
  if (!k) return { hasKey: false, keyMask: null, model: "", skills: [] };
  let plain = null;
  try { plain = k.encKey && k.encIv ? decrypt(k) : null; } catch { plain = null; }
  return {
    hasKey: !!plain,
    keyMask: plain ? maskKey(plain) : null,
    model: k.model || "",
    skills: Array.isArray(k.skills) ? k.skills : [],
  };
}

/** 保存配置: 有 key 则加密存储; 仅更新模型/技能 */
function saveConfig({ key, model, skills }) {
  const existing = getAiKey();
  let encKey = existing?.encKey || null;
  let encIv = existing?.encIv || null;
  if (typeof key === "string" && key.trim()) {
    const e = encrypt(key.trim());
    encKey = e.encKey;
    encIv = e.encIv;
  }
  const safeModel = typeof model === "string" && model ? model : existing?.model || "";
  const safeSkills = Array.isArray(skills) ? skills.slice(0, 20) : [];
  upsertAiKey({ provider: "openrouter", encKey, encIv, model: safeModel, skills: safeSkills });
  return getConfig();
}

/** 触发综合分析(降频缓存; force 绕过缓存) */
async function analyze({ model, skills = [], force = false }) {
  const tracer = createTracer();
  const tStart = Date.now();
  tracer.add({ type: "agent", name: "启动综合分析", status: "ok", startedAt: tStart, durationMs: 0, params: { force: !!force }, summary: "情绪评分 / 机会 / 风险 / 核心标的" });
  if (!MODEL_WHITELIST.has(model)) {
    throw Object.assign(new Error("不支持的模型"), { status: 400 });
  }
  const k = getAiKey();
  if (!k || !k.encKey || !k.encIv) {
    throw Object.assign(new Error("尚未配置 API Key"), { status: 400 });
  }
  const apiKey = decrypt(k);
  const date = dashToday();
  const sorted = [...skills].sort();
  const cacheKey = crypto.createHash("sha256")
    .update(`${date}|${model}|${sorted.join(",")}`)
    .digest("hex");

  // 命中缓存(未强制刷新) -> 直接返回, 不重复计费
  if (!force) {
    const hit = getAiAnalysis(cacheKey);
    if (hit && hit.result) {
      tracer.add({ type: "tool", name: "分析结果缓存", status: "ok", startedAt: Date.now(), durationMs: 0, params: { cacheKey }, summary: "30min 降频缓存命中, 未重新调用 LLM" });
      return { ...hit, fromCache: true, cacheKey, trace: tracer.steps };
    }
  }

  // 组数据白皮书 + 技能内容 + 调 LLM
  const ctx = await assembleContext(tracer);
  const skillList = loadSkills();
  const selected = skillList.filter((s) => sorted.includes(s.name));
  tracer.add({ type: "resource", name: "技能库(游资交易思维)", status: "ok", startedAt: Date.now(), durationMs: 0, params: { 命中技能: selected.map((s) => s.name) }, summary: `加载 ${selected.length} 项技能注入 prompt` });
  const prompt = buildPrompt(ctx, selected);
  tracer.add({ type: "tool", name: "组装 LLM Prompt", status: "ok", startedAt: Date.now(), durationMs: 0, params: { 模型: model }, summary: "白皮书 + 技能拼接为单轮 prompt" });
  const llmT0 = Date.now();
  const raw = await callLLM(apiKey, model, prompt).catch((e) => {
    tracer.add({ type: "tool", name: "调用 LLM(推理模型)", status: "failed", startedAt: llmT0, durationMs: Date.now() - llmT0, params: { 模型: model }, summary: e?.message || "LLM 调用失败" });
    throw e;
  });
  tracer.add({ type: "tool", name: "调用 LLM(推理模型)", status: "ok", startedAt: llmT0, durationMs: Date.now() - llmT0, params: { 模型: model }, summary: "已返回结构化 JSON 结果" });
  const result = normalizeResult(raw);
  // 记录 AI 生成内容所参考的数据源(名称 + 获取时间, 分钟级), 随结果一并持久化
  result.sources = (ctx.sources || []).map((s) => ({ name: s.name, fetchedAt: s.fetchedAt }));
  tracer.add({ type: "tool", name: "结果规范化", status: "ok", startedAt: Date.now(), durationMs: 0, params: {}, summary: "情绪/机会/风险/标的校验与权重归一化" });

  upsertAiAnalysis({ cacheKey, date, model, skillsHash: sorted.join(","), result });
  return { cacheKey, date, model, skillsHash: sorted.join(","), result, createdAt: Date.now(), updatedAt: Date.now(), fromCache: false, trace: tracer.steps };
}

/** 历史分析记录 */
function history(limit = 20) {
  return listAiAnalyses(limit).map((a) => ({ ...a, fromCache: false }));
}

/* ---------------- 龙头情绪复盘(4 模块) ---------------- */

/** 4 模块复盘 prompt: 今日龙头核心 / 今日情绪周期 / 今日机会 / 今日风险 */
function buildMarketPrompt(ctx, skills) {
  const sys = `
你是一位深耕A股超短线的资深市场分析师, 擅长以游资视角做「龙头 + 情绪周期」结构化复盘。
请基于给定的市场数据, 输出严格合法的 JSON(不要任何多余文字/注释/代码块标记), 结构如下:
{
  "leaderCore": {
    "title": "今日总龙头一句话概括",
    "summary": "龙头梯队结构、市场共识与带动性的详细分析",
    "leaders": [ { "name": "公司名", "code": "带交易所前缀如sh600519", "board": "所属板块", "ladder": 连板高度数字, "seal": "封单/强度描述", "note": "定位点评" } ]
  },
  "sentimentCycle": { "stage": "冰点/回暖/高潮/退潮阶段", "indicators": "涨停家数/连板/炸板率等关键情绪指标", "analysis": "情绪周期阶段研判" },
  "opportunities": [ { "type": "机会类型", "sector": "板块/题材", "analysis": "机会逻辑", "opportunity": "可操作机会点" } ],
  "risks": [ { "level": "高/中/低", "scope": "全市场/板块/个股", "description": "风险描述", "mitigation": "应对建议" } ]
}
要求:
- leaderCore.leaders 3-5 只(今日龙头核心), ladder 为数字。
- opportunities 至少 3 个, risks 至少 3 个。
- sentimentCycle.stage 必须明确给出情绪周期阶段。
- 只依据给定数据与游资思维推断, 不编造具体价格/数据。
- 当前仅作研究参考, 不构成投资建议。`;
  let user = `以下是当前市场数据白皮书:\n${contextToText(ctx)}`;
  if (skills && skills.length) {
    let skillText = "";
    for (const s of skills) {
      if (skillText.length >= MAX_PROMPT_SKILL_CHARS) break;
      const c = s.content || "";
      skillText += (skillText ? "\n\n" : "") + c.slice(0, MAX_PROMPT_SKILL_CHARS - skillText.length);
    }
    user += `\n\n请结合以下「游资交易思维」进行研判(融入相应视角):\n${skillText}`;
  } else {
    user += `\n\n(未指定技能, 请以通用游资视角研判。)`;
  }
  // 注入「客观数据方法论」(次要参考, 优先级低于上方 youzi-qijie-jinghua 游资交易思维)
  const luotou = loadLuotouObjectiveData();
  if (luotou) {
    user += `\n\n【客观数据方法论 · 次要参考·仅数据】以下为数据采集与来源标注的客观规则, 优先级低于上述「游资交易思维」, 仅用于确保数据来源可追溯、结构化完整, 禁止据此输出任何主观研判或情绪化结论:\n${luotou}`;
  }
  return { system: sys, user };
}

/** 4 模块结果校验与规范化(容错) */
function normalizeMarketResult(raw) {
  const num = (v, lo = 0, hi = 999) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
  };
  const lc = raw?.leaderCore || {};
  const leaderCore = {
    title: String(lc.title || ""),
    summary: String(lc.summary || ""),
    leaders: (Array.isArray(lc.leaders) ? lc.leaders : []).slice(0, 6).map((x) => ({
      name: String(x.name || ""),
      code: String(x.code || ""),
      board: String(x.board || ""),
      ladder: num(x.ladder, 0, 99),
      seal: String(x.seal || ""),
      note: String(x.note || ""),
    })),
  };
  const sc = raw?.sentimentCycle || {};
  const sentimentCycle = {
    stage: String(sc.stage || "未知"),
    indicators: String(sc.indicators || ""),
    analysis: String(sc.analysis || ""),
  };
  const opportunities = (Array.isArray(raw?.opportunities) ? raw.opportunities : []).slice(0, 6)
    .map((o) => ({
      type: String(o.type || "题材"),
      sector: String(o.sector || ""),
      analysis: String(o.analysis || ""),
      opportunity: String(o.opportunity || ""),
    }));
  const risks = (Array.isArray(raw?.risks) ? raw.risks : []).slice(0, 6)
    .map((r) => ({
      level: ["高", "中", "低"].includes(r.level) ? r.level : "中",
      scope: String(r.scope || ""),
      description: String(r.description || ""),
      mitigation: String(r.mitigation || ""),
    }));
  return { leaderCore, sentimentCycle, opportunities, risks };
}

/** 龙头情绪复盘(4 模块): 复用 LLM 管线与降频缓存 */
async function analyzeMarket({ model, skills = [], force = false }) {
  const tracer = createTracer();
  const tStart = Date.now();
  tracer.add({ type: "agent", name: "启动龙头情绪复盘", status: "ok", startedAt: tStart, durationMs: 0, params: { force: !!force, 模块数: 4 }, summary: "今日龙头核心 / 情绪周期 / 机会 / 风险" });
  // 未显式指定模型时, 取已配置模型或默认模型(前端 config/skills 接口可能未启用)
  if (!model) model = getAiKey()?.model || DEFAULT_MODELS.find((m) => m.default)?.id || "";
  if (!MODEL_WHITELIST.has(model)) {
    throw Object.assign(new Error("不支持的模型"), { status: 400 });
  }
  const k = getAiKey();
  if (!k || !k.encKey || !k.encIv) {
    throw Object.assign(new Error("尚未配置 API Key"), { status: 400 });
  }
  const apiKey = decrypt(k);
  const date = dashToday();
  const sorted = [...skills].sort();
  const cacheKey = crypto.createHash("sha256")
    .update(`market4|${date}|${model}|${sorted.join(",")}`)
    .digest("hex");

  // 命中缓存(未强制刷新) -> 直接返回, 不重复计费
  if (!force) {
    const hit = getAiAnalysis(cacheKey);
    if (hit && hit.result) {
      tracer.add({ type: "tool", name: "分析结果缓存", status: "ok", startedAt: Date.now(), durationMs: 0, params: { cacheKey }, summary: "30min 降频缓存命中, 未重新调用 LLM" });
      return { ...hit, fromCache: true, cacheKey, trace: tracer.steps };
    }
  }

  const ctx = await assembleContext(tracer);
  const skillList = loadSkills();
  const selected = skillList.filter((s) => sorted.includes(s.name));
  tracer.add({
    type: "resource", name: "技能库(游资交易思维)", status: "ok",
    startedAt: Date.now(), durationMs: 0,
    params: { 命中技能: selected.map((s) => s.name) },
    summary: `加载 ${selected.length} 项技能注入 prompt`,
  });
  const prompt = buildMarketPrompt(ctx, selected);
  tracer.add({ type: "tool", name: "组装 LLM Prompt", status: "ok", startedAt: Date.now(), durationMs: 0, params: { 模型: model, 技能数: selected.length }, summary: "白皮书 + 技能拼接为单轮 prompt" });
  const llmT0 = Date.now();
  const raw = await callLLM(apiKey, model, prompt).catch((e) => {
    tracer.add({ type: "tool", name: "调用 LLM(推理模型)", status: "failed", startedAt: llmT0, durationMs: Date.now() - llmT0, params: { 模型: model }, summary: e?.message || "LLM 调用失败" });
    throw e;
  });
  tracer.add({ type: "tool", name: "调用 LLM(推理模型)", status: "ok", startedAt: llmT0, durationMs: Date.now() - llmT0, params: { 模型: model }, summary: "已返回结构化 JSON 结果" });
  const result = normalizeMarketResult(raw);
  result.sources = (ctx.sources || []).map((s) => ({ name: s.name, fetchedAt: s.fetchedAt }));
  tracer.add({ type: "tool", name: "结果规范化", status: "ok", startedAt: Date.now(), durationMs: 0, params: {}, summary: "4 模块结果校验与字段规范化" });

  upsertAiAnalysis({ cacheKey, date, model, skillsHash: sorted.join(","), result });
  return { cacheKey, date, model, skillsHash: sorted.join(","), result, createdAt: Date.now(), updatedAt: Date.now(), fromCache: false, trace: tracer.steps };
}

module.exports = {
  loadSkills,
  listModels,
  validateKey,
  getConfig,
  saveConfig,
  analyze,
  analyzeMarket,
  history,
  setLeaderPoolGetter,
  DEFAULT_MODELS,
};