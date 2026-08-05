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
const { encrypt, decrypt, maskKey } = require("./philia-keystore.cjs");
const {
  getAiKey, upsertAiKey, getAiAnalysis, upsertAiAnalysis, listAiAnalyses,
  getTrends, getLadderTrend,
} = require("./stock-db.cjs");

/* ---------------- 常量 ---------------- */
const ROOT = path.join(__dirname, "..");
const SKILL_DIR = path.join(ROOT, "youzi-qijie-jinghua");
const OR_BASE = "https://openrouter.ai/api/v1";
const DS_BASE = "https://api.deepseek.com";

/** 依据 key 前缀识别 provider: sk-or- 为 OpenRouter, 其余 sk- 视为 DeepSeek */
const isOpenRouterKey = (key) => typeof key === "string" && key.startsWith("sk-or-");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MODEL_CACHE_TTL = 30 * 60 * 1000; // 模型列表缓存 30min
const CONTEXT_CACHE_TTL = 5 * 60 * 1000; // 数据白皮书缓存 5min
const ANALYSIS_CACHE_TTL = 30 * 60 * 1000; // 分析结果降频缓存 30min
const MAX_PROMPT_SKILL_CHARS = 8000; // 注入技能提示词上限(控制 token 成本)

/** 兜底模型列表(OpenRouter 接口失败/未配置时使用) */
const DEFAULT_MODELS = [
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash（正式版）", default: true, isDeepSeekV4: true },
  { id: "deepseek/deepseek-chat", name: "DeepSeek V3", default: false },
  { id: "openai/gpt-4o", name: "OpenAI GPT-4o", default: false },
  { id: "anthropic/claude-3.5-sonnet", name: "Anthropic Claude Sonnet", default: false },
];

/** 允许的模型白名单(防模型 id 注入导致成本/安全风险) */
const MODEL_WHITELIST = new Set(DEFAULT_MODELS.map((m) => m.id));

/* ---------------- 开盘啦 KPL 客户端(与 index.cjs 同构) ---------------- */
const KPL_BASE = process.env.KPL_BASE || "https://kpl.liuhepc.cn";
const KPL_API_KEY = process.env.KPL_API_KEY || "kpl-4ed522163bf8dad3aeb1d9613791661eb62ed88ed6e82067";

async function kplFetch(p, params = {}, timeout = 10000) {
  const url = new URL(p, KPL_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  try {
    const resp = await fetch(url.toString(), {
      headers: { "X-API-Key": KPL_API_KEY, "User-Agent": UA },
      signal: AbortSignal.timeout(timeout),
    });
    return await resp.json();
  } catch (e) {
    console.error("[philia] kplFetch", p, "failed:", e.message);
    return null;
  }
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
/** 各 KPL 数据源名称(与 Promise.allSettled 结果下标对齐) */
const SRC_NAMES = ["KPL 市场情绪", "KPL 涨跌停统计", "KPL 涨停/跌停", "KPL 炸板", "KPL 热门题材", "KPL 游资动向"];
async function assembleContext() {
  if (contextCache.data && Date.now() - contextCache.ts < CONTEXT_CACHE_TTL) return contextCache.data;
  const today = dashToday();
  const results = await Promise.allSettled([
    kplFetch("/api/market/mood", {}, 8000),
    kplFetch("/api/market/rise-fall", { date: today }, 12000),
    kplFetch("/api/market/limit-up-down", { date: today }, 12000),
    kplFetch("/api/ladder/broken", { date: today }, 12000),
    kplFetch("/api/theme/hot", {}, 8000),
    kplFetch("/api/lhb/youzi-dongxiang", { date: today }, 12000),
  ]);
  const mood = results[0].status === "fulfilled" ? results[0].value : null;
  const riseFall = results[1].status === "fulfilled" ? results[1].value : null;
  const limitUpDown = results[2].status === "fulfilled" ? results[2].value : null;
  const broken = results[3].status === "fulfilled" ? results[3].value : null;
  const themeHot = results[4].status === "fulfilled" ? results[4].value : null;
  const youzi = results[5].status === "fulfilled" ? results[5].value : null;
  const trends = getTrends().slice(-30);       // 近 30 日情绪趋势
  const ladder = getLadderTrend().slice(-10);  // 近 10 日连板梯队

  // 记录各数据源名称与获取时间(分钟级, 供前端追溯时效性)
  const fetchedMin = fmtMin(Date.now());
  const sources = [];
  SRC_NAMES.forEach((name, i) => {
    if (results[i]?.status === "fulfilled" && results[i].value != null) {
      sources.push({ name, fetchedAt: fetchedMin });
    }
  });
  if (trends.length) sources.push({ name: "本地情绪趋势", fetchedAt: fetchedMin });
  if (ladder.length) sources.push({ name: "本地连板梯队", fetchedAt: fetchedMin });

  // 核心标的参考池(市场实时热点 → 龙头股): 由 index.cjs 注入的 getter 获取, 失败不影响整体分析
  let leaderPool = null;
  if (typeof leaderPoolGetter === "function") {
    try { leaderPool = await leaderPoolGetter(); } catch (e) { console.error("[philia] leaderPool get failed:", e?.message || e); }
  }
  if (leaderPool && leaderPool.pool && leaderPool.pool.length) {
    sources.push({ name: "龙头股参考池(市场热点)", fetchedAt: fmtMin(leaderPool.updatedAt || Date.now()) });
  }

  const ctx = {
    date: today,
    mood: mood || null,
    riseFall: riseFall || null,
    limitUpDown: limitUpDown || null,
    broken: broken || null,
    themeHot: themeHot || null,
    youzi: (youzi && Array.isArray(youzi.data) ? youzi.data : youzi) || null,
    trends,       // 近 30 日情绪趋势
    ladder,       // 近 10 日连板梯队
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
  if (ctx.ladder && ctx.ladder.length) {
    const last = ctx.ladder[ctx.ladder.length - 1];
    lines.push(`[连板梯队] 一板:${last.firstBoard} 二板:${last.secondBoard} 三板:${last.thirdBoard} 高度板:${last.highBoard} 连板率:${last.ladderRate}% 破板率:${last.blownRate}% 评价:${last.comment || "—"}`);
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
      return { ...hit, fromCache: true, cacheKey };
    }
  }

  // 组数据白皮书 + 技能内容 + 调 LLM
  const ctx = await assembleContext();
  const skillList = loadSkills();
  const selected = skillList.filter((s) => sorted.includes(s.name));
  const prompt = buildPrompt(ctx, selected);
  const raw = await callLLM(apiKey, model, prompt);
  const result = normalizeResult(raw);
  // 记录 AI 生成内容所参考的数据源(名称 + 获取时间, 分钟级), 随结果一并持久化
  result.sources = (ctx.sources || []).map((s) => ({ name: s.name, fetchedAt: s.fetchedAt }));

  upsertAiAnalysis({ cacheKey, date, model, skillsHash: sorted.join(","), result });
  return { cacheKey, date, model, skillsHash: sorted.join(","), result, createdAt: Date.now(), updatedAt: Date.now(), fromCache: false };
}

/** 历史分析记录 */
function history(limit = 20) {
  return listAiAnalyses(limit).map((a) => ({ ...a, fromCache: false }));
}

module.exports = {
  loadSkills,
  listModels,
  validateKey,
  getConfig,
  saveConfig,
  analyze,
  history,
  setLeaderPoolGetter,
  DEFAULT_MODELS,
};