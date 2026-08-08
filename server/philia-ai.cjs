/**
 * PHILIA AI 综合分析 - 后端核心
 *
 * 职责:
 *  - 技能库解析(skills/ 根目录下每个子文件夹 = 一个大 skill, 见 SKILL_GROUPS)
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
// 次要客观数据方法论来源(龙头情绪复盘): 仅吸收其客观数据信息, 优先级低于游资交易思维
const LUOTOU_SKILL_PATH = path.join(ROOT, ".trae", "skills", "luotou-qingxu-sipan", "SKILL.md");
const OR_BASE = "https://openrouter.ai/api/v1";
const DS_BASE = "https://api.deepseek.com";

/**
 * 大 skill 自动发现: skills/ 根目录下每个子文件夹 = 一个大 skill(主题),
 * 内含 SKILL.md, 解析出可勾选的子技能(小节)与「全览」选项。
 * 大 skill 显示名取 SKILL.md front-matter 的 `name` 字段(中文), 缺失时回退为目录名。
 * 新增大 skill: 只需在 skills/ 下新建文件夹并放入 SKILL.md, 前后端均无需改注册代码。
 */
const SKILLS_ROOT = path.join(ROOT, "skills");
function loadSkillGroups() {
  const out = [];
  if (!fs.existsSync(SKILLS_ROOT)) return out;
  const dirs = fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const slug of dirs) {
    const dir = path.join(SKILLS_ROOT, slug);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    let name = slug;
    try {
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(file, "utf-8"));
      const n = fm?.[1].match(/^name:\s*(.+?)\s*$/m);
      if (n) name = n[1].trim();
    } catch { /* 解析失败时保留目录名 */ }
    out.push({ slug, name, dir });
  }
  return out;
}

/** 依据 key 前缀识别 provider: sk-or- 为 OpenRouter, 其余 sk- 视为 DeepSeek */
const isOpenRouterKey = (key) => typeof key === "string" && key.startsWith("sk-or-");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MODEL_CACHE_TTL = 30 * 60 * 1000; // 模型列表缓存 30min
const CONTEXT_CACHE_TTL = 5 * 60 * 1000; // 数据白皮书缓存 5min
const ANALYSIS_CACHE_TTL = 30 * 60 * 1000; // 分析结果降频缓存 30min
const MAX_PROMPT_SKILL_CHARS = 20000; // 注入技能提示词上限(容纳全部技能+全览, SKILL.md 全文约 13K 字符)

/* ---------------- 大盘/板块因子(今日+昨日) 数据源 ----------------
 * 将「大盘因子(涨跌幅/量能) 与 板块因子(板块/概念 涨跌幅/主力净额)」的今日+昨日数据
 * 融入 PHILIA 分析条件, 供 LLM 判断大盘环境与板块资金合力。
 *  - 今日大盘: push2delay ulist(指数实时: 点位/涨跌幅/成交额)
 *  - 昨日大盘: push2his 日K(倒数第2根 = 上一交易日收盘/涨跌幅/量能)
 *  - 今日板块: push2delay clist(行业 m:90+t:2 / 概念 m:90+t:3, 涨跌幅TOP + 主力净额TOP)
 *  - 昨日板块: push2his 板块日K(涨跌幅) + 板块资金流日K(主力净额)
 * 注: push2his 对本机 IPv6 不稳定, 已在文件顶部 setDefaultResultOrder("ipv4first");
 *     且 push2his 走 fetch 重试即可, 不回退 curl(schannel 在 push2his 上握手失败)。
 */
const EM_HIS_BASE = "https://push2his.eastmoney.com/api/qt/stock";
const UT_EM = "fa5fd1943c7b386f172d6893dbfba10b"; // push2his kline 校验码(客户端固定)
const INDEX_SECIDS = "1.000001,0.399001,0.399006"; // 上证指数/深证成指/创业板指
const BOARD_FS = { 行业: "m:90+t:2", 概念: "m:90+t:3" };
const BOARD_PICK_N = 8; // 板块涨跌幅/主力净额各取前 N
const BOARD_YEST_MAX = 12; // 拉取昨日数据的板块数量上限(控制请求量)
const KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";

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

/** push2his 历史接口(fetch + 重试, 不回退 curl: schannel 在此域名握手失败) */
async function emGetHis(url, tries = 3) {
  let lastErr = new Error("em his request failed");
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*", Referer: "https://quote.eastmoney.com/" },
        signal: ctrl.signal,
      });
      return JSON.parse(Buffer.from(await resp.arrayBuffer()).toString("utf-8"));
    } catch (e) {
      lastErr = e;
      await sleep(400);
    } finally {
      clearTimeout(timer);
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

/** 上一交易日 YYYYMMDD(跳过周末; 周一→上周五, 周日→上周五) */
function yesterdayCompact() {
  const d = new Date();
  let off = -1;
  const w = d.getDay();
  if (w === 1) off = -3; else if (w === 0) off = -2;
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 抓取涨停/炸板/跌停池: kind ∈ {ZTPool, ZBPool, DTPool}; date 默认当日, 可传历史日期获取昨日快照 */
async function fetchTopicPool(kind, date = todayCompact()) {
  const url = `https://push2ex.eastmoney.com/getTopic${kind}?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${date}`;
  const j = await emGet(url).catch((e) => { console.error(`[philia] fetchTopicPool ${kind}(${date}) failed:`, e.message); return null; });
  if (!j || !j.data) return null;
  const pool = Array.isArray(j.data.pool) ? j.data.pool : [];
  return { count: typeof j.data.tc === "number" ? j.data.tc : pool.length, pool };
}

/** 由昨日涨停池构建「昨日连板梯队」(含个股名单, 按连板高度降序) */
function yestLadderFromPool(pool, date) {
  const counts = new Map();
  for (const s of pool || []) {
    const l = s.lbc || s.zttj?.days || 1;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  const get = (n) => counts.get(n) || 0;
  const total = (pool || []).length || 1;
  const highBoard = [...counts.entries()].reduce((a, b) => (a > b[0] ? a : b[0]), 1);
  return {
    date,
    firstBoard: get(1),
    secondBoard: get(2),
    thirdBoard: get(3),
    highBoard: get(highBoard),
    最高连板: highBoard,
    ladderRate: Math.round(((total - get(1)) / total) * 1000) / 10,
    comment: `昨日最高${highBoard}连板, 昨日涨停${total}家, 昨日连板股${total - get(1)}只`,
    stocks: (pool || [])
      .map((s) => ({ code: s.c, name: s.n, ladder: s.lbc || s.zttj?.days || 1, board: s.hybk || "—" }))
      .sort((a, b) => b.ladder - a.ladder),
  };
}

/** 昨日梯队个股今日实盘对照: 用今日三池(涨停/炸板/跌停)交叉判定每只昨日涨停股的今日状态 */
function matchYesterdayLadder(yestPool, ztPool, zbPool, dtPool) {
  const ztMap = new Map((ztPool || []).map((s) => [s.c, s]));
  const zbSet = new Set((zbPool || []).map((s) => s.c));
  const dtSet = new Set((dtPool || []).map((s) => s.c));
  const rows = [];
  for (const s of yestPool || []) {
    const yLadder = s.lbc || s.zttj?.days || 1;
    const today = ztMap.get(s.c);
    let status;
    let todayLadder = null;
    if (today) {
      todayLadder = today.lbc || today.zttj?.days || 1;
      status = todayLadder > yLadder ? "晋级" : todayLadder === yLadder ? "维持" : "断板";
    } else if (dtSet.has(s.c)) status = "跌停";
    else if (zbSet.has(s.c)) status = "炸板";
    else status = "断板";
    rows.push({ code: s.c, name: s.n, yLadder, todayLadder, status, board: s.hybk || "—" });
  }
  const stats = { 晋级: 0, 维持: 0, 断板: 0, 跌停: 0, 炸板: 0 };
  rows.forEach((r) => { stats[r.status] = (stats[r.status] || 0) + 1; });
  return { rows, stats };
}

/** 龙头低吸候选池: 从昨日连板梯队中筛选「表现亮眼(昨日连板≥2) 且 今日未涨停(断板/炸板/跌停)」的个股 */
function buildLowAbsorbPool(yestPool, yesterdayMatch) {
  if (!Array.isArray(yestPool) || !yesterdayMatch || !Array.isArray(yesterdayMatch.rows)) return [];
  const byCode = new Map((yesterdayMatch.rows || []).map((r) => [r.code, r]));
  const list = [];
  for (const s of yestPool) {
    const r = byCode.get(s.c);
    if (!r) continue;
    // 条件1: 昨日连板≥2(表现亮眼/龙头梯队成员)
    if ((r.yLadder || 1) < 2) continue;
    // 条件2: 今日未处于涨停状态(晋级/维持=今日仍涨停, 排除)
    if (r.status === "晋级" || r.status === "维持") continue;
    list.push({
      code: s.c,
      name: s.n,
      board: s.hybk || r.board || "—",
      yLadder: r.yLadder || 1,
      todayStatus: r.status || "断板",   // 今日状态: 断板/炸板/跌停
      todayLadder: r.todayLadder,
      yestSeal: s.fund ? `${((s.fund || 0) / 1e8).toFixed(2)}亿` : "—", // 昨日封单(判断分歧/一致)
    });
  }
  // 按昨日连板高度降序, 相同高度按昨日封单降序
  return list.sort((a, b) => b.yLadder - a.yLadder || (b.yestSeal === "—" ? -1 : 1));
}

/** 全市场涨跌家数(按上证+深证指数聚合 f104/f105/f106) */
async function fetchBreadth() {
  const url = "https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001&fields=f104,f105,f106&np=1&fltt=2&invt=2";
  const j = await emGet(url).catch((e) => { console.error("[philia] fetchBreadth failed:", e.message); return null; });
  const diff = j?.data?.diff || [];
  const sum = (f) => diff.reduce((a, b) => a + (Number(b[f]) || 0), 0);
  return { up: sum("f104"), down: sum("f105"), flat: sum("f106") };
}

/** 「昨日涨停今表现」(%): 昨日涨停股今日平均涨跌幅。
 *  东财不直接提供该日度聚合口径, 由昨日涨停池代码批量拉今日行情(f3)计算;
 *  均值样本不足时回退「今日仍涨停率(晋级+维持)」近似口径; 仍失败返回 null 由 LLM 如实标注。 */
async function calcYestLimitUpPerformance(yestPool, yesterdayMatch) {
  const codes = (yestPool || []).map((s) => String(s.c)).filter((c) => /^\d{6}$/.test(c)).slice(0, 300);
  if (!codes.length) return null;
  const emMarket = (c) => (/^6|^9/.test(c) ? 1 : 0);
  const pcts = [];
  try {
    for (let i = 0; i < codes.length; i += 50) {
      const chunk = codes.slice(i, i + 50);
      const secids = chunk.map((c) => `${emMarket(c)}.${c}`).join(",");
      const j = await emGet(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f12&np=1&fltt=2&invt=2`).catch(() => null);
      for (const d of j?.data?.diff || []) {
        const pct = Number(d.f3);
        if (Number.isFinite(pct) && Number(d.f2) > 0) pcts.push(pct);
      }
    }
  } catch { /* 走回退口径 */ }
  if (pcts.length >= 10) return Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) / 100;
  // 回退口径: 今日仍涨停(晋级+维持)占昨日涨停总数比例(%), 近似反映昨日涨停股今日承接强度
  const st = yesterdayMatch?.stats;
  if (st) {
    const total = (st.晋级 || 0) + (st.维持 || 0) + (st.断板 || 0) + (st.炸板 || 0) + (st.跌停 || 0);
    if (total > 0) return Math.round(((st.晋级 || 0) + (st.维持 || 0)) / total * 1000) / 10;
  }
  return null;
}

/* ---------------- 大盘因子(今日/昨日): 指数涨跌幅 + 量能 ---------------- */

/** 今日大盘因子: 三大指数实时点位/涨跌幅/涨跌额/成交量/成交额(push2delay ulist) */
async function fetchIndexToday() {
  const url = `https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${INDEX_SECIDS}&fields=f2,f3,f4,f5,f6,f12,f14&np=1&fltt=2&invt=2`;
  const j = await emGet(url).catch((e) => { console.error("[philia] fetchIndexToday failed:", e.message); return null; });
  const diff = j?.data?.diff || [];
  return diff.map((d) => ({
    name: d.f14 || "", code: d.f12 || "",
    point: Number(d.f2) || null, pct: Number(d.f3) || null, change: Number(d.f4) || null,
    vol: Number(d.f5) || null, amount: Number(d.f6) || null, // 量能: 成交量(手)/成交额(元)
  }));
}

/** 昨日大盘因子: 三大指数上一交易日收盘/涨跌幅/量能(push2his 日K, 取倒数第2根) */
async function fetchIndexYesterday() {
  const out = [];
  for (const secid of INDEX_SECIDS.split(",")) {
    try {
      const url = `${EM_HIS_BASE}/kline/get?secid=${secid}&ut=${UT_EM}&klt=101&fqt=1&end=20500101&lmt=3&fields1=f1,f2,f3,f4,f5,f6&fields2=${KLINE_FIELDS2}`;
      const j = await emGetHis(url);
      const klines = j?.data?.klines || [];
      if (klines.length >= 2) {
        const y = klines[klines.length - 2].split(","); // 倒数第2根 = 上一交易日
        out.push({
          name: j.data.name || "", date: y[0], close: Number(y[2]) || null,
          vol: Number(y[5]) || null, amount: Number(y[6]) || null, pct: Number(y[8]) || null, change: Number(y[9]) || null,
        });
      }
    } catch (e) { console.error(`[philia] fetchIndexYesterday ${secid} failed:`, e.message); }
  }
  return out;
}

/* ---------------- 板块因子(今日/昨日): 板块/概念 涨跌幅 + 主力净额 ---------------- */

/** 今日板块因子: 行业/概念 涨跌幅TOP + 主力净额TOP(push2delay clist, 去重合并) */
async function fetchBoardToday() {
  const result = {};
  for (const [type, fs] of Object.entries(BOARD_FS)) {
    const pick = async (fid) => {
      const url = `https://push2delay.eastmoney.com/api/qt/clist/get?fid=${fid}&po=1&pz=${BOARD_PICK_N}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent(fs)}&fields=f12,f14,f3,f62,f8`;
      const j = await emGet(url).catch(() => null);
      return (j?.data?.diff || []).map((b) => ({
        code: b.f12, name: b.f14, pct: Number(b.f3) || null, netIn: Number(b.f62) || null, turnover: Number(b.f8) || null,
      }));
    };
    const [byPct, byNet] = await Promise.all([pick("f3"), pick("f62")]);
    result[type] = [...byPct, ...byNet.filter((b) => !byPct.some((x) => x.code === b.code))];
  }
  return result;
}

/** 昨日板块因子: 对今日TOP板块拉上一交易日涨跌幅(push2his 日K)与主力净额(push2his 资金流日K), 并发受限 */
async function fetchBoardYesterday(boardToday) {
  // 行业/概念各取一半名额, 保证两类都有昨日数据(避免行业独占)
  const perType = Math.ceil(BOARD_YEST_MAX / 2);
  const entries = [];
  for (const [type, list] of Object.entries(boardToday || {})) {
    let n = 0;
    for (const b of list || []) {
      if (n >= perType) break;
      if (entries.some((e) => e[0] === b.code)) continue;
      entries.push([b.code, { name: b.name, type }]);
      n++;
    }
  }
  entries.length = Math.min(entries.length, BOARD_YEST_MAX);
  if (!entries.length) return [];
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [code, meta] = entries[cursor++];
      const rec = { code, name: meta.name, type: meta.type, date: null, pct: null, netIn: null };
      try {
        const [kl, fl] = await Promise.allSettled([
          emGetHis(`${EM_HIS_BASE}/kline/get?secid=90.${code}&ut=${UT_EM}&klt=101&fqt=1&end=20500101&lmt=3&fields1=f1,f2,f3,f4,f5,f6&fields2=${KLINE_FIELDS2}`),
          emGetHis(`${EM_HIS_BASE}/fflow/daykline/get?secid=90.${code}&ut=${UT_EM}&klt=101&lmt=3&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`),
        ]);
        if (kl.status === "fulfilled") {
          const kls = kl.value?.data?.klines || [];
          if (kls.length >= 2) { const y = kls[kls.length - 2].split(","); rec.date = y[0]; rec.pct = Number(y[8]) || null; }
        }
        if (fl.status === "fulfilled") {
          const fls = fl.value?.data?.klines || [];
          if (fls.length >= 2) { const y = fls[fls.length - 2].split(","); if (!rec.date) rec.date = y[0]; rec.netIn = Number(y[1]) || null; }
        }
      } catch (e) { /* 单板块失败降级为空, 不影响整体 */ }
      out.push(rec);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); // 并发 4, 控制 push2his 请求量
  return out;
}

/** 大盘量能客观评估: 两市总成交额(上证+深证) 今日 vs 昨日 → 放量/缩量客观信号 */
function calcVolumeSignal(indexToday, indexYesterday) {
  const pick = (list, kw) => (list || []).find((x) => String(x.name || "").includes(kw));
  const todayAmt = (pick(indexToday, "上证")?.amount || 0) + (pick(indexToday, "深证")?.amount || 0);
  const yestAmt = (pick(indexYesterday, "上证")?.amount || 0) + (pick(indexYesterday, "深证")?.amount || 0);
  if (!todayAmt || !yestAmt) return null;
  const diffPct = Math.round(((todayAmt - yestAmt) / yestAmt) * 1000) / 10;
  return {
    todayAmount: todayAmt,   // 元
    yesterdayAmount: yestAmt, // 元
    diffPct,                 // 今日较昨日量能变化 %
    level: diffPct >= 10 ? "明显放量" : diffPct >= 3 ? "温和放量" : diffPct <= -10 ? "明显缩量" : diffPct <= -3 ? "温和缩量" : "量能持平",
  };
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

/**
 * 解析单个大 skill 的 SKILL.md, 提取 front-matter 与各技能小节为可选技能。
 * 小节识别规则: 按 "## " 切分, 识别 "X、名称（标签）" 标题, 兼容 "名称 · 标签" 形式。
 */
function parseSkillFile(text, group) {
  // front-matter name/description
  let docDesc = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const d = fm[1].match(/description:\s*"(.+?)"/);
    if (d) docDesc = d[1];
  }
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
      description: tag || "交易思维",
      slug: `${group.slug}:${name}`,
      content: part.trim(),
      group: group.slug,
      groupName: group.name,
      isAll: false,
    });
  }
  // 提供"全览"选项(注入该大 skill 全文; 短线龙头沿用历史名称以兼容已保存配置)
  if (skills.length) {
    const allName = group.slug === "duanxian-longtou" ? "七大游资全览" : `${group.name}全览`;
    skills.unshift({
      name: allName,
      description: docDesc || `${group.name}交易思维合集`,
      slug: `${group.slug}:all`,
      content: text,
      group: group.slug,
      groupName: group.name,
      isAll: true,
    });
  }
  return skills;
}

/** 加载全部大 skill 的技能列表(跳过尚未创建目录/文件的 group) */
function loadSkills() {
  const out = [];
  for (const g of loadSkillGroups()) {
    const file = path.join(g.dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    try {
      out.push(...parseSkillFile(fs.readFileSync(file, "utf-8"), g));
    } catch (e) {
      console.error(`[philia] 解析技能 ${g.name}(${g.slug}) 失败:`, e.message);
    }
  }
  return out;
}

/**
 * 技能去重: 大 skill 的「全览」content 即该 SKILL.md 全文(含其全部小节),
 * 同时勾选「全览 + 单项」会导致全文与单项重复注入。按大 skill 维度去重:
 * 某大 skill 已选全览时丢弃该大 skill 的单项, 其他大 skill 的选择不受影响。
 */
function dedupeSkills(selected) {
  const allGroups = new Set(selected.filter((s) => s.isAll).map((s) => s.group));
  if (!allGroups.size) return selected;
  return selected.filter((s) => !allGroups.has(s.group) || s.isAll);
}

/* ---------------- 观点来源解析 ----------------
 * 将 LLM 输出的 skill/tactic 解析为各 SKILL.md 中的精确条目,
 * 使每条主观观点可追溯至「文件名 + 具体章节编号 + 模型/条目编号」。
 */

/** 遍历全部大 skill 的 SKILL.md, 建立「小节 → 模型条目」的章节索引 */
function buildSkillIndex() {
  const index = [];
  for (const g of loadSkillGroups()) {
    const file = path.join(g.dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    let part = ""; // 一级标题(第X部分 · 名称)
    for (const raw of lines) {
      const line = raw.trim();
      const h1 = /^# (.+)$/.exec(line);
      const h2 = /^## (.+)$/.exec(line);
      if (h1) { part = h1[1]; continue; }
      if (h2) {
        const head = h2[1];
        const no = /^[一二三四五六七八九十]+、/.exec(head)?.[0] || "";
        const nameBase = head.replace(no, "").split("·")[0].trim();
        index.push({ file: `${g.slug}/SKILL.md`, part, head, no, name: nameBase, models: [] });
        continue;
      }
      // 模型条目: **模型1：标题**
      if (index.length) {
        const m = /^\*\*模型(\d+)[:：](.+?)(?:\*\*|$)/.exec(line);
        if (m) index[index.length - 1].models.push({ no: m[1], title: m[2].trim() });
      }
    }
  }
  return index;
}

let _skillIndex = null;
function getSkillIndex() {
  if (!_skillIndex) _skillIndex = buildSkillIndex();
  return _skillIndex;
}

/** 解析技能引用 → 精确来源标注(含文件名 + 章节编号 + 模型编号) */
function resolveSkillSource(skill, tactic) {
  const s = String(skill || "").trim();
  const t = String(tactic || "").trim();
  if (!s && !t) return "";
  const idx = getSkillIndex();
  // 1) 用 skill 中的名字匹配小节
  let sec = null;
  for (const it of idx) {
    if (it.name && s.includes(it.name)) { sec = it; break; }
  }
  // 2) 用 tactic 中的编号匹配模型(如 "模型1" / "1")
  let model = null;
  if (sec) {
    const mn = /(?:模型)?(\d+)/.exec(t);
    if (mn) model = sec.models.find((mm) => String(mm.no) === mn[1]) || null;
  }
  const parts = [];
  if (sec) {
    parts.push(`${sec.file} · ${sec.part} ${sec.head}`);
    if (model) parts.push(`模型${model.no} ${model.title}`);
  }
  if (parts.length) return parts.join(" · ");
  // 回退: 仅给出原始引用(无法定位到具体大 skill 小节时)
  const tNo = t.replace(/^模型/, "");
  return [s, t ? `模型${tNo}` : ""].filter(Boolean).join(" · ");
}

/* ---------------- 客观数据过滤(龙头情绪复盘技能) ----------------
 * 仅从 luotou-qingxu-sipan/SKILL.md 中提取「客观数据方法论」:
 * 数据来源 URL、采集完整性要求、数据提取要点、来源标注规范。
 * 完全排除任何主观观点、情绪倾向、结论性/指导性研判等非事实性杂质内容。
 * 该内容在 Prompt 中作为「次要参考」注入, 优先级严格低于 youzi-qijie-jinghua。
 */
// 仅保留以下客观数据章节(以 `## ` 二级标题识别), 其余(分析维度/输出原则等主观研判)一律剔除
// 注: 「一·补3、昨日连板梯队复盘与今日实盘对照验证」为双日对照验证的标准流程(客观数据方法), 一并保留
const LUOTOU_KEEP_HEADERS = [
  "一、数据来源",
  "一·补、数据采集完整性要求",
  "一·补2、数据提取要点",
  "一·补3、昨日连板梯队复盘与今日实盘对照验证",
  "一·补4、大盘与板块因子",
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
  const yestCompact = yesterdayCompact(); // 上一交易日 YYYYMMDD(双日对照用)
  // 并行抓取网页数据源(含昨日涨停池用于双日对照; 大盘/板块因子含今日+昨日), 任一失败不影响整体(Promise.allSettled)
  const results = await Promise.allSettled([
    fetchTopicPool("ZTPool"),            // 今日涨停池
    fetchTopicPool("ZBPool"),            // 今日炸板池
    fetchTopicPool("DTPool"),            // 今日跌停池
    fetchBreadth(),                      // 全市场涨跌家数
    fetchTopicPool("ZTPool", yestCompact), // 昨日涨停池(双日对照验证数据源)
    fetchIndexToday(),                   // 大盘因子·今日(指数涨跌幅/量能)
    fetchIndexYesterday(),               // 大盘因子·昨日(指数涨跌幅/量能)
    fetchBoardToday(),                   // 板块因子·今日(行业/概念 涨跌幅+主力净额)
  ]);
  const zt = results[0].status === "fulfilled" ? results[0].value : null;
  const zb = results[1].status === "fulfilled" ? results[1].value : null;
  const dt = results[2].status === "fulfilled" ? results[2].value : null;
  const breadth = results[3].status === "fulfilled" ? results[3].value : null;
  const yestZt = results[4].status === "fulfilled" ? results[4].value : null;
  const indexToday = results[5].status === "fulfilled" ? results[5].value : null;
  const indexYesterday = results[6].status === "fulfilled" ? results[6].value : null;
  const boardToday = results[7].status === "fulfilled" ? results[7].value : null;
  // 昨日板块因子: 依赖今日板块TOP名单, 单独并行拉取(失败降级为空, 不影响整体)
  const boardYesterday = boardToday ? await fetchBoardYesterday(boardToday).catch((e) => { console.error("[philia] fetchBoardYesterday failed:", e?.message); return []; }) : null;
  // 大盘量能客观评估(两市总成交额 今日 vs 昨日): 作为个股判断的客观环境约束
  const volumeSignal = calcVolumeSignal(indexToday, indexYesterday);

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
  // 大盘因子(今日/昨日): 指数涨跌幅 + 量能
  tracer?.add({
    type: "resource", name: "大盘因子·今日(三大指数)", status: indexToday?.length ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 指数: indexToday?.map((x) => x.name).join("/") || "—" },
    summary: indexToday?.length
      ? indexToday.map((x) => `${x.name} ${x.pct}%`).join("；")
      : "获取失败(已降级, 不影响整体)",
  });
  tracer?.add({
    type: "resource", name: "大盘因子·昨日(三大指数)", status: indexYesterday?.length ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 日期: indexYesterday?.[0]?.date || "—" },
    summary: indexYesterday?.length
      ? indexYesterday.map((x) => `${x.name} ${x.pct}%`).join("；")
      : "获取失败(已降级, 不影响整体)",
  });
  // 板块因子(今日/昨日): 行业/概念 涨跌幅 + 主力净额
  const boardCnt = Object.values(boardToday || {}).reduce((a, l) => a + (l?.length || 0), 0);
  tracer?.add({
    type: "resource", name: "板块因子·今日(行业/概念)", status: boardCnt ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 行业: boardToday?.["行业"]?.length ?? 0, 概念: boardToday?.["概念"]?.length ?? 0 },
    summary: boardCnt ? `行业+概念 共 ${boardCnt} 个(涨跌幅TOP + 主力净额TOP)` : "获取失败",
  });
  tracer?.add({
    type: "resource", name: "板块因子·昨日(TOP板块)", status: boardYesterday?.length ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 板块数: boardYesterday?.length ?? 0 },
    summary: boardYesterday?.length
      ? `已拉取 ${boardYesterday.length} 个TOP板块的昨日涨跌幅/主力净额`
      : "无板块数据或获取失败(已降级)",
  });
  // 昨日涨停池(双日对照): 独立记录加载结果
  const yestPool = yestZt?.pool || null;
  const yesterdayLadder = yestPool ? yestLadderFromPool(yestPool, yestCompact) : null;
  const yesterdayMatch = yestPool ? matchYesterdayLadder(yestPool, zt?.pool, zb?.pool, dt?.pool) : null;
  // 「昨日涨停今表现」(%): 昨日涨停股今日平均涨跌幅; 失败回退今日仍涨停率口径(见 calcYestLimitUpPerformance)
  const yestLimitUpPerf = yestPool ? await calcYestLimitUpPerformance(yestPool, yesterdayMatch).catch(() => null) : null;
  tracer?.add({
    type: "resource", name: "昨日涨停今表现", status: yestLimitUpPerf != null ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 昨日涨停数: yestPool?.length ?? 0 },
    summary: yestLimitUpPerf != null ? `昨日涨停股今日平均${yestLimitUpPerf}%` : "东财行情获取失败(如实标注数据缺失)",
  });
  // 龙头低吸候选池: 昨日连板≥2 且 今日未涨停(断板/炸板/跌停)的个股, 供「龙头低吸」模块分析
  const lowAbsorbPool = yestPool ? buildLowAbsorbPool(yestPool, yesterdayMatch) : [];
  tracer?.add({
    type: "resource", name: "龙头低吸候选池(昨日梯队×今日未涨停)", status: yestPool ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { 候选数量: lowAbsorbPool.length, 筛选条件: "昨日连板≥2 且 今日未涨停" },
    summary: lowAbsorbPool.length
      ? `筛选出 ${lowAbsorbPool.length} 只龙头低吸候选(含 ${lowAbsorbPool.filter((x) => x.todayStatus === "炸板").length} 只今日炸板)`
      : "无满足条件候选(昨日数据缺失或全部涨停)",
  });
  tracer?.add({
    type: "resource", name: "东方财富·昨日涨停池(双日对照)", status: yestPool ? "ok" : "failed",
    startedAt: t0, durationMs: Date.now() - t0,
    params: { date: yestCompact, 池内数量: yestPool?.length ?? 0 },
    summary: yesterdayLadder
      ? `昨日最高${yesterdayLadder["最高连板"]}板, 昨日涨停${yestPool.length}家, 今日晋级${yesterdayMatch?.stats.晋级 ?? 0}只/断板${yesterdayMatch?.stats.断板 ?? 0}只`
      : "获取失败(双日对照数据缺失, 如实标注)",
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
    yesterday_limit_up_performance: yestLimitUpPerf, // 昨日涨停股今日平均涨跌幅(%)(原为 null 导致「数据缺失」)
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
  if (yestPool) sources.push({ name: `东方财富·昨日涨停池(${yestCompact})`, fetchedAt: fetchedMin });
  if (indexToday?.length) sources.push({ name: "东方财富·大盘指数(今日)", fetchedAt: fetchedMin });
  if (indexYesterday?.length) sources.push({ name: `东方财富·大盘指数(${indexYesterday[0].date})`, fetchedAt: fetchedMin });
  if (boardCnt) sources.push({ name: "东方财富·板块涨跌与主力资金(今日)", fetchedAt: fetchedMin });
  if (boardYesterday?.length) sources.push({ name: `东方财富·板块涨跌与主力资金(${boardYesterday.find((b) => b.date)?.date || "昨日"})`, fetchedAt: fetchedMin });

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

  // 全部标的名称→代码映射(供前端单击标的名跳转同花顺):
  // 覆盖涨停池/炸板池/跌停池/昨日涨停池/龙头低吸候选/龙头参考池/昨日梯队对照, 兼容 {code,name} 与 {c,n} 两种字段
  const nameToCode = {};
  const feedNameToCode = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) {
      const name = x?.name || x?.n;
      const code = x?.code || x?.c;
      if (name && code) nameToCode[name] = String(code);
    }
  };
  feedNameToCode(zt?.pool);
  feedNameToCode(zb?.pool);
  feedNameToCode(dt?.pool);
  feedNameToCode(yestPool);
  feedNameToCode(lowAbsorbPool);
  feedNameToCode(leaderPool?.pool);
  feedNameToCode(yesterdayMatch?.rows);

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
    yesterdayLadder,  // 昨日连板梯队(双日对照)
    yesterdayMatch,   // 昨日梯队个股今日实盘对照(双日对照)
    lowAbsorbPool,    // 龙头低吸候选池(昨日连板≥2 且 今日未涨停)
    indexToday,       // 大盘因子·今日(指数点位/涨跌幅/量能)
    indexYesterday,   // 大盘因子·昨日(指数收盘/涨跌幅/量能)
    boardToday,       // 板块因子·今日(行业/概念 涨跌幅+主力净额)
    boardYesterday,   // 板块因子·昨日(TOP板块 涨跌幅+主力净额)
    volumeSignal,     // 大盘量能客观评估(放量/缩量, 个股判断的环境约束)
    nameToCode,   // 全部标的名称→代码映射(供前端单击标的名跳转同花顺)
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
  // 大盘因子(今日/昨日): 指数涨跌幅 + 量能 —— 融入大盘环境研判
  const fmtYi = (v) => (v == null ? "—" : `${(v / 1e12).toFixed(2)}万亿`); // 成交额(元)
  const fmtYi2 = (v) => (v == null ? "—" : `${(v / 1e8).toFixed(1)}亿`);   // 主力净额(元)
  if (Array.isArray(ctx.indexToday) && ctx.indexToday.length) {
    lines.push(`[大盘因子·今日] ` + ctx.indexToday.map((x) => `${x.name} ${x.point}点 涨跌幅${x.pct}% 涨跌${x.change} 成交额${fmtYi(x.amount)}`).join("；"));
  } else {
    lines.push(`[大盘因子·今日] 数据缺失, 请如实标注。`);
  }
  if (Array.isArray(ctx.indexYesterday) && ctx.indexYesterday.length) {
    lines.push(`[大盘因子·昨日(${ctx.indexYesterday[0].date})] ` + ctx.indexYesterday.map((x) => `${x.name} 收${x.close} 涨跌幅${x.pct}% 涨跌${x.change} 成交额${fmtYi(x.amount)}`).join("；"));
  } else {
    lines.push(`[大盘因子·昨日] 数据缺失(历史接口不可用), 请如实标注。`);
  }
  // 大盘量能客观评估: 两市总成交额今日 vs 昨日 → 放量/缩量(作为个股/机会判断的客观环境约束)
  if (ctx.volumeSignal) {
    const v = ctx.volumeSignal;
    lines.push(`[大盘量能评估] 两市总成交 ${fmtYi(v.todayAmount)}(今日) vs ${fmtYi(v.yesterdayAmount)}(昨日) → ${v.level}(${v.diffPct >= 0 ? "+" : ""}${v.diffPct}%)`);
  } else {
    lines.push(`[大盘量能评估] 量能数据缺失(历史接口不可用), 请如实标注。`);
  }
  // 板块因子(今日/昨日): 行业/概念 涨跌幅 + 主力净额 —— 融入板块资金合力研判
  if (ctx.boardToday) {
    for (const [type, list] of Object.entries(ctx.boardToday)) {
      if (!Array.isArray(list) || !list.length) continue;
      lines.push(`[${type}板块·今日涨幅TOP] ` + list.slice(0, BOARD_PICK_N).map((b) => `${b.name} ${b.pct}% 主力${fmtYi2(b.netIn)} 换手${b.turnover}%`).join("；"));
    }
  }
  if (Array.isArray(ctx.boardYesterday) && ctx.boardYesterday.length) {
    const date = ctx.boardYesterday.find((b) => b.date)?.date || "昨日";
    lines.push(`[板块因子·昨日(${date}) 今日TOP板块对照] ` + ctx.boardYesterday.slice(0, BOARD_YEST_MAX).map((b) => `${b.name}(${b.type}) 昨日涨跌幅${b.pct ?? "—"}% 昨日主力${fmtYi2(b.netIn)}`).join("；"));
  } else if (ctx.boardToday) {
    lines.push(`[板块因子·昨日] 历史数据缺失(接口不可用), 仅提供今日板块数据, 请如实标注。`);
  }
  // 昨日连板梯队 + 今日实盘对照(双日对照验证): 供 LLM 验证昨日结论在今日市场的应对状况
  if (ctx.yesterdayLadder) {
    const y = ctx.yesterdayLadder;
    lines.push(`[昨日连板梯队(${y.date})] 一板:${y.firstBoard} 二板:${y.secondBoard} 三板:${y.thirdBoard} 高度板:${y.highBoard} 最高连板:${y["最高连板"]}板 连板率:${y.ladderRate}% ${y.comment}`);
    const topStocks = y.stocks.slice(0, 12);
    if (topStocks.length) {
      lines.push(`[昨日梯队个股TOP] ` + topStocks.map((s) => `${s.name}(${emSymbol(s.code)}) ${s.ladder}板 行业:${s.board || "—"}`).join("；"));
    }
  } else {
    lines.push(`[昨日连板梯队] 昨日涨停池数据缺失, 无法进行双日对照, 请如实标注并跳过对照验证。`);
  }
  if (ctx.yesterdayMatch) {
    const m = ctx.yesterdayMatch;
    lines.push(`[昨日梯队今日表现] 晋级:${m.stats.晋级} 维持:${m.stats.维持} 断板:${m.stats.断板} 炸板:${m.stats.炸板} 跌停:${m.stats.跌停} (共${m.rows.length}只昨日涨停股)`);
    const promo = m.rows.filter((r) => r.status === "晋级").slice(0, 10);
    if (promo.length) lines.push(`[昨日梯队今日晋级名单] ` + promo.map((r) => `${r.name}(${r.code}) ${r.yLadder}板→${r.todayLadder}板`).join("；"));
    const broke = m.rows.filter((r) => r.status === "断板" || r.status === "跌停").slice(0, 10);
    if (broke.length) lines.push(`[昨日梯队今日断板/跌停名单] ` + broke.map((r) => `${r.name}(${r.code}) 昨${r.yLadder}板→${r.status}`).join("；"));
  }
  // 龙头低吸候选池: 昨日连板≥2 且 今日未涨停(断板/炸板/跌停), 供「龙头低吸」模块综合分析
  if (Array.isArray(ctx.lowAbsorbPool) && ctx.lowAbsorbPool.length) {
    const pool = ctx.lowAbsorbPool.slice(0, 12);
    lines.push(`[龙头低吸候选池] 筛选条件=昨日连板≥2 且 今日未涨停(断板/炸板/跌停); 共${ctx.lowAbsorbPool.length}只候选`);
    lines.push(`[龙头低吸候选TOP] ` + pool.map((x) => `${x.name}(${x.code}) 昨${x.yLadder}板 今日${x.todayStatus}${x.todayLadder ? `(${x.todayLadder}板)` : ""} 板块:${x.board || "—"} 昨封单:${x.yestSeal || "—"}`).join("；"));
    lines.push(`提示: 龙头低吸(leaderLowAbsorb)的候选标的必须严格从上述「龙头低吸候选池」中挑选, 不得包含今日仍涨停(晋级/维持)的个股。`);
  } else {
    lines.push(`[龙头低吸候选池] 无满足「昨日连板≥2 且 今日未涨停」的候选, 请如实标注并跳过龙头低吸分析。`);
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
- **必须将「大盘因子」与「板块因子」纳入研判依据**: 结合大盘因子(今日/昨日指数涨跌幅、成交额量能对比)判断大盘强弱与放量/缩量; 结合板块因子(行业/概念 今日/昨日涨跌幅与主力净额)判断主线资金持续性(持续流入=主线确立 / 由负转正=资金回流 / 连续流出=退潮), 并在机会/风险/核心标的的分析文本中体现依据。
- **大盘量能作为个股判断的客观环境约束**: 结合「大盘量能评估」(放量/缩量) 校准对个股与机会的判断口径——放量环境资金充裕、龙头溢价更充分、可适度关注板块内中位补涨; 缩量环境资金抱团、仅聚焦最强龙头与核心标的、严控扩散度; 判断的客观基准: 个股/机会依据须以客观数据(板块资金、连板、封单、量能环境)为准, 该量能口径仅作内部约束参与判断, 输出文本无需刻意提及量能数字。
- opportunities 至少 3 个, risks 至少 3 个, stocks 3-5 只。
- 每个机会/风险/股票必须带 weight(0-1), 且所有 weight 之和应接近 1(归一化)。
- 只依据给定数据与游资思维推断, 不编造具体价格/数据; 目标价为区间估计, 需说明依据逻辑。
- 当前仅作研究参考, 不含任何投资建议免责条款。`;
  let user = `以下是当前市场数据白皮书(重点注意「大盘因子·今日/昨日」与「板块因子·今日/昨日」的对比数据, 作为大盘环境与板块资金合力研判依据):\n${contextToText(ctx)}`;
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
  // DeepSeek V4 为推理模型: 默认先写 reasoning_content 再写 content, 且 max_tokens 是「思考+正文」共享预算。
  // 本场景只需结构化 JSON, 关掉思考让 content 直接输出, 避免思考耗尽预算导致 content 为空, 同时省 ~94% 输出 token。
  const isDeepSeekV4 = !or && /v4/i.test(model);
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
      ...(isDeepSeekV4 ? { thinking: { type: "disabled" } } : {}),
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
  if (!content) {
    // 附上 finish_reason 与 usage, 便于定位是「思考耗尽预算(length)」还是其他问题
    const fr = j?.choices?.[0]?.finish_reason;
    const cmp = j?.usage?.completion_tokens;
    const rs = j?.usage?.completion_tokens_details?.reasoning_tokens;
    throw Object.assign(new Error(`LLM 未返回内容 (finish_reason=${fr}, completion_tokens=${cmp}, reasoning_tokens=${rs})`), { status: 502 });
  }
  try {
    return parseJsonStrict(content);
  } catch {
    // 容错: 剥离 markdown 围栏/前后缀/截断尾巴, 重试一次
    const repaired = repairJson(content);
    if (repaired !== null) return repaired;
    throw Object.assign(new Error("LLM 返回非合法 JSON"), { status: 502 });
  }
}

/** 严格解析 LLM 返回的 JSON */
function parseJsonStrict(content) {
  return JSON.parse(content);
}

/** 尽力修复 LLM 返回的 JSON: 去围栏/取首个对象范围/截断补齐缺失的收尾 } */
function repairJson(content) {
  const s = String(content).trim();
  const tries = [];
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) tries.push(fenced[1]);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(s.slice(start, end + 1));
  tries.push(s);
  for (let t of tries) {
    t = t.trim();
    if (!t) continue;
    for (const attempt of [t, `${t}}`, `${t}]}`]) {
      try { return JSON.parse(attempt); } catch { /* 继续尝试 */ }
    }
  }
  return null;
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
  const selected = dedupeSkills(skillList.filter((s) => sorted.includes(s.name)));
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

/* ---------------- 龙头情绪复盘(5 模块) ---------------- */

/** 5 模块复盘 prompt: 今日龙头核心 / 今日情绪周期 / 今日机会 / 今日风险 / 昨日连板梯队·今日实盘对照验证 */
function buildMarketPrompt(ctx, skills) {
  const sys = `
你是一位深耕A股超短线的资深市场分析师, 擅长以游资视角做「龙头 + 情绪周期」结构化复盘。
请基于给定的市场数据, 输出严格合法的 JSON(不要任何多余文字/注释/代码块标记), 结构如下:
{
  "leaderCore": {
    "title": "今日总龙头一句话概括",
    "summary": "龙头梯队结构、市场共识与带动性的详细分析",
    "leaders": [ { "name": "公司名", "code": "带交易所前缀如sh600519", "board": "所属板块", "ladder": 连板高度数字, "seal": "封单/强度描述", "note": "定位点评", "skill": "参考思路名称(如 炒股养家·赚钱效应)", "tactic": "对应战法编号(如 模型1)", "position": 建议仓位(仅限四档之一: 小/中/大/满) } ]
  },
  "leaderLowAbsorb": {
    "title": "龙头低吸一句话概括(候选池总览与今日低吸机会总判断)",
    "summary": "低吸逻辑总述: 候选个股共性、分歧转一致机会、风险总提示",
    "leaders": [ { "name": "公司名", "code": "带交易所前缀如sh600519", "board": "所属板块", "ladder": 昨日连板高度数字, "seal": "今日状态与昨日封单描述(如 今日断板·昨封4.82亿)", "note": "低吸点评(辩证分析投资机会与潜在风险)", "skill": "参考思路名称(如 炒股养家·买入分歧)", "tactic": "对应战法编号(如 模型4)", "position": 建议仓位(仅限四档之一: 小/中/大/满) } ]
  },
  "sentimentCycle": { "stage": "冰点/回暖/高潮/退潮阶段", "indicators": "涨停家数/连板/炸板率等关键情绪指标", "analysis": "情绪周期阶段研判", "suggestion": "整体操作建议(如 谨慎乐观建议控制仓位/市场情绪低迷建议观望为主)" },
  "opportunities": [ { "type": "机会类型", "sector": "板块/题材", "targets": ["涉及的具体标的名, 如 翔鹭钨业"], "analysis": "机会逻辑", "opportunity": "可操作机会点", "skill": "参考思路名称", "tactic": "对应战法编号", "position": 建议仓位(仅限四档之一: 小/中/大/满) } ],
  "risks": [ { "level": "高/中/低", "scope": "全市场/板块/个股", "targets": ["涉及的具体标的名"], "description": "风险描述", "mitigation": "应对建议", "skill": "参考思路名称", "tactic": "对应战法编号" } ],
  "marketValidation": {
    "yesterdaySummary": "昨日连板梯队复盘摘要(昨日涨停/连板家数、最高高度、总龙头与分支龙头, 必须标注日期与数据来源)",
    "todayPerformance": "昨日梯队个股今日实盘表现(晋级/维持/断板/炸板/跌停概况, 总龙头今日命运)",
    "comparison": "双日对照(今日最高板高度较昨日打开或压制、新老梯队交替、主线延续或切换)",
    "conclusionCheck": [ { "conclusion": "昨日结论项(如 判定的龙头/情绪周期阶段/机会方向/风险信号)", "verification": "今日实盘验证情况", "result": "命中/偏差/失准", "reason": "偏差或失准的原因说明" } ]
  }
}
要求:
- **必须将「大盘因子」与「板块因子」纳入研判依据**: 结合大盘因子(今日/昨日指数涨跌幅、成交额量能对比)判断大盘强弱与放量/缩量; 结合板块因子(行业/概念 今日/昨日涨跌幅与主力净额)判断主线资金持续性(持续流入=主线确立 / 由负转正=资金回流 / 连续流出=退潮), 并在各模块分析文本中体现依据。
- **大盘量能作为个股判断的客观环境约束**: 结合「大盘量能评估」(放量/缩量) 校准对个股与机会的判断口径——放量环境资金充裕、龙头溢价更充分、可适度关注板块内中位补涨; 缩量环境资金抱团、仅聚焦最强龙头与核心标的、严控扩散度; 判断的客观基准: 个股/机会依据须以客观数据(板块资金、连板、封单、量能环境)为准, 该量能口径仅作内部约束参与判断, 输出文本无需刻意提及量能数字。
- leaderCore.leaders 3-5 只(今日龙头核心), ladder 为数字。
- leaderLowAbsorb(龙头低吸) 为「今日龙头核心」的右侧并列模块, 输出格式与 leaderCore 完全一致:
  * 候选标的必须严格从数据白皮书「龙头低吸候选池」中挑选, 数量 3-5 只。
  * 筛选条件已在候选池中保证: 昨日连板≥2(表现亮眼/龙头梯队成员) 且 今日未处于涨停状态(断板/炸板/跌停)。
  * 严禁把今日仍涨停(晋级/维持)的个股放入龙头低吸; 若候选池数据缺失或无候选, 如实标注「无满足条件的龙头低吸候选」。
  * note 必须辩证分析: 左侧写投资机会(分歧转一致/弱转强/资金承接), 右侧写潜在风险(高位见顶/断板闷杀/题材退潮), 二者缺一不可。
  * position 依据低吸时机与情绪阶段给出四档分类之一「小/中/大/满」(参考: 冰点/退潮→小或空仓、回暖→中、分歧转一致确认→大、高潮一致后→小), 切实把握/无把握时输出「小」。
  * ladder 填昨日连板高度; seal 描述今日状态与昨日封单(如「今日断板 · 昨封4.82亿」)。
  * skill/tactic 必须引用下方「游资交易思维」中的低吸/分歧相关思路(如 炒股养家·买入分歧、退学炒股·弱转强、陈小群·预期差)。
- opportunities 至少 3 个, risks 至少 3 个。
- 每个 opportunity / risk 的 targets 必须列出该条涉及的全部具体标的名(股票公司名, 不含代码), 与 description/analysis 中提到的标的一一对应。
- sentimentCycle.stage 必须明确给出情绪周期阶段。
- skill 必须引用下方「游资交易思维」中的具体思路名称, tactic 给出该思路下对应战法编号。
- position 必须严格输出四档分类之一「小/中/大/满」(不得输出数字或百分比), 依据下方技能中的仓位规则并结合当前情绪阶段给出(参考: 冰点→小、回暖→大、高潮→中、退潮→小), 切实把握/无把握时输出「小」。
- sentimentCycle.suggestion 必须严格采用该技能的语气风格, 基于当前情绪阶段给出明确操作方向指引。
- marketValidation 必须基于数据白皮书中的「昨日连板梯队」「昨日梯队今日表现」字段, 逐一核验昨日结论在今日实盘中的应对状况:
  * yesterdaySummary 必须标注昨日日期(如 2026-08-06)。
  * todayPerformance 逐项描述晋级/维持/断板/炸板/跌停数量与代表个股, 特别说明昨日总龙头今日命运。
  * comparison 说明今日最高板高度较昨日是打开还是压制、今日梯队中哪些为昨日延续标的、哪些为新晋标的、主线是延续还是切换。
  * conclusionCheck 至少 3 条, result 必须严格取「命中/偏差/失准」之一; 命中说明验证充分, 偏差/失准须给出 reason 说明原因(如情绪切换、资金分歧、题材退潮)。
  * 若白皮书中昨日连板梯队数据缺失, 如实标注「昨日数据缺失, 无法进行对照验证」, 不得编造。
- 只依据给定数据与游资思维推断, 不编造具体价格/数据。
- 当前仅作研究参考, 不构成投资建议。`;
  let user = `以下是当前市场数据白皮书(重点注意「大盘因子·今日/昨日」与「板块因子·今日/昨日」的对比数据, 作为大盘环境与板块资金合力研判依据):\n${contextToText(ctx)}`;
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

/** 5 模块结果校验与规范化(容错) */
function normalizeMarketResult(raw, nameToCode) {
  const num = (v, lo = 0, hi = 999) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
  };
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  // 仓位建议标准化: 固定四级分类「小/中/大/满」, 消除随机性波动。
  // 兼容历史数字/百分数(按分档映射), 最终统一为四档之一。
  const pos = (v) => {
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
  };
  const lc = raw?.leaderCore || {};
  const leaderCore = {
    title: str(lc.title),
    summary: str(lc.summary),
    leaders: (Array.isArray(lc.leaders) ? lc.leaders : []).slice(0, 6).map((x) => ({
      name: str(x.name),
      code: str(x.code),
      board: str(x.board),
      ladder: num(x.ladder, 0, 99),
      seal: str(x.seal),
      note: str(x.note),
      skill: str(x.skill),
      tactic: str(x.tactic),
      position: pos(x.position),
      sourceRef: resolveSkillSource(str(x.skill), str(x.tactic)),
    })),
  };
  // 龙头低吸(今日龙头核心右侧并列模块): 与 leaderCore 结构完全一致
  const la = raw?.leaderLowAbsorb || {};
  const leaderLowAbsorb = {
    title: str(la.title),
    summary: str(la.summary),
    leaders: (Array.isArray(la.leaders) ? la.leaders : []).slice(0, 6).map((x) => ({
      name: str(x.name),
      code: str(x.code),
      board: str(x.board),
      ladder: num(x.ladder, 0, 99),
      seal: str(x.seal),
      note: str(x.note),
      skill: str(x.skill),
      tactic: str(x.tactic),
      position: pos(x.position),
      sourceRef: resolveSkillSource(str(x.skill), str(x.tactic)),
    })),
  };
  const sc = raw?.sentimentCycle || {};
  const sentimentCycle = {
    stage: str(sc.stage) || "未知",
    indicators: str(sc.indicators),
    analysis: str(sc.analysis),
    suggestion: str(sc.suggestion),
  };
  const opportunities = (Array.isArray(raw?.opportunities) ? raw.opportunities : []).slice(0, 6)
    .map((o) => ({
      type: str(o.type) || "题材",
      sector: str(o.sector),
      targets: arr(o.targets),
      analysis: str(o.analysis),
      opportunity: str(o.opportunity),
      skill: str(o.skill),
      tactic: str(o.tactic),
      position: pos(o.position),
      sourceRef: resolveSkillSource(str(o.skill), str(o.tactic)),
    }));
  const risks = (Array.isArray(raw?.risks) ? raw.risks : []).slice(0, 6)
    .map((r) => ({
      level: ["高", "中", "低"].includes(r.level) ? r.level : "中",
      scope: str(r.scope),
      targets: arr(r.targets),
      description: str(r.description),
      mitigation: str(r.mitigation),
      skill: str(r.skill),
      tactic: str(r.tactic),
      sourceRef: resolveSkillSource(str(r.skill), str(r.tactic)),
    }));
  // 汇总全部标的名称(龙头 + 龙头低吸 + 机会 + 风险), 供前端蓝色高亮标注
  const targets = [...new Set(
    [...(Array.isArray(lc.leaders) ? lc.leaders : []).map((x) => str(x.name)),
     ...(Array.isArray(la.leaders) ? la.leaders : []).map((x) => str(x.name)),
     ...opportunities.flatMap((o) => o.targets),
     ...risks.flatMap((r) => r.targets)].filter(Boolean)
  )];
  // 第 5 模块: 昨日连板梯队 · 今日实盘对照验证(双日对照)
  const mv = raw?.marketValidation || {};
  const marketValidation = {
    yesterdaySummary: str(mv.yesterdaySummary),
    todayPerformance: str(mv.todayPerformance),
    comparison: str(mv.comparison),
    conclusionCheck: (Array.isArray(mv.conclusionCheck) ? mv.conclusionCheck : []).slice(0, 8).map((c) => ({
      conclusion: str(c.conclusion),
      verification: str(c.verification),
      result: ["命中", "偏差", "失准"].includes(c.result) ? c.result : str(c.result) || "—",
      reason: str(c.reason),
    })),
  };
  // 标的名称→代码映射(供前端单击标的名跳转同花顺): 优先 leaders 自带代码, 其余以数据源映射补齐
  const targetCodes = {};
  for (const l of [...(Array.isArray(lc.leaders) ? lc.leaders : []), ...(Array.isArray(la.leaders) ? la.leaders : [])]) {
    const n = str(l.name), c = str(l.code);
    if (n && c) targetCodes[n] = c;
  }
  for (const name of targets) {
    if (!targetCodes[name] && nameToCode && nameToCode[name]) targetCodes[name] = String(nameToCode[name]);
  }
  return { leaderCore, leaderLowAbsorb, sentimentCycle, opportunities, risks, marketValidation, targets, targetCodes };
}

/** 龙头情绪复盘(5 模块): 复用 LLM 管线与降频缓存 */
async function analyzeMarket({ model, skills = [], force = false }) {
  const tracer = createTracer();
  const tStart = Date.now();
  tracer.add({ type: "agent", name: "启动龙头情绪复盘", status: "ok", startedAt: tStart, durationMs: 0, params: { force: !!force, 模块数: 5 }, summary: "今日龙头核心 / 情绪周期 / 机会 / 风险 / 昨日梯队双日对照" });
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
    .update(`market5-lowabs|${date}|${model}|${sorted.join(",")}`)
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
  const selected = dedupeSkills(skillList.filter((s) => sorted.includes(s.name)));
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
  const result = normalizeMarketResult(raw, ctx.nameToCode);
  result.sources = (ctx.sources || []).map((s) => ({ name: s.name, fetchedAt: s.fetchedAt }));
  tracer.add({ type: "tool", name: "结果规范化", status: "ok", startedAt: Date.now(), durationMs: 0, params: {}, summary: "5 模块结果校验与字段规范化(含双日对照验证)" });

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