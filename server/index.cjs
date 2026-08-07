/**
 * 市场研究驾驶舱 — 数据代理与静态服务器
 * 聚合: 腾讯行情(A股/港股/美股/汇率) · 腾讯板块榜 · 新浪期货(金银铜油)
 *       新浪个股榜单 · 新浪资金流 · 新浪7x24快讯 · CNBC美债收益率
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");
const { execFile } = require("child_process");
const crypto = require("crypto");
const dns = require("dns");
// push2his.eastmoney.com 对本机 IPv6 连接不稳定, 强制优先 IPv4 以保证历史K线等网页数据源稳定抓取
dns.setDefaultResultOrder("ipv4first");
const { getStock, getStockBoards, upsertStock, upsertStockBoards, stockCount, allStockCodes, getMeta, setMeta, deleteMeta, saveMsOffline, loadMsOffline, clearMsOffline, upsertTrends, getTrends, trendCount, upsertLadderTrends, getLadderTrend, getDbMetrics, DB_PATH } = require("./stock-db.cjs");
const philia = require("./philia-ai.cjs");

// 加载 .env
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.trim().match(/^export\s+(.+?)=(.*)$/) || line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    console.log("[env] loaded", envPath);
  }
} catch (e) { console.error("[env] load error:", e.message); }

function curlText(url, { referer, timeout = 8000, encoding = "gbk" } = {}) {
  return new Promise((resolve, reject) => {
    // -sS: 静默进度但保留错误信息到 stderr, 失败原因可诊断(28=超时, 35=TLS握手, 6=DNS...)
    const args = ["-sS", "--max-time", String(Math.ceil(timeout / 1000)), "-H", `User-Agent: ${UA}`];
    if (referer) args.push("-H", `Referer: ${referer}`);
    args.push(url);
    execFile("curl", args, { maxBuffer: 4 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr && stderr.length ? String(stderr).trim().slice(0, 200) : err.message;
        return reject(new Error(`curl(${err.code ?? "?"}) ${url} -> ${detail}`));
      }
      resolve(iconv.decode(stdout, encoding));
    });
  });
}

const PORT = process.env.PORT || 3000;
const DIST = path.join(__dirname, "..", "dist");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* ---------------- 基础工具 ---------------- */
async function fetchText(url, { referer, gbk = false, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (referer) headers["Referer"] = referer;
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    const buf = Buffer.from(await resp.arrayBuffer());
    return gbk ? iconv.decode(buf, "gbk") : buf.toString("utf-8");
  } finally {
    clearTimeout(timer);
  }
}

/* node fetch 被拦/失败时回退 curl(与 emGet / fetchSinaJson 同模式);
   适用于对 TLS 指纹敏感、对 node fetch 间歇性断连的上游(CNBC 等) */
async function fetchTextAny(url, { referer, gbk = false, timeout = 8000 } = {}) {
  try {
    return await fetchText(url, { referer, gbk, timeout });
  } catch {
    return curlText(url, { referer, timeout, encoding: gbk ? "gbk" : "utf-8" });
  }
}

/* ---------------- 开盘啦 API 客户端 (kpl.liuhepc.cn) ----------------
 * 注: 该数据源 API Key 已失效(401), 各业务已陆续切换至 东方财富网页 / 腾讯 / 同花顺THS网关。
 *     保留 kplFetch 仅为兼容遗留路径, 失效时返回 null, 由各业务的新数据源接管。 */
const KPL_BASE = "https://kpl.liuhepc.cn";
const KPL_API_KEY = process.env.KPL_API_KEY || "kpl-4ed522163bf8dad3aeb1d9613791661eb62ed88ed6e82067";

async function kplFetch(path, params = {}, timeout = 8000) {
  const url = new URL(path, KPL_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  try {
    const resp = await fetch(url.toString(), {
      headers: { "X-API-Key": KPL_API_KEY, "User-Agent": UA },
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return null; // 401 Key 失效等: 直接降级, 交由新数据源接管
    return await resp.json();
  } catch (e) {
    console.error(`[kplFetch] ${path} fetch failed, fallback curl:`, e.message);
    try {
      const text = await curlText(url.toString(), {
        referer: "https://kpl.liuhepc.cn/",
        timeout,
        encoding: "utf-8",
      });
      return JSON.parse(text);
    } catch (e2) {
      console.error(`[kplFetch] ${path} curl fallback failed:`, e2.message);
      return null;
    }
  }
}

/* ---------------- 同花顺 THS 数据网关客户端(替代 KPL 底层行情部分) ----------------
 * 网关: server/ths-gateway.py(同花顺 thsdk 封装, 提供实时行情/分时/板块列表/成分股/资讯)。
 * A股代码映射: 沪(6/9)→USHA, 深(0/2/3)→USZA, 北交所(4/8)→USTM。 */
const THS_GATEWAY = process.env.THS_GATEWAY || "http://127.0.0.1:9877";

async function thsFetch(path, params = {}, timeout = 8000) {
  const url = new URL(path, THS_GATEWAY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  try {
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(timeout) });
    return await resp.json();
  } catch (e) {
    return { success: false, error: e?.message || "ths gateway unavailable", data: null, extra: {} };
  }
}

/* ---------------- THS 网关调用治理层 ----------------
 * 串行队列(上限 20) + 指数退避重试 + 429(rateLimited)感知:
 *  - 网关侧令牌桶超限返回 429 + extra.rateLimited=true, 此处按 0.3/0.6/1.2s 退避
 *  - 队列满直接返回失败(503 语义), 由上层回退到备用数据源, 不无限排队 */
const thsQueue = (() => {
  let chain = Promise.resolve();
  let pending = 0;
  const MAX = 20;
  return (fn) => {
    if (pending >= MAX) {
      return Promise.reject(Object.assign(new Error("ths busy, retry later"), { status: 503 }));
    }
    pending++;
    const run = () => fn().finally(() => { pending--; });
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
})();

async function thsThrottled(path, params = {}, { timeout = 8000, retries = 3 } = {}) {
  try {
    return await thsQueue(async () => {
      for (let attempt = 0; ; attempt++) {
        const r = await thsFetch(path, params, timeout);
        const limited = r?.extra?.rateLimited === true;
        if (r?.success !== false && !limited) return r;
        if (attempt >= retries) return r; // 重试耗尽: 返回最后一次失败, 交上层回退
        await sleep(300 * 2 ** attempt);  // 0.3/0.6/1.2s 退避
      }
    });
  } catch {
    return { success: false, error: "ths busy", data: null, extra: {} };
  }
}

/** THS 完整代码(USHA600519) → 前端符号(sh600519); 非法返回 "" */
function thsSymbolOf(thsCode) {
  const m = String(thsCode || "").match(/^(USHA|USZA|USTM)(\d{6})$/);
  if (!m) return "";
  const pre = m[1] === "USHA" ? "sh" : m[1] === "USZA" ? "sz" : "bj";
  return pre + m[2];
}

/** thsdk 中文字段行 → 统一 quote 结构(对齐腾讯/东财语义)。
 *  单位换算: 成交量 股→手(÷100), 总金额 元→万元(÷1e4), 市值 元→亿(÷1e8)。 */
function thsRowToQuote(row) {
  const price = num(row["价格"]);
  const prev = num(row["昨收价"]);
  return {
    price,
    prev,
    change: num(row["涨跌"]),
    pct: num(row["涨幅"]),
    open: num(row["开盘价"]),
    high: num(row["最高价"]),
    low: num(row["最低价"]),
    vol: Math.round(num(row["成交量"]) / 100),       // 股 → 手
    amount: Math.round(num(row["总金额"]) / 10000),  // 元 → 万元
    turnover: num(row["换手率"]),                    // %
    amplitude: num(row["振幅"]),                     // %
    volRatio: num(row["量比"]),
    pe: num(row["市盈率TTM"]),
    pb: num(row["市净率1"]),
    totalMarketCap: num(row["总市值"]) / 1e8,        // 元 → 亿
    floatMarketCap: num(row["流通市值"]) / 1e8,
    marketValue: num(row["总市值"]),                 // 元(供弹窗展示)
  };
}

/** 批量 A股个股行情(THS 主源): codes 为前端符号(sh600519); 任一失败返回 null 供回退。
 *  网关内已按市场分组 + 每批 50 + 批间 sleep 0.1s(令牌桶 + 分批双重限流保护)。 */
async function thsBulkQuotes(codes) {
  const groups = { USHA: [], USZA: [], USTM: [] };
  for (const c of codes) {
    const mkt = thsCodeOf(c);
    if (mkt && groups[mkt]) groups[mkt].push(mkt + c.replace(/^(sh|sz|bj)/, ""));
  }
  const out = {};
  for (const list of Object.values(groups)) {
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      const j = await thsThrottled("/api/ths/bulk-quote", { codes: chunk.join(","), fields: "basic" }, { timeout: 10000, retries: 2 });
      if (!j?.success) return null; // 任一批失败 → 整体回退备用源
      for (const row of j.data || []) {
        const sym = thsSymbolOf(row["代码"]);
        if (sym) out[sym] = { symbol: sym, name: row["名称"] || "", ...thsRowToQuote(row) };
      }
    }
  }
  return out;
}

/** 裸 6 位 A股代码 → THS 完整代码(USHA/USZA/USTM 前缀) */
function thsCodeOf(code6) {
  const c = String(code6 || "").replace(/^[a-z]{2}/i, "");
  if (!/^\d{6}$/.test(c)) return "";
  if (c[0] === "6" || c[0] === "9") return `USHA${c}`;
  if (c[0] === "4" || c[0] === "8") return `USTM${c}`;
  return `USZA${c}`;
}

/* ---------------- 东方财富 F10 抓取(替代 KPL f10 系列) ---------------- */
const F10_HOST = "https://emweb.securities.eastmoney.com";
const DC_HOST = "https://datacenter-web.eastmoney.com";

/** f10 公司概况(survey): 返回 jbzl[0], 含主营业务 BUSINESS_SCOPE / 公司简介 ORG_PROFILE / 行业 */
async function emF10Survey(code) {
  const c = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(c)) return null;
  const market = /^6|^9/.test(c) ? "SH" : "SZ";
  try {
    const text = await fetchTextAny(`${F10_HOST}/PC_HSF10/CompanySurvey/PageAjax?code=${market}${c}`, {
      referer: F10_HOST, timeout: 6000,
    });
    const j = JSON.parse(text);
    return j?.jbzl?.[0] || null;
  } catch { return null; }
}

/** f10 业绩报表(datacenter): 最新一期主要财务指标 */
async function emF10MainTarget(code) {
  const c = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(c)) return null;
  const market = /^6|^9/.test(c) ? "SH" : "SZ";
  try {
    const url = `${DC_HOST}/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=ALL&filter=${encodeURIComponent(`(SECUCODE="${c}.${market}")`)}&pageNumber=1&pageSize=3&sortTypes=-1&sortColumns=REPORT_DATE`;
    const text = await fetchTextAny(url, { referer: "https://data.eastmoney.com/", timeout: 6000 });
    const j = JSON.parse(text);
    return j?.result?.data?.[0] || null;
  } catch { return null; }
}

function todayStr() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2);
  else if (day === 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 交易日(跳过周末)的 YYYY-MM-DD, 供按 date 查询的接口(ladder/broken 等)复用 */
function dashToday() {
  const s = todayStr();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function send(res, code, obj, extra = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
  // extra 中值为 null 的头表示显式移除; ACAO 不默认下发, 仅同源请求由 corsHeadersFor 反射
  for (const k of Object.keys(headers)) if (headers[k] == null) delete headers[k];
  res.writeHead(code, headers);
  res.end(body);
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/* 报价合理性校验(数据源优先级判定环节的"准入闸门"):
 * 任一家上游偶发返回垃圾(价格为 0/负/NaN、涨跌幅离谱)时, 拒绝该条数据,
 * 使其在缓存层不落地、不下发前端, 从而让优先级链自动落到下一可靠源。
 * 阈值取极宽松值, 只拦"明显不可能"的数据, 不误伤合法行情。 */
const saneQuote = (q) => {
  if (!q) return false;
  if (!Number.isFinite(q.price) || q.price <= 0) return false;
  if (Number.isFinite(q.pct) && Math.abs(q.pct) > 1000) return false;
  return true;
};

/* ---------------- 腾讯行情 qt.gtimg.cn ---------------- */
function parseTencentLine(line) {
  const m = line.match(/v_([a-zA-Z0-9_]+)="([^"]*)"/);
  if (!m) return null;
  const symbol = m[1];
  const f = m[2].split("~");
  if (f.length < 40) {
    // 外汇 wh 系列
    if (symbol.startsWith("wh") && f.length > 13) {
      return {
        symbol,
        name: f[1],
        price: num(f[3]),
        change: num(f[12]),
        pct: num(f[13]),
        open: num(f[6]),
        high: num(f[8]),
        low: num(f[9]),
        prev: num(f[3]) - num(f[12]),
        time: f[5],
      };
    }
    return null;
  }
  return {
    symbol,
    name: f[1],
    price: num(f[3]),
    prev: num(f[4]),
    open: num(f[5]),
    vol: num(f[6]),
    time: f[30],
    change: num(f[31]),
    pct: num(f[32]),
    high: num(f[33]),
    low: num(f[34]),
    amount: num(f[37]), // 万元(A股) / 其他市场口径各异
    turnover: num(f[38]),
    pe: num(f[39]),
    amplitude: num(f[43]),
    floatMarketCap: num(f[44]), // 流通市值(亿,A股)
    totalMarketCap: num(f[45]), // 总市值(亿,A股)
  };
}

const QUOTE_CACHE_TTL = 1500;

async function handleQuotes(codes) {
  // 按代码独立缓存(报价中心请求集随面板订阅动态变化, 整串做 key 会每次 miss 直冲上游)
  const now = Date.now();
  const out = Object.create(null); // 无原型对象: 上游 symbol 作为 key, 杜绝 __proto__ 污染
  const missing = [];
  for (const c of codes.split(",").map((s) => s.trim()).filter(Boolean)) {
    const hit = cache.get(`q:${c}`);
    if (hit && hit.data !== undefined && now - hit.ts < QUOTE_CACHE_TTL) out[c] = hit.data;
    else missing.push(c);
  }
  // ★ A股个股优先走 THS 批量(迁移主源); 失败/缺失再落腾讯
  const isAShareStock = (c) => (/^s[hz]\d{6}$/.test(c) || /^bj\d{6}$/.test(c)) && !c.startsWith("sh000") && !c.startsWith("sz399");
  const thsMissing = missing.filter((c) => isAShareStock(c) && !out[c]);
  if (thsMissing.length) {
    try {
      const thsQuotes = await thsBulkQuotes(thsMissing);
      if (thsQuotes) {
        const ts = Date.now();
        for (const q of Object.values(thsQuotes)) {
          if (saneQuote(q)) {
            out[q.symbol] = q;
            cacheSet(`q:${q.symbol}`, { ts, data: q, inflight: null, ttl: QUOTE_CACHE_TTL });
          }
        }
      }
    } catch (e) { console.error(`[ths-quotes] bulk error:`, e?.message || e); }
  }
  // ★ 剩余缺失(非A股 或 THS 未覆盖的A股): 腾讯补齐(覆盖全部代码, 含 A股核心指数)
  if (missing.length) {
    // 按 60 个/块分块并发(报价中心全集可达数百, 单 URL 过长会被上游拒绝)
    const chunks = [];
    for (let i = 0; i < missing.length; i += 60) chunks.push(missing.slice(i, i + 60));
    const texts = await Promise.all(chunks.map((c) => fetchText(`https://qt.gtimg.cn/q=${encodeURIComponent(c.join(","))}`, { gbk: true })));
    const ts = Date.now();
    for (const text of texts) {
      for (const line of text.split(";")) {
        const q = parseTencentLine(line.trim());
        if (q && saneQuote(q)) {
          out[q.symbol] = q;
          if (q.symbol !== "usVIX") cacheSet(`q:${q.symbol}`, { ts, data: q, inflight: null, ttl: QUOTE_CACHE_TTL }); // usVIX 由新浪覆盖值接管
        }
      }
    }
  }
  // 腾讯缺失的 A股核心指数(上证/深证/创业板/科创50): 回退东方财富 ulist 兜底
  const KPL_INDEX_MAP = { sh000001: "1.000001", sz399001: "0.399001", sz399006: "0.399006", sh000688: "1.000688" };
  const emIndexCodes = missing.filter((c) => KPL_INDEX_MAP[c] && !out[c]);
  if (emIndexCodes.length) {
    try {
      const secids = emIndexCodes.map((c) => KPL_INDEX_MAP[c]).join(",");
      const j = await emGet(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f2,f3,f4,f5,f6,f12,f14&np=1&fltt=2&invt=2`);
      const diff = j?.data?.diff || [];
      const ts = Date.now();
      const byCode = { "1.000001": "sh000001", "0.399001": "sz399001", "0.399006": "sz399006", "1.000688": "sh000688" };
      for (const d of diff) {
        const symbol = byCode[d.f12];
        if (!symbol || out[symbol]) continue;
        const price = num(d.f2);
        const prev = price - num(d.f4);
        if (price > 0 && prev > 0) {
          const q = {
            symbol,
            name: String(d.f14 || ""),
            price,
            prev,
            change: +num(d.f4).toFixed(2),
            pct: +num(d.f3).toFixed(2),
            open: prev,
            high: num(d.f2),
            low: num(d.f2),
            amount: Math.round(num(d.f6) / 10000) || 0,
            turnover: 0,
            time: "",
          };
          if (saneQuote(q)) {
            out[symbol] = q;
            cacheSet(`q:${symbol}`, { ts, data: q, inflight: null, ttl: QUOTE_CACHE_TTL });
          }
        }
      }
    } catch (e) {
      console.error("[em-index] ulist fetch error:", e?.message || e);
    }
  }
  // usVIX 腾讯数据已停更，从新浪期货获取实时值覆盖(仅缓存过期时重取)
  if (codes.includes("usVIX")) {
    const hit = cache.get("q:usVIX");
    if (hit && hit.data !== undefined && now - hit.ts < QUOTE_CACHE_TTL) {
      out.usVIX = hit.data;
    } else {
      try {
        const vixText = await curlText("https://hq.sinajs.cn/list=hf_VX", { referer: "https://finance.sina.com.cn/futures/", timeout: 4000, encoding: "utf-8" });
        const m = vixText.match(/hf_VX="([^"]*)"/);
        if (m) {
          const f = m[1].split(",");
          const price = parseFloat(f[0]);
          const prev = parseFloat(f[7]);
          if (!isNaN(price)) {
            out.usVIX = {
              symbol: "usVIX",
              name: "VIX恐慌指数期货",
              price,
              prev,
              change: +(price - prev).toFixed(4),
              pct: prev ? +(((price - prev) / prev) * 100).toFixed(3) : 0,
              time: `${f[12]} ${f[6]}`,
            };
            cacheSet("q:usVIX", { ts: Date.now(), data: out.usVIX, inflight: null, ttl: QUOTE_CACHE_TTL });
          }
        }
      } catch { /* keep tencent fallback */ }
    }
  }
  // usN225(日经225) 和 usKS11(韩国KOSPI) 腾讯不支持,新浪 hq.sinajs.cn 也不支持全球指数,
  // 从新浪全球指数历史日线 API 获取最新收盘数据(近实时,可获取昨收)
  const SINA_DAILY_MAP = { usN225: "NKY", usKS11: "KOSPI" };
  const SINA_DAILY_NAMES = { usN225: "日经225", usKS11: "韩国KOSPI" };
  for (const [code, symbol] of Object.entries(SINA_DAILY_MAP)) {
    if (!codes.includes(code)) continue;
    const hit = cache.get(`q:${code}`);
    if (hit && hit.data !== undefined && now - hit.ts < QUOTE_CACHE_TTL) {
      out[code] = hit.data;
    } else {
      try {
        const text = await fetchTextAny(`https://gi.finance.sina.com.cn/hq/daily?symbol=${symbol}&num=3`, { referer: "https://finance.sina.com.cn/", timeout: 6000 });
        let json;
        try {
          json = parseJsonp(text);
        } catch {
          json = JSON.parse(text);
        }
        // 新浪日线API返回格式: {"code":0,"message":"","result":{"data":[...]}}
        const rows = json?.result?.data || json?.data || [];
        if (rows.length >= 2) {
          const latest = rows[rows.length - 1];
          const prev = rows[rows.length - 2];
          const price = parseFloat(latest.c);
          const prevClose = parseFloat(prev.c);
          if (!isNaN(price) && !isNaN(prevClose)) {
            const change = price - prevClose;
            const pct = prevClose ? (change / prevClose) * 100 : 0;
            const q = {
              symbol: code,
              name: SINA_DAILY_NAMES[code],
              price,
              prev: prevClose,
              open: parseFloat(latest.o) || prevClose,
              high: parseFloat(latest.h) || price,
              low: parseFloat(latest.l) || price,
              change: +change.toFixed(2),
              pct: +pct.toFixed(2),
              amount: 0,
              turnover: 0,
              time: latest.d,
            };
            if (saneQuote(q)) {
              out[code] = q;
              cacheSet(`q:${code}`, { ts: Date.now(), data: q, inflight: null, ttl: QUOTE_CACHE_TTL });
            }
          }
        }
      } catch (e) {
        console.error(`[sina-daily-index] ${code} fetch error:`, e?.message || e);
      }
    }
  }
  // 金额校验机制: 非A股(hk*/us*)成交额口径非"万元"(腾讯对美股指数返回"点数×成交量"的伪值),
  // 一律置 0(前端不展示); A股金额再做合理性钳制(非有限/负/天文数字视为异常置 0), 防止异常值外泄
  for (const c of Object.keys(out)) {
    const q = out[c];
    if (!q) continue;
    if (c.startsWith("hk") || c.startsWith("us")) {
      q.amount = 0;
    } else if (q.amount == null || !Number.isFinite(q.amount) || q.amount < 0 || q.amount > 1e10) {
      q.amount = 0;
    }
  }
  return out;
}

/* ---------------- 腾讯分钟线(指数/个股 日内走势) ---------------- */
/* ---------------- A股个股分时: 主备健康切换(腾讯主 / 同花顺THS备) ----------------
 * 不再"KPL优先、失败才回退", 而是维护每只股票的当前主源并轮流使用:
 *  - 主源连续失败 N 次 → 切换为备源(本轮回退备源取数, 保证有数据)
 *  - 备源连续成功 M 次 → 探测一次主源, 恢复则切回主源
 * 返回带 source 字段标记实际数据源, 便于前端透传与定位
 */
const MINUTE_SWITCH_THRESHOLD = 2; // 连续失败次数达到即切换主备
const MINUTE_RECOVER_PROBE = 5;    // 备源连续成功达到该次数后探测一次主源
const minuteSrcState = new Map();  // code -> { primary, fail, okOnBackup }

function minuteState(code) {
  let s = minuteSrcState.get(code);
  if (!s) { s = { primary: "ths", fail: 0, okOnBackup: 0 }; minuteSrcState.set(code, s); }
  return s;
}

/** 同花顺 THS 个股分时(主源); 成功返回 {code,prec,points}, 失败/空返回 null */
async function thsMinuteFetch(code) {
  const stockCode = code.replace(/^s[hz]/, "");
  const thsCode = thsCodeOf(stockCode);
  if (!thsCode) return null;
  const j = await thsThrottled("/api/ths/minute", { code: thsCode }, { timeout: 8000, retries: 2 });
  const rows = j?.data || [];
  if (!j?.success || !rows.length) return null;
  let prec = 0;
  try {
    const q = await thsThrottled("/api/ths/quote", { code: thsCode }, { timeout: 8000, retries: 1 });
    if (q?.success && q.data?.[0]) prec = num(q.data[0]["昨收价"]);
  } catch { /* prec 保持 0 */ }
  const pts = rows.map((r) => ({ t: String(r["时间"] || "").slice(11, 16), p: num(r["价格"]) }));
  return { code, prec, points: pts };
}

/** 腾讯 A股个股分时; 成功返回 {code,prec,points}, 失败/空返回 null */
async function tencentMinuteFetch(code) {
  const url = `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(code)}`;
  const text = await fetchText(url);
  const json = JSON.parse(text);
  const d = json?.data?.[code];
  const arr = d?.data?.data || [];
  if (!arr.length) return null;
  const prec = num(d?.data?.prec || d?.qt?.[code]?.[4] || 0);
  const pts = arr.map((s) => { const p = s.split(" "); return { t: p[0], p: num(p[1]) }; });
  return { code, prec, points: pts };
}

async function handleMinute(code) {
  // 归一化代码: 裸 6 位 A股代码(如板块榜/涨停数据给的 600519)补上 sh/sz/bj 前缀,
  // 否则分时取数会跳过 KPL 路径、落回腾讯且带错格式(腾讯需要 sh600519), 导致分时图加载失败
  code = String(code || "").toLowerCase();
  if (/^\d{6}$/.test(code)) {
    const c = code[0];
    if (c === "6" || c === "9") code = `sh${code}`;
    else if (c === "0" || c === "2" || c === "3") code = `sz${code}`;
    else if (c === "4" || c === "8") code = `bj${code}`;
  }
  // 美股指数(us*)只有 usMinute 接口返回全日序列, minute/query 只给最后一个点
  // usN225(日经225) 和 usKS11(韩国KOSPI): 东方财富全球指数分时(新浪全球期货分钟线已失效,
  // 腾讯 usMinute 也不支持, 改走 push2his trends2, secid=100.N225 / 100.KS11)
  const EM_GLOBAL_INDEX = { usn225: "100.N225", usks11: "100.KS11" };
  // 国际(港股/美股)指数代码上游对大小写敏感: 小写(hkhsi/usixic)会返回空数据,
  // 必须用规范大小写(hkHSI/hkHSTECH/usIXIC)才能取到完整分时序列
  const INT_INDEX_CASE = { hkhsi: "hkHSI", hkhstech: "hkHSTECH", usixic: "usIXIC", usn225: "usN225", usks11: "usKS11" };
  const urlCode = INT_INDEX_CASE[code] || code;
  if (EM_GLOBAL_INDEX[code]) {
    try {
      const secid = EM_GLOBAL_INDEX[code];
      const j = await emGetHis(`${EM_HIS}/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1`);
      const d = j?.data;
      const trends = Array.isArray(d?.trends) ? d.trends : [];
      const prec = num(d?.preClose || d?.preSettlement);
      // "2026-08-07 08:00,6365.07,0,6365.070" -> {t:"08:00", p:6365.07}
      const pts = trends
        .map((s) => { const f = String(s).split(","); return { t: String(f[0]).slice(11, 16), p: num(f[1]) }; })
        .filter((p) => p.t.includes(":"));
      return { code, prec, points: pts };
    } catch (e) {
      console.error(`[em-global-minute] ${code} error:`, e?.message || e);
      return { code, prec: 0, points: [] };
    }
  }
  // A股个股分时: 主备健康切换(腾讯主 / 同花顺THS备), 轮流使用保证数据平滑与容错
  if (/^s[hz]\d{6}$/.test(code) && !code.startsWith("sh000") && !code.startsWith("sz399")) {
    const st = minuteState(code);
    if (st.primary === "tencent") {
      // 主源 = 腾讯
      try {
        const t = await tencentMinuteFetch(code);
        if (t && t.points.length) { st.fail = 0; return { ...t, source: "tencent" }; }
      } catch (e) { console.error(`[tencent-minute] ${code} error:`, e?.message || e); }
      // 主源失败: 累计失败, 达到阈值切换为备源
      st.fail++;
      if (st.fail >= MINUTE_SWITCH_THRESHOLD) { st.primary = "ths"; st.fail = 0; st.okOnBackup = 0; console.log(`[minute-src] ${code} -> ths (tencent x${MINUTE_SWITCH_THRESHOLD} fail)`); }
      // 本轮回退 thsdk, 保证有数据
      try { return { ...(await thsMinuteFetch(code) || { code, prec: 0, points: [] }), source: "ths" }; }
      catch (e) { console.error(`[ths-minute] ${code} error:`, e?.message || e); return { code, prec: 0, points: [], source: "ths" }; }
    } else {
      // 主源 = thsdk(备源)
      try {
        const t = await thsMinuteFetch(code);
        if (t && t.points.length) {
          st.fail = 0; st.okOnBackup++;
          // 备源连续成功若干次后, 探测一次主源(腾讯)以判断是否恢复, 恢复则切回
          if (st.okOnBackup >= MINUTE_RECOVER_PROBE) {
            st.okOnBackup = 0;
            try {
              const tc = await tencentMinuteFetch(code);
              if (tc && tc.points.length) { st.primary = "tencent"; console.log(`[minute-src] ${code} -> tencent (recovered)`); return { ...tc, source: "tencent" }; }
            } catch (e) { console.error(`[tencent-minute] ${code} recover probe error:`, e?.message || e); }
          }
          return { ...t, source: "ths" };
        }
      } catch (e) { console.error(`[ths-minute] ${code} error:`, e?.message || e); }
      // 备源失败: 累计失败, 达到阈值切回主源
      st.fail++;
      if (st.fail >= MINUTE_SWITCH_THRESHOLD) { st.primary = "tencent"; st.fail = 0; console.log(`[minute-src] ${code} -> tencent (ths x${MINUTE_SWITCH_THRESHOLD} fail)`); }
      // 本轮回退腾讯
      try { return { ...(await tencentMinuteFetch(code) || { code, prec: 0, points: [] }), source: "tencent" }; }
      catch (e) { console.error(`[tencent-minute] ${code} error:`, e?.message || e); return { code, prec: 0, points: [], source: "tencent" }; }
    }
  }
  const url = urlCode.startsWith("us")
    ? `https://web.ifzq.gtimg.cn/appstock/app/usMinute/query?code=${encodeURIComponent(urlCode)}`
    : `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(urlCode)}`;
  const text = await fetchText(url);
  const json = JSON.parse(text);
  const d = json?.data?.[urlCode];
  const arr = d?.data?.data || [];
  const prec = num(d?.data?.prec || d?.qt?.[urlCode]?.[4] || 0);
  // 返回 "HHMM price vol" -> [分钟索引, 价格]
  const pts = arr.map((s) => {
    const p = s.split(" ");
    return { t: p[0], p: num(p[1]) };
  });
  return { code, prec, points: pts };
}

/** 单指数分时, 带 5s 独立缓存与并发去重(供单指数与批量只读复用) */
function getMinute(code) {
  return cached(`minute:${code}`, 5000, () => handleMinute(code || "sh000001"));
}

/* ---------------- 腾讯板块榜(行业 t=01 / 概念 t=02) ---------------- */
/* 已清空: 预留新功能, 接口返回空数组 */
async function handleBoards(type, dir, n) {
  return [];
}

/* ---------------- 板块成分股(上游单页上限100, 自动翻页) ---------------- */
/* 已清空: 预留新功能, 接口返回空数组 */
async function handleBoardStocks(code, dir, n) {
  return [];
}

/* ---------------- 通用工具(供指数/榜单等共用) ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 给 Promise 加超时: 超时后拒绝并携带错误信息(不取消底层任务, 仅用于响应侧限时) */
function withTimeout(promise, ms, label = "timeout") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} (${ms}ms)`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function parseJsonp(text) {
  // 尝试 callback({...}) 格式
  const a = text.indexOf("(");
  const b = text.lastIndexOf(")");
  if (a >= 0 && b > a) return JSON.parse(text.slice(a + 1, b));
  // 尝试 var t={...} 格式 (新浪全球指数日线API)
  const eq = text.indexOf("=");
  if (eq >= 0) {
    const trimmed = text.slice(eq + 1).trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed.replace(/;$/, ""));
  }
  throw new Error("bad jsonp: " + text.slice(0, 80));
}

/* ---------------- 个股榜单(涨幅/跌幅/热门) — 新浪盘中 + 腾讯盘后双源 ---------------- */
async function rankViaSina(sort, asc, want) {
  const fetchN = Math.min(100, Math.max(want * 3, 60));
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=${fetchN}&sort=${encodeURIComponent(sort)}&asc=${encodeURIComponent(asc)}&node=hs_a&symbol=&_s_r_a=page`;
  const arr = await fetchSinaJson(url);
  if (!Array.isArray(arr)) return [];
  return arr.filter((s) => num(s.trade) > 0).slice(0, want).map((s) => ({
    symbol: s.symbol,
    code: s.code,
    name: s.name,
    price: num(s.trade),
    change: num(s.pricechange),
    pct: num(s.changepercent),
    open: num(s.open),
    high: num(s.high),
    low: num(s.low),
    vol: num(s.volume),
    amount: num(s.amount), // 元
    pe: num(s.per),
    pb: num(s.pb),
    total_mv: num(s.mktcap), // 万元
    circ_mv: num(s.nmc), // 万元
    turnover: num(s.turnoverratio),
    time: s.ticktime,
  }));
}

async function rankViaTencent(sort, asc, want) {
  // 盘后新浪清零,腾讯保留收盘价;涨跌幅字段同样清零(返回0)
  const sortMap = { changepercent: "PriceRatio", amount: "volume", turnoverratio: "PriceRatio" };
  const url = `https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList?board_code=aStock&sort_type=${encodeURIComponent(sortMap[sort] || "PriceRatio")}&direct=${asc === "1" ? "up" : "down"}&offset=0&count=${want}`;
  const text = await fetchText(url);
  const json = JSON.parse(text);
  return (json?.data?.rank_list || [])
    .filter((s) => num(s.zxj) > 0)
    .map((s) => ({
      symbol: s.code,
      code: s.code.slice(2),
      name: s.name,
      price: num(s.zxj),
      change: num(s.zd),
      pct: num(s.zdf),
      open: 0, high: 0, low: 0,
      vol: num(s.volume),
      amount: num(s.volume) * 100 * num(s.zxj), // 成交量(手)估算成交额
      pe: num(s.pe_ttm),
      pb: 0,
      total_mv: num(s.zsz) * 10000,
      circ_mv: num(s.ltsz) * 10000,
      turnover: num(s.hsl),
      time: "",
    }));
}

async function handleRank(sort, asc, n) {
  /* 已清空: 预留新功能, 接口返回空数组 */
  return [];
}

/* ---------------- 新浪个股主力资金流(兜底) ---------------- */
/* 已清空: 预留新功能, 接口返回空数组 */
async function handleMoneyFlow(n) {
  return [];
}

/* ---------------- 个股所属板块(东财): 行业/地域/概念 ---------------- */
/* 东财对突发请求会断连(WAF), 串行队列 + 双节点 + fetch/curl 双通道兜底 */
let emQueue = Promise.resolve();
let emPending = 0; // 排队+执行中的任务数
const EM_QUEUE_MAX = 20;
function emEnqueue(fn) {
  // 队列满直接拒绝, 不再无界排队(err.status 供路由层返回 503)
  if (emPending >= EM_QUEUE_MAX) {
    const err = new Error("busy, retry later");
    err.status = 503;
    return Promise.reject(err);
  }
  emPending++;
  const run = () => fn().finally(() => { emPending--; });
  const p = emQueue.then(run, run);
  emQueue = p.catch(() => {});
  return p;
}

/* ---------------- 个股所属板块/概念(东财 f127/f128/f129, 替代 KPL f10-concept) ---------------- */
async function handleStockBoards(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return { code: String(code || ""), industry: "", area: "", concepts: [] };
  // 北交所(4/8)与深市同用 market=0; 沪市(6/9)用 market=1
  const market = /^6|^9/.test(stockCode) ? 1 : 0;
  try {
    const j = await emGet(`https://push2delay.eastmoney.com/api/qt/stock/get?secid=${market}.${stockCode}&fields=f127,f128,f129&np=1&fltt=2&invt=2`);
    const d = j?.data || {};
    return {
      code: String(code || ""),
      industry: String(d.f127 || "").trim(),
      area: String(d.f128 || "").trim(),
      concepts: String(d.f129 || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  } catch {
    return { code: String(code || ""), industry: "", area: "", concepts: [] };
  }
}

/** 个股主营业务/公司信息(东财 F10 survey, 24h 缓存) */
async function handleStockProfile(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return { code: String(code || ""), mainBusiness: "" };
  const info = await emF10Survey(stockCode);
  return {
    code: String(code || ""),
    mainBusiness: info?.BUSINESS_SCOPE || info?.ORG_PROFILE || "",
    name: info?.SECURITY_NAME_ABBR || "",
  };
}

/* ---------------- 个股详情聚合接口(本地数据库 + 按需抓取 + 失败回退) ---------------- */
// 分字段 TTL: 实时行情10s / 分时60s / 主力净额30s / 行业概念与主营业务 24h(但永久保留, 不删除)
const SD_TTL = { quote: 10_000, minute: 60_000, main_forces: 30_000, boards: 24 * 3600 * 1000, profile: 24 * 3600 * 1000 };
// 冷启动(库中无行业/概念)时: 阻塞响应等待抓取, 保证首次打开 1s 内显示行业/概念; 超时则返回空, 由前端快速补拉
const BOARDS_COLD_TIMEOUT = 900;
// 仅在"无数据 或 已过期"时才抓取(按需), 失败则保留库中旧值(回退)
const stale = (v, ts, ttl) => v === null || v === undefined || (Date.now() - (ts || 0)) > ttl;
// 失败冷却: 字段抓取失败后 30s 内不再重试, 避免反复打故障上游(优化调用性价比)
const sdBackoff = new Map();
const inCooldown = (code, field) => (sdBackoff.get(code + ":" + field) || 0) > Date.now();
const failBackoff = (code, field, cd = 30000) => sdBackoff.set(code + ":" + field, Date.now() + cd);
const clearBackoff = (code, field) => sdBackoff.delete(code + ":" + field);

async function handleStockDetail(code) {
  const now = Date.now();
  let row = getStock(code);
  if (!row) row = { code, created_at: now };

  // 快字段(实时/分时/主力): 溢出时阻塞响应, 保证打开小窗即返回核心数据
  const jobs = [];
  if (stale(row.quote, row.quote_ts, SD_TTL.quote) && !inCooldown(code, "quote")) jobs.push(async () => {
    const q = await handleStockQuote(code);
    if (q) { row.quote = q; row.quote_ts = now; clearBackoff(code, "quote"); } else failBackoff(code, "quote");
  });
  if (stale(row.minute, row.minute_ts, SD_TTL.minute) && !inCooldown(code, "minute")) jobs.push(async () => {
    const m = await handleMinute(code);
    if (m && m.points && m.points.length) { row.minute = m; row.minute_ts = now; clearBackoff(code, "minute"); } else failBackoff(code, "minute");
  });
  if (stale(row.main_forces, row.main_forces_ts, SD_TTL.main_forces) && !inCooldown(code, "main_forces")) jobs.push(async () => {
    const mf = await handleStockMainForces(code);
    if (mf) { row.main_forces = mf; row.main_forces_ts = now; clearBackoff(code, "main_forces"); } else failBackoff(code, "main_forces");
  });
  await Promise.all(jobs.map((j) => j().catch(() => {})));

  // 慢字段(行业/概念/主营业务): 行业/概念为"基础静态数据", 每日批量刷新一次, 此处仅首次打开(从未入库)时补种一次,
  // 之后一律读库, 不做实时外呼; 主营业务维持 24h 后台刷新。
  const bg = [];
  const boardsEmpty = !row.industry && !row.area && (!row.concepts || row.concepts.length === 0);
  if (boardsEmpty && !inCooldown(code, "boards")) {
    // 冷启动补种: 阻塞等待抓取(带超时), 让首次打开即有数据; 超时则放弃本次, 返回空由前端快速补拉
    const fetchBoards = async () => {
      const b = await handleStockBoards(code);
      if (b && (b.industry || b.area || b.concepts.length > 0)) {
        row.industry = b.industry; row.area = b.area; row.concepts = b.concepts; row.boards_ts = now; clearBackoff(code, "boards");
      } else failBackoff(code, "boards");
    };
    await withTimeout(fetchBoards(), BOARDS_COLD_TIMEOUT, "boards cold").catch(() => {});
  }
  if ((!row.profile_ts || now - row.profile_ts > SD_TTL.profile || !row.main_business) && !inCooldown(code, "profile")) bg.push(async () => {
    const p = await handleStockProfile(code);
    if (p && p.mainBusiness) { row.main_business = p.mainBusiness; row.profile_ts = now; clearBackoff(code, "profile"); } else failBackoff(code, "profile");
    upsertStock(row);
  });
  bg.forEach((j) => j().catch(() => {})); // 后台执行, 不阻塞本次响应

  if (!row.name) row.name = row.quote?.name || null;

  upsertStock(row);
  return {
    code,
    dataSuccess: true,
    fromCache: true, // 本次响应始终来自本地库(可能含刚抓取的新值)
    name: row.name || null,
    quote: row.quote || null,
    minute: row.minute || null,
    mainForces: row.main_forces || null,
    boards: { industry: row.industry || "", area: row.area || "", concepts: row.concepts || [] },
    profile: { mainBusiness: row.main_business || "" },
    updated: now,
  };
}

/* ---------------- 每日行业/概念批量刷新(基础静态数据) ---------------- */
// 行业/概念为"每日更新一次"的基础静态数据: 批量刷新库内全部个股(即历史加载过的全集),
// 落库后读路径一律从库直出, 不再实时外呼。并发受控, 避免打爆上游 KPL。
const DAILY_BOARDS_CONCURRENCY = 6;

async function runDailyBoardsRefresh() {
  const codes = allStockCodes();
  if (!codes.length) return { ok: 0, fail: 0 };
  let ok = 0, fail = 0, i = 0;
  const worker = async () => {
    while (i < codes.length) {
      const code = codes[i++];
      try {
        const b = await handleStockBoards(code);
        if (b && (b.industry || b.area || b.concepts.length > 0)) {
          // 精简列写入: 只更新行业/概念等长期字段, 避免全行 SELECT * + 全量 COALESCE 覆写(写放大)
          upsertStockBoards(code, b.name || null, b.industry, b.area, b.concepts, Date.now());
          ok++;
        } else fail++;
      } catch { fail++; }
    }
  };
  await Promise.all(Array.from({ length: DAILY_BOARDS_CONCURRENCY }, worker));
  return { ok, fail };
}

// 每日调度: 启动后立即检查一次, 之后每小时检查。通过 meta 表持久化"今日已刷新"标记,
// 保证每天仅执行一次, 且服务重启不会当天重复执行。
function scheduleDailyBoardsRefresh() {
  const tryRun = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (getMeta("daily_boards_last_date") === today) return; // 今天已刷新过
      const total = allStockCodes().length;
      console.log(`[daily-boards] start refresh ${total} stocks...`);
      const res = await runDailyBoardsRefresh();
      setMeta("daily_boards_last_date", today);
      console.log(`[daily-boards] done ok=${res.ok} fail=${res.fail}`);
    } catch (e) {
      console.error("[daily-boards] error:", e.message);
    }
  };
  tryRun();
  const timer = setInterval(tryRun, 60 * 60 * 1000);
  timer.unref();
}

/* ---------------- 个股实时行情(东财 ulist, 替代 KPL 盘口 pankou) ----------------
 * f2最新价 f3涨跌幅 f4涨跌额 f5成交量(手) f6成交额(元) f8换手率 f9市盈率 f10量比
 * f14名称 f15最高 f16最低 f17今开 f18昨收 f20总市值 f23市净率
 * 振幅 = (最高-最低)/昨收×100%(ulist 的 f43 语义异常, 不采用) */
async function handleStockQuote(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return null;
  // THS 主源(full: 基础+汇总, 含换手/振幅/量比/PE/PB/市值); 失败回退东财 ulist
  const thsCode = thsCodeOf(stockCode);
  if (thsCode) {
    try {
      const j = await thsThrottled("/api/ths/bulk-quote", { codes: thsCode, fields: "full" }, { timeout: 8000, retries: 2 });
      const row = j?.success ? (j.data || []).find((x) => String(x["代码"]).toUpperCase() === thsCode) : null;
      if (row && num(row["价格"]) > 0) {
        return { code: String(code || ""), name: row["名称"] || "", ...thsRowToQuote(row), time: "" };
      }
    } catch (e) { console.error(`[ths-quote] ${code} error:`, e?.message || e); }
  }
  const market = /^6|^9/.test(stockCode) ? 1 : 0; // 沪=1, 深/北=0
  try {
    const j = await emGet(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${market}.${stockCode}&fields=f2,f3,f4,f5,f6,f8,f9,f10,f12,f14,f15,f16,f17,f18,f20,f23&np=1&fltt=2&invt=2`);
    const d = j?.data?.diff?.[0];
    if (!d) return null;
    const price = num(d.f2);
    const prev = num(d.f18);
    const amplitude = prev > 0 ? ((num(d.f15) - num(d.f16)) / prev) * 100 : 0; // 振幅(%)
    return {
      code: String(code || ""),
      name: d.f14 || "",
      price,
      prev,
      change: num(d.f4),
      pct: num(d.f3),
      open: num(d.f17),
      high: num(d.f15),
      low: num(d.f16),
      amount: Math.round(num(d.f6) / 10000), // 成交额(万元)
      vol: num(d.f5), // 成交量(手)
      turnover: num(d.f8), // 换手率(%)
      amplitude, // 振幅(%)
      volRatio: num(d.f10), // 量比
      pe: num(d.f9), // 市盈率
      pb: num(d.f23), // 市净率
      marketValue: num(d.f20), // 总市值(元)
      time: "",
    };
  } catch { return null; }
}

/* ---------------- 个股财务指标(东财 datacenter 业绩报表, 替代 KPL F10财务摘要, 24h 缓存) ---------------- */
async function handleStockFinance(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return null;
  const r = await emF10MainTarget(stockCode);
  if (!r) return null;
  return {
    code: String(code || ""),
    date: String(r.REPORT_DATE || "").slice(0, 10),
    revenue: r.TOTALOPERATEREVE ?? r.OPERATE_INCOME_PK ?? "",     // 营业总收入
    netProfit: r.PARENTNETPROFIT ?? "",                          // 归母净利润
    dedProfit: r.KCFJCXSYJLR ?? "",                              // 扣非净利润
    eps: r.EPSJB ?? "",                                          // 基本每股收益
    bvps: r.BPS ?? "",                                           // 每股净资产
    roe: r.ROEJQ ?? "",                                          // 加权净资产收益率(%)
    roeYoY: r.ROEJQTZ ?? "",                                     // ROE 同比
    grossMargin: r.XSMLL ?? "",                                  // 销售毛利率(%)
    inventoryTurnover: r.CHZZL ?? "",                            // 存货周转率
    debtRatio: r.ZCFZL ?? "",                                    // 资产负债率(%)
    profitYoY: r.PARENTNETPROFITTZ ?? "",                        // 净利同比
    revenueYoY: r.TOTALOPERATEREVETZ ?? "",                      // 营收同比
  };
}

/* ---------------- 东财个股资金流(按股查询) + 主力净流入排名 ---------------- */
const emMarketOf = (m) => (m === "sh" ? 1 : 0);
const EM_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";

async function emGet(url) {
  let lastErr = new Error("em request failed");
  for (const via of ["fetch", "curl"]) {
    try {
      const text =
        via === "fetch"
          ? await fetchText(url, { referer: "https://quote.eastmoney.com/" })
          : await curlText(url, { referer: "https://quote.eastmoney.com/", encoding: "utf-8" });
      await sleep(60); // 队列节流
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw lastErr;
}

const emSymbol = (code6) => `${"689".includes(code6[0]) ? "sh" : code6[0] === "4" || code6[0] === "8" ? "bj" : "sz"}${code6}`;

/** 主力净流入排名(clist, f62 降序) */
async function handleMoneyFlowEM(n) {
  /* 已清空: 预留新功能, 接口返回空数组 */
  return [];
}

/** 批量个股资金流(ulist 一次最多 50 只, 按 code 30s 缓存) */
async function handleStockFlows(codesParam) {
  const list = String(codesParam || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^(sh|sz|bj)\d{6}$/.test(s))
    .slice(0, 150);
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const c of list) {
    const hit = cache.get(`sf:${c}`);
    if (hit && hit.data !== undefined && now - hit.ts < 30000) out[c] = hit.data;
    else missing.push(c);
  }
  if (missing.length) {
    await emEnqueue(async () => {
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        const secids = chunk.map((c) => `${emMarketOf(c.slice(0, 2))}.${c.slice(2)}`).join(",");
        const url = `https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f12,f62,f184&np=1&fltt=2&invt=2`;
        const diff = (await emGet(url))?.data?.diff || [];
        for (const d of diff) {
          const c = emSymbol(d.f12);
          const rec = { code: c, netIn: num(d.f62), netRatio: num(d.f184) };
          cacheSet(`sf:${c}`, { ts: Date.now(), data: rec, inflight: null, ttl: 30000 });
          out[c] = rec;
        }
      }
    });
  }
  return list.map((c) => out[c]).filter(Boolean);
}

/* ---------------- 个股主力净额(THS 主源 / 东财 ulist 备, 替代 KPL 主力资金 main-forces) ---------------- */
async function handleStockMainForces(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return Promise.reject(new Error("invalid stock code"));
  // THS 主源: 基础(总金额) + 扩展1(主力净流入592890); 失败回退东财
  const thsCode = thsCodeOf(stockCode);
  if (thsCode) {
    try {
      const j = await thsThrottled("/api/ths/main-forces", { code: thsCode }, { timeout: 8000, retries: 2 });
      const d = j?.success ? (j.data || [])[0] : null;
      if (d && d["主力净流入"] !== undefined) {
        const netIn = num(d["主力净流入"]); // 主力净流入(元)
        const totalAmt = num(d["总金额"]);  // 成交额(元)
        return {
          code,
          day: dashToday(),
          netAmount: netIn,
          totalAmount: totalAmt,
          buyAmount: netIn > 0 ? netIn : 0,
          sellAmount: netIn < 0 ? -netIn : 0,
          buyRatio: netIn > 0 ? Math.abs(num(d["主力净量"])) : 0,
          sellRatio: netIn < 0 ? Math.abs(num(d["主力净量"])) : 0,
          mainForce: netIn >= 0 ? "流入" : "流出",
        };
      }
    } catch (e) { console.error(`[ths-main-forces] ${code} error:`, e?.message || e); }
  }
  const market = /^6|^9/.test(stockCode) ? 1 : 0;
  try {
    const j = await emGet(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=${market}.${stockCode}&fields=f12,f14,f62,f184,f6,f5&np=1&fltt=2&invt=2`);
    const d = j?.data?.diff?.[0];
    if (!d) return null;
    const netIn = num(d.f62); // 主力净流入(元)
    const totalAmt = num(d.f6); // 成交额(元)
    return {
      code,
      day: dashToday(),
      netAmount: netIn,
      totalAmount: totalAmt,
      buyAmount: netIn > 0 ? netIn : 0,
      sellAmount: netIn < 0 ? -netIn : 0,
      buyRatio: netIn > 0 ? Math.abs(num(d.f184)) : 0,
      sellRatio: netIn < 0 ? Math.abs(num(d.f184)) : 0,
      mainForce: netIn >= 0 ? "流入" : "流出",
    };
  } catch {
    return null;
  }
}

/** 板块实时资金流向图: 流入/流出各取前N/2, 拉取分钟级累计主力净流入 */
async function handleBoardFlow(n) {
  const half = Math.max(3, Math.min(15, Math.floor((parseInt(n) || 20) / 2)));
  return emEnqueue(async () => {
    const pick = async (po) => {
      const url = `https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=${po}&pz=${half}&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("m:90+t:2")}&fields=f12,f14,f62`;
      return ((await emGet(url))?.data?.diff || []).map((b) => ({
        code: b.f12,
        name: b.f14,
        netIn: num(b.f62),
      }));
    };
    const [ups, downs] = await Promise.all([pick(1), pick(0)]);
    const boards = [...ups, ...downs.filter((d) => !ups.some((u) => u.code === d.code))];
    const out = [];
    for (const b of boards) {
      try {
        const url = `https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get?secid=90.${b.code}&klt=1&lmt=0&fields1=f1,f2,f3,f7&fields2=f51,f52`;
        const kl = (await emGet(url))?.data?.klines || [];
        out.push({
          ...b,
          points: kl.map((s) => {
            const f = s.split(",");
            return { t: f[0].slice(11, 16), v: num(f[1]) }; // "2026-07-17 09:31" -> "09:31", 累计主力净流入(元)
          }),
        });
      } catch {
        out.push({ ...b, points: [] });
      }
    }
    return out;
  });
}

/* ---------------- 新浪接口(node fetch 被拦时回退 curl) ---------------- */
async function fetchSinaJson(url, { referer } = {}) {
  try {
    const text = await fetchText(url, { referer });
    return JSON.parse(text);
  } catch (e) {
    // node fetch 被新浪 WAF 拦截(返回HTML)时,改走 curl
    const text = await curlText(url, { referer });
    return JSON.parse(text);
  }
}

/* ---------------- 新浪 7x24 快讯 ---------------- */
function parseNewsItem(it) {
  const raw = it.rich_text || "";
  const m = raw.match(/^【(.+?)】([\s\S]*)$/);
  return {
    id: it.id,
    title: m ? m[1] : "",
    content: m ? m[2] : raw,
    time: it.create_time,
  };
}

/* 华尔街见闻快讯(兜底源,全球可达,CORS开放) */
async function fetchWscnNews(size) {
  const url = `https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=${Math.min(size, 50)}`;
  const text = await fetchText(url);
  const json = JSON.parse(text);
  const items = json?.data?.items || [];
  const fmt = (sec) => {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  return items
    .filter((it) => it.content_text || it.content)
    .map((it, i) => ({
      id: it.id || it.display_time * 100 + i,
      title: it.title || "",
      content: (it.content_text || it.content || "").replace(/<[^>]+>/g, ""),
      time: fmt(it.display_time),
    }));
}

async function handleNews(page, size) {
  const url = `https://zhibo.sina.com.cn/api/zhibo/feed?page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(size)}&zhibo_id=152&tag_id=0`;
  try {
    const json = await fetchSinaJson(url);
    const list = json?.result?.data?.feed?.list || [];
    if (list.length) return list.map(parseNewsItem);
    throw new Error("empty sina feed");
  } catch {
    return fetchWscnNews(size);
  }
}

/* ---------------- CNBC 美债收益率 ---------------- */
const TREASURY_SYMBOLS = ["US3M", "US6M", "US1Y", "US2Y", "US3Y", "US5Y", "US7Y", "US10Y", "US20Y", "US30Y"];
async function handleTreasuries() {
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${TREASURY_SYMBOLS.join("|")}&requestMethod=quick&noform=1&partnerId=2&fund=1&output=json`;
  const text = await fetchTextAny(url); // CNBC 对 node fetch 间歇断连, fetch/curl 双通道
  const json = JSON.parse(text);
  const list = json?.FormattedQuoteResult?.FormattedQuote || [];
  return list
    .filter((q) => q.code === 0 && q.last)
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortName || q.name,
      yield: num(String(q.last).replace("%", "")),
      change: num(q.change),
      time: q.last_time,
    }));
}

/* ---------------- 美债收益率历史曲线(近10年月度曲线: 本地存档 + 当年在线补充) ---------------- */
const TREASURY_CSV_COLS = {
  US3M: "3 Mo", US6M: "6 Mo", US1Y: "1 Yr", US2Y: "2 Yr", US3Y: "3 Yr",
  US5Y: "5 Yr", US7Y: "7 Yr", US10Y: "10 Yr", US20Y: "20 Yr", US30Y: "30 Yr",
};
// 完整年份官方存档随代码库分发(scripts/update-treasury-archive.cjs 生成), 数据不再变化
const TREASURY_ARCHIVE_DIR = path.join(__dirname, "treasury-rates");
let treasuryArchiveCache = null; // 解析一次, 进程内常驻

// 解析一年份 CSV 到 byMonth(首列 MM/DD/YYYY 降序; 每月首个命中即该月最后一个交易日)
function parseTreasuryCsv(text, byMonth) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.replace(/"/g, ""));
  const colIdx = Object.fromEntries(TREASURY_SYMBOLS.map((s) => [s, header.indexOf(TREASURY_CSV_COLS[s])]));
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const m = f[0].match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) continue;
    const key = `${m[3]}-${m[1]}`;
    if (byMonth.has(key)) continue;
    const yields = {};
    for (const s of TREASURY_SYMBOLS) {
      const idx = colIdx[s];
      if (idx >= 0) yields[s] = num(f[idx]); // 列缺失则缺省(前端要求全期限齐整才采用该曲线), 不静默造 0
    }
    byMonth.set(key, { date: `${m[3]}-${m[1]}-${m[2]}`, yields });
  }
}

function loadTreasuryArchive() {
  if (treasuryArchiveCache) return treasuryArchiveCache;
  const byMonth = new Map();
  try {
    for (const f of fs.readdirSync(TREASURY_ARCHIVE_DIR)) {
      if (!/^\d{4}\.csv$/.test(f)) continue;
      try {
        parseTreasuryCsv(fs.readFileSync(path.join(TREASURY_ARCHIVE_DIR, f), "utf-8"), byMonth);
      } catch (e) {
        console.error("[treasury-history] 存档解析失败:", f, e?.message || e);
      }
    }
    console.log(`[treasury-history] 本地存档加载: ${byMonth.size} 个月度曲线`);
  } catch (e) {
    console.error("[treasury-history] 存档目录读取失败:", e?.message || e);
  }
  treasuryArchiveCache = byMonth;
  return byMonth;
}

async function handleTreasuryHistory() {
  // 复制存档, 当年在线数据不污染常驻缓存
  const byMonth = new Map(loadTreasuryArchive());
  const year = new Date().getFullYear();
  // 当年数据仍在增长, 在线补充(跨境慢且不稳, 30s 超时; 失败时降级为纯存档)
  try {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&_format=csv`;
    parseTreasuryCsv(await fetchTextAny(url, { timeout: 30000 }), byMonth);
  } catch (e) {
    console.error(`[treasury-history] ${year} 在线拉取失败, 使用本地存档:`, e?.message || e);
  }
  // 存档全量返回(2001 年至今), 同期月份过滤与高亮由前端按当前月份处理
  const out = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => v);
  if (!out.length) throw new Error("treasury history unavailable");
  return out;
}

/* ---------------- TTL 缓存 + 并发合并(防上游限流) ---------------- */
const cache = new Map();
const CACHE_MAX = 2000; // 条目上限, 防止用户输入拼 key 导致无界增长

// 清理过期/失效条目(过期按各条目自身 ttl 判断)
function sweepCache() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (!v.inflight && (v.data === undefined || now - v.ts > (v.ttl || 60000))) cache.delete(k);
  }
}

// 写缓存: 超限先清过期项, 仍超则按 Map 插入序淘汰最旧条目
function cacheSet(key, entry) {
  if (cache.has(key)) cache.delete(key); // 重插以刷新插入序
  cache.set(key, entry);
  if (cache.size <= CACHE_MAX) return;
  sweepCache();
  while (cache.size > CACHE_MAX) {
    let oldest;
    for (const [k, v] of cache) {
      if (!v.inflight) { oldest = k; break; }
    }
    if (oldest === undefined) break; // 全部在途, 不再淘汰
    cache.delete(oldest);
  }
}

// 定时 sweep, unref 避免阻止进程退出
const cacheSweeper = setInterval(sweepCache, 60000);
cacheSweeper.unref();

async function cached(key, ttl, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    if (hit.data !== undefined && now - hit.ts < ttl) return hit.data;
    if (hit.inflight) return hit.inflight;
  }
  const inflight = fn()
    .then((data) => {
      cacheSet(key, { ts: Date.now(), data, inflight: null, ttl });
      return data;
    })
    .catch((e) => {
      const c = cache.get(key);
      cacheSet(key, { ts: c?.ts || 0, data: c?.data, inflight: null, ttl });
      if (c?.data !== undefined) return c.data; // 出错回退到旧数据
      throw e;
    });
  cacheSet(key, { ts: hit?.ts || 0, data: hit?.data, inflight, ttl });
  return inflight;
}

/* ---------------- 东财 财报数据(datacenter 公开 API, 无 Key) ---------------- */
// 统一走 fetch/curl 双通道, Referer 为东财数据中心
async function emDataGet(url) {
  const text = await fetchTextAny(url, { referer: "https://data.eastmoney.com/" });
  const j = JSON.parse(text);
  return j?.result?.data || [];
}

// 带分页元信息(页数): pageSize=1 时 pages 即总行数, 用于"已披露 N 家"
async function emDataPages(url) {
  const text = await fetchTextAny(url, { referer: "https://data.eastmoney.com/" });
  const j = JSON.parse(text);
  return j?.result?.pages || 0;
}

// sh600519/sz000001/bj430047 或裸 6 位 → SECUCODE(600519.SH); 6/9→SH, 0/2/3→SZ, 4/8→BJ
function secuCode(raw) {
  const m = String(raw || "").toLowerCase().match(/^(?:sh|sz|bj)?(\d{6})$/);
  if (!m) return null;
  const c = m[1];
  const ex = c[0] === "6" || c[0] === "9" ? "SH" : c[0] === "4" || c[0] === "8" ? "BJ" : "SZ";
  return `${c}.${ex}`;
}

// 按当前月份回推最近报告期: 1-3月→上年Q3, 4-6月→Q1, 7-9月→中报, 10-12月→Q3
function defaultReportPeriod() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (m <= 3) return `${y - 1}-09-30`;
  if (m <= 6) return `${y}-03-31`;
  if (m <= 9) return `${y}-06-30`;
  return `${y}-09-30`;
}

const validPeriod = (p) => (/^\d{4}-\d{2}-\d{2}$/.test(p || "") ? p : defaultReportPeriod());

// 单公司近 12 期主指标(F10)
async function handleFinanceMain(code) {
  const secu = secuCode(code);
  if (!secu) {
    // 入参校验失败属客户端错误, 带 status 让分发层回 400 而非 502
    const err = new Error(`bad code: ${code}`);
    err.status = 400;
    throw err;
  }
  const url =
    `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA` +
    `&columns=ALL&filter=${encodeURIComponent(`(SECUCODE="${secu}")`)}` +
    `&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  const rows = await emDataGet(url);
  return {
    name: rows[0]?.SECURITY_NAME_ABBR || "",
    reports: rows.map((r) => ({
      label: r.REPORT_DATE_NAME || "",
      date: String(r.REPORT_DATE || "").slice(0, 10),
      revenue: num(r.TOTALOPERATEREVE),
      netProfit: num(r.PARENTNETPROFIT),
      revenueYoY: num(r.TOTALOPERATEREVETZ),
      profitYoY: num(r.PARENTNETPROFITTZ),
      roe: num(r.ROEJQ),
      grossMargin: num(r.XSMLL),
      netMargin: num(r.XSJLL),
      debtRatio: num(r.ZCFZL),
      roic: num(r.ROIC),
      eps: num(r.EPSJB),
      ocfPerShare: num(r.MGJYXJJE),
    })),
  };
}

const finBoardUrl = (period, extra) =>
  `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL` +
  `&filter=${encodeURIComponent(`(REPORTDATE='${period}')`)}&pageNumber=1&sortTypes=-1&source=WEB&client=WEB&${extra}`;

// 宏观数据包: 个股盈利榜 TOP50 + 行业聚合 TOP15 + 披露日历 60 条(三次上游请求合并) + 已披露家数
async function handleFinanceBoard(period) {
  const [stockRows, indRows, calRows, disclosed] = await Promise.all([
    emDataGet(finBoardUrl(period, "sortColumns=PARENT_NETPROFIT&pageSize=50")),
    emDataGet(finBoardUrl(period, "sortColumns=PARENT_NETPROFIT&pageSize=500")),
    emDataGet(finBoardUrl(period, "sortColumns=NOTICE_DATE&pageSize=60")),
    emDataPages(finBoardUrl(period, "sortColumns=NOTICE_DATE&pageSize=1")),
  ]);
  const stocks = stockRows.map((r) => ({
    code: r.SECURITY_CODE || "",
    name: r.SECURITY_NAME_ABBR || "",
    industry: r.BOARD_NAME || "",
    netProfit: num(r.PARENT_NETPROFIT),
    profitYoY: num(r.SJLTZ),
    revenueYoY: num(r.YSTZ),
    roe: num(r.WEIGHTAVG_ROE),
    eps: num(r.BASIC_EPS),
  }));
  // 行业聚合: 净利润合计 + 家数 + 平均净利同比
  const agg = new Map();
  for (const r of indRows) {
    const k = r.BOARD_NAME || "其他";
    let a = agg.get(k);
    if (!a) { a = { name: k, netProfit: 0, count: 0, yoySum: 0, yoyN: 0 }; agg.set(k, a); }
    a.netProfit += num(r.PARENT_NETPROFIT);
    a.count += 1;
    if (Number.isFinite(parseFloat(r.SJLTZ))) { a.yoySum += num(r.SJLTZ); a.yoyN += 1; }
  }
  const industries = [...agg.values()]
    .sort((a, b) => b.netProfit - a.netProfit)
    .slice(0, 15)
    .map((a) => ({ name: a.name, netProfit: a.netProfit, count: a.count, yoy: a.yoyN ? +(a.yoySum / a.yoyN).toFixed(2) : 0 }));
  const calendar = calRows.map((r) => ({
    date: String(r.NOTICE_DATE || "").slice(0, 10),
    code: r.SECURITY_CODE || "",
    name: r.SECURITY_NAME_ABBR || "",
    period: r.QDATE || "",
  }));
  return { period, disclosed, stocks, industries, calendar };
}

// 业绩预告: 类型从 FORECASTCONTENT 提取, 统计预喜/预悲/不确定
const FORECAST_TYPES = ["预增", "预减", "扭亏", "首亏", "略增", "略减", "减亏", "增亏"];
const FORECAST_GOOD = new Set(["预增", "略增", "扭亏", "减亏"]);
const FORECAST_BAD = new Set(["预减", "略减", "首亏", "增亏"]);

async function handleFinanceForecast(period) {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_PUBLIC_OP_PREDICT&columns=ALL` +
    `&filter=${encodeURIComponent(`(REPORTDATE='${period}')`)}` +
    `&sortColumns=NOTICE_DATE&sortTypes=-1&pageSize=60&source=WEB&client=WEB`;
  const rows = await emDataGet(url);
  const items = rows.map((r) => {
    // 上游自带 FORECASTTYPE(预增/预减/扭亏/首亏/略增/略减/减亏/增亏/续盈/续亏), 缺失时从正文提取
    const content = String(r.FORECASTCONTENT || "");
    const type = String(r.FORECASTTYPE || "").trim() || FORECAST_TYPES.find((t) => content.includes(t)) || "不确定";
    return {
      date: String(r.NOTICE_DATE || "").slice(0, 10),
      code: r.SECURITY_CODE || "",
      name: r.SECURITY_NAME_ABBR || "",
      type,
      profitLow: num(r.FORECASTL),
      profitHigh: num(r.FORECASTT),
      yoyLow: num(r.INCREASEL),
      yoyHigh: num(r.INCREASET),
    };
  });
  const stats = { good: 0, bad: 0, neutral: 0 };
  for (const it of items) {
    if (FORECAST_GOOD.has(it.type)) stats.good += 1;
    else if (FORECAST_BAD.has(it.type)) stats.bad += 1;
    else stats.neutral += 1;
  }
  return { period, stats, items };
}

/* ---------------- OpenRouter 大模型 Token 消耗量(厂商聚合) ---------------- */
const OR_KEY = process.env.OPENROUTER_API_KEY || ""; // .env 已在文件顶部统一加载
const OR_DATA_FILE = path.join(__dirname, "data", "openrouter-usage.json");

const VENDOR_MAP = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google",
  deepseek: "DeepSeek", qwen: "通义千问", minimax: "MiniMax",
  "z-ai": "智谱GLM", moonshotai: "月之暗面", stepfun: "阶跃星辰",
  xiaomi: "小米", tencent: "腾讯", nvidia: "NVIDIA",
  "meta-llama": "Meta", mistralai: "Mistral", cohere: "Cohere", "x-ai": "xAI",
  poolside: "Poolside", meituan: "美团", "nex-agi": "nex-agi",
  inclusionai: "inclusionai", bytedance: "字节跳动", baai: "BAAI",
  perplexity: "Perplexity",
};

function vendorSlug(slug) {
  if (slug === "other") return "其他";
  const p = slug.split("/")[0];
  return VENDOR_MAP[p] || p;
}

const COUNTRY_MAP = {
  "腾讯":"🇨🇳中国","小米":"🇨🇳中国","DeepSeek":"🇨🇳中国","智谱GLM":"🇨🇳中国",
  "月之暗面":"🇨🇳中国","MiniMax":"🇨🇳中国","阶跃星辰":"🇨🇳中国","通义千问":"🇨🇳中国","美团":"🇨🇳中国","nex-agi":"🇨🇳中国","字节跳动":"🇨🇳中国","BAAI":"🇨🇳中国",
  "OpenAI":"🇺🇸美国","Anthropic":"🇺🇸美国","Google":"🇺🇸美国","Meta":"🇺🇸美国",
  "NVIDIA":"🇺🇸美国","xAI":"🇺🇸美国","Cohere":"🇺🇸美国","Poolside":"🇺🇸美国","inclusionai":"🇺🇸美国","Perplexity":"🇺🇸美国",
};

function country(name) { return COUNTRY_MAP[name] || "🌍其他"; }

async function handleOpenRouterUsage() {
  // 读取本地缓存（持久化存储，不断积累）
  let cached = [];
  try { cached = JSON.parse(fs.readFileSync(OR_DATA_FILE, "utf-8") || "[]"); } catch {}
  const cachedDates = new Set(cached.map((r) => r.date));

  // 确定需要拉取的日期范围
  const today = new Date();
  const todayStr = new Date(today - 86400000).toISOString().slice(0, 10); // API 数据至少次日才可用
  let fetchRanges = [];
  const earliest = "2025-01-01";
  if (cached.length === 0) {
    // 首次运行：分段拉取，每段不超过 366 天
    const maxSpan = 200;
    let s = new Date(earliest);
    while (s < today) {
      const e = new Date(s);
      e.setDate(e.getDate() + maxSpan - 1);
      const end = e < today ? e : new Date(today - 86400000);
      fetchRanges.push({ start: s.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
      s.setDate(s.getDate() + maxSpan);
    }
  } else {
    // 已有缓存：从最新数据次日开始，补到昨天
    const lastDate = cached.reduce((a, b) => a.date > b.date ? a : b).date;
    const nextDay = new Date(lastDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const start = nextDay.toISOString().slice(0, 10);
    if (start < todayStr) fetchRanges.push({ start, end: todayStr });
  }

  if (fetchRanges.length === 0) return cached;

  try {
    for (const { start, end } of fetchRanges) {
      const url = `https://openrouter.ai/api/v1/datasets/rankings-daily?start_date=${start}&end_date=${end}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${OR_KEY}`, Accept: "application/json" }, signal: AbortSignal.timeout(120000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${start}~${end}`);
      const body = await resp.json();
      const rows = body?.data || [];

      // 按日期+厂商聚合 token
      const byDV = {};
      for (const r of rows) {
        const dt = r.date, v = vendorSlug(r.model_permaslug);
        if (cachedDates.has(dt)) continue;
        if (!byDV[dt]) byDV[dt] = {};
        byDV[dt][v] = (byDV[dt][v] || 0n) + BigInt(Math.round(Number(r.total_tokens) || 0)); // 上游可能返回浮点/字符串, 直接 BigInt() 会 throw
      }

      for (const [dt, vMap] of Object.entries(byDV)) {
        const total = Object.values(vMap).reduce((a, b) => a + b, 0n);
        const providers = Object.entries(vMap).map(([name, tokens]) => ({
          name, tokens: Number(tokens),
          pct: Number((tokens * 10000n / total)) / 100,
        })).sort((a, b) => b.tokens - a.tokens);
        const byCountry = {};
        for (const p of providers) {
          const c = country(p.name);
          byCountry[c] = (byCountry[c] || 0n) + BigInt(p.tokens);
        }
        const countries = Object.entries(byCountry).map(([name, tokens]) => ({
          name, tokens: Number(tokens),
          pct: Number((tokens * 10000n / total)) / 100,
        })).sort((a, b) => b.tokens - a.tokens);
        cached.push({ date: dt, total: Number(total), providers, countries });
      }
    }

    cached.sort((a, b) => a.date.localeCompare(b.date));
    try {
      fs.mkdirSync(path.dirname(OR_DATA_FILE), { recursive: true });
      await fs.promises.writeFile(OR_DATA_FILE, JSON.stringify(cached)); // 异步写, 不阻塞事件循环
    } catch (e) {
      console.error("[or-usage] save error:", e?.message || e); // 落盘失败不影响主流程
    }
    return cached;
  } catch (e) {
    console.error("[or-usage] fetch error:", e?.message || e);
    if (cached.length) return cached;
    return [{ date: todayStr, total: 0, providers: [], countries: [] }];
  }
}
/* ---------------- 市场情绪折线数据本地存储与容错 ---------------- */
// 本地持久化目录: server/data/market-sentiment/
//   snapshot.json: 最近一次成功刷新的完整面板快照(供实时失败时回退)
//   涨跌停趋势(250日历史)已迁移至 SQLite 库 market_trend 表(见 stock-db.cjs)
const MS_DATA_DIR = path.join(__dirname, "data", "market-sentiment");
const MS_TREND_FILE = path.join(MS_DATA_DIR, "trend.json"); // 仅作一次性迁移来源
const MS_SNAPSHOT_FILE = path.join(MS_DATA_DIR, "snapshot.json");
const MS_TREND_MAX = 250; // 上游 raw_data 最多约250个交易日, 上限即一份完整年度记录

function loadMsSnapshot() {
  try { return JSON.parse(fs.readFileSync(MS_SNAPSHOT_FILE, "utf-8") || "null"); } catch { return null; }
}
// 启动迁移: 若 SQLite 趋势表为空而旧 trend.json 存在, 一次性导入历史, 之后趋势完全走数据库
function migrateMsTrendIfNeeded() {
  try {
    if (trendCount() > 0) return;
    const legacy = JSON.parse(fs.readFileSync(MS_TREND_FILE, "utf-8") || "[]");
    if (!Array.isArray(legacy) || !legacy.length) return;
    const recs = legacy.filter((r) => r && r.date).map((r) => ({
      date: r.date, limitUp: r.limitUp, limitDown: r.limitDown, brokenUp: r.brokenUp, blownUp: r.blownUp, blownRate: r.blownRate,
    }));
    upsertTrends(recs);
    console.log(`[ms-trend] 已从 trend.json 迁移 ${recs.length} 条历史到 SQLite market_trend`);
  } catch (e) { console.error("[ms-trend] migrate error:", e?.message || e); }
}
migrateMsTrendIfNeeded();
// 将上游 raw_data 合并进 SQLite: 仅更新/新增当日及变化记录(历史不变行由 UPSERT 去重, 开销极小)
// 炸板口径: raw_data 第5字段 r[5] 即"炸板家数", 且 炸板率 = r[5]/(涨停数 + r[5]) 与上游自洽(已验证8天)
// 注意 r[3](blown_limit_up_count) 今日异常为0虽率9.8%, 与率无关, 不得采用
function mergeMsTrend(rawData) {
  if (!Array.isArray(rawData) || !rawData.length) return getTrends();
  const recs = [];
  for (const r of rawData) {
    const date = r && r[6];
    if (!date) continue;
    recs.push({ date, limitUp: r[0] || 0, limitDown: r[1] || 0, brokenUp: r[2] || 0, blownUp: r[5] || 0, blownRate: r[4] });
  }
  if (!recs.length) return getTrends();
  upsertTrends(recs);
  return getTrends();
}
// 保存最近一次成功刷新快照(实时持久化)
function saveMsSnapshot(payload) {
  try { fs.mkdirSync(MS_DATA_DIR, { recursive: true }); fs.writeFileSync(MS_SNAPSHOT_FILE, JSON.stringify({ savedAt: Date.now(), payload }), "utf-8"); }
  catch (e) { console.error("[ms-snapshot] write error:", e?.message || e); }
}
// 从 SQLite 构建趋势数据: 取最近半年(130个交易日), 最新日期在前(与前端 reversed 预期一致)
function msTrendFromStore() {
  const asc = getTrends();
  return asc.slice(-130).reverse();
}
// 市场情绪数据完全不可用时的兜底结构, 保证前端整体不受影响
function msFallbackPayload() {
  return {
    dataSuccess: false, fromCache: true,
    error: "市场情绪数据不可用(实时获取失败且无本地快照), 返回空结构以免影响页面",
    mood: { upCount: 0, downCount: 0, limitUp: 0, limitDown: 0, turnover: 0, prevTurnover: 0, ratio: 1, marketColor: 0, totalCount: 0, upRatio: 0, downRatio: 0, turnoverChange: 0, volLevel: "" },
    sentiment: { sentimentScore: 0, sentimentLevel: "", sentimentDesc: "" },
    ladder: { date: "", firstBoard: 0, secondBoard: 0, thirdBoard: 0, highBoard: 0, ladderRate: 0, brokenRate: 0, yestLimitUpPerf: 0, yestLadderPerf: 0, yestBrokenPerf: 0, comment: "", trend: [] },
    riseFall: { limitUpCount: 0, limitDownCount: 0, blownLimitUpCount: 0, brokenLimitUpCount: 0, blownLimitUpRate: 0, yesterdayLimitUpPerf: 0, yesterdayBrokenPerf: 0, date: "", trendData: [] },
  };
}

/* ---------------- 市场情绪v2: 基于 kpl 三接口 (mood / sentiment-indicator / rise-fall) ---------------- */
// 降API压力优化: rise-fall 返回的 250 日历史趋势 + 昨日表现是"每日变化"的低频数据,
// 不必随 mood 每 15s 轮询; 用较长 TTL 缓存(5min)解耦, 约 20 倍削减该接口调用量。
// 实时涨停/跌停家数已由 mood API 提供, 不受影响。cached 失败会自动回退旧数据。
const MS_RISE_FALL_TTL = 5 * 60 * 1000; // 5 分钟
// 实时炸板(ladder/broken): 日度聚合关闭盘中, 需按较短 TTL 轮询才能随涨停/炸板变化
const MS_BROKEN_TTL = 20 * 1000; // 20 秒

/* ---------------- 连板梯队(东财涨停池): 取代原 kpl limit-up-ladder ----------------
 * 数据源: 东方财富涨停/炸板池(push2ex.getTopicZTPool/ZBPool), 支持历史日期 YYYYMMDD,
 * 按日统计连板梯队(一板/二板/三板/高度板/连板率/炸板率), 落库 ladder_trend 表供趋势图。
 * 注: 「昨日涨停今表现」等日度聚合口径东财不直接提供, 置空(0), 不影响梯队结构展示。 */
const EM_UT = "7eea3edcaed734bea9cbfc24409ed989"; // push2ex 校验码(客户端固定)
const EM_HIS = "https://push2his.eastmoney.com/api/qt/stock"; // 历史K线(需 ipv4first + fetch重试)
const UT_KLINE = "fa5fd1943c7b386f172d6893dbfba10b"; // push2his kline 校验码

/** push2his 历史接口(fetch + 重试, 不回退 curl: schannel 在此域名握手失败) */
async function emGetHis(url, tries = 5) {
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
      await sleep(500 * (i + 1)); // 递增退避, 兼容 push2his 间歇性断连
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 全市场涨跌家数(上证+深证聚合 f104/f105/f106) */
async function emBreadthNow() {
  const j = await emGet("https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001&fields=f104,f105,f106&np=1&fltt=2&invt=2");
  const diff = j?.data?.diff || [];
  const sum = (f) => diff.reduce((a, b) => a + (Number(b[f]) || 0), 0);
  return { up: sum("f104"), down: sum("f105"), flat: sum("f106") };
}

/** 两市成交额(万元): 前端 fmtTurnover 按"万"口径显示(v/10000=亿)。
 *  今日+昨日: push2his 指数日K 一次取两根(口径一致, 元/10000=万);
 *  push2his 全挂时回退 ulist 今日成交额(元/10000=万)。 */
async function emTurnoverPair() {
  let today = 0, yesterday = 0;
  for (const secid of ["1.000001", "0.399001"]) {
    try {
      const kj = await emGetHis(`${EM_HIS}/kline/get?secid=${secid}&ut=${UT_KLINE}&klt=101&fqt=1&end=20500101&lmt=3&fields1=f1,f2,f3&fields2=f51,f53,f57`);
      const klines = kj?.data?.klines || [];
      if (klines.length >= 1) today += (Number(klines[klines.length - 1].split(",")[2]) || 0) / 10000; // 今日 f57(元)→万
      if (klines.length >= 2) yesterday += (Number(klines[klines.length - 2].split(",")[2]) || 0) / 10000; // 昨日
    } catch (e) { /* 单指数失败降级 */ }
  }
  if (!today) {
    try {
      const j = await emGet("https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001&fields=f6,f12&np=1&fltt=2&invt=2");
      today = (j?.data?.diff || []).reduce((a, b) => a + (Number(b.f6) || 0), 0) / 10000;
    } catch { today = 0; }
  }
  return { today, yesterday };
}

/** 行业板块主力净额榜(clist f62 降序, 前 20) → [[name, netIn]] */
async function emBoardFlowList() {
  const url = `https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=20&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("m:90+t:2")}&fields=f12,f14,f62`;
  const j = await emGet(url).catch(() => null);
  return (j?.data?.diff || []).map((b) => [b.f14, num(b.f62)]);
}

/** 概念板块涨幅榜(clist f3 降序, 前 20) → [{name, pct}](位置越靠前越热) */
async function emConceptRiseList() {
  const url = `https://push2delay.eastmoney.com/api/qt/clist/get?fid=f3&po=1&pz=20&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent("m:90+t:3")}&fields=f12,f14,f3`;
  const j = await emGet(url).catch(() => null);
  return (j?.data?.diff || []).map((b) => ({ name: b.f14, pct: num(b.f3) }));
}

/** 抓取东财涨停/炸板/跌停池; kind ∈ {ZTPool, ZBPool, DTPool}; ymd = YYYYMMDD(支持历史日期) */
async function emTopicPool(kind, ymd) {
  const url = `https://push2ex.eastmoney.com/getTopic${kind}?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${ymd}`;
  const j = await emGet(url).catch((e) => { console.error(`[philia] emTopicPool ${kind}(${ymd}) failed:`, e.message); return null; });
  if (!j || !j.data) return null;
  const pool = Array.isArray(j.data.pool) ? j.data.pool : [];
  return { count: typeof j.data.tc === "number" ? j.data.tc : pool.length, pool };
}

/** 从涨停池统计连板梯队(一板/二板/三板/高度板/最高连板/连板率) */
function ladderFromPool(pool) {
  const counts = new Map();
  for (const s of pool || []) {
    const l = s.lbc || s.zttj?.days || 1;
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  const get = (n) => counts.get(n) || 0;
  const total = (pool || []).length || 1;
  const highBoard = [...counts.entries()].reduce((a, b) => (a > b[0] ? a : b[0]), 1);
  return {
    firstBoard: get(1), secondBoard: get(2), thirdBoard: get(3),
    highBoard: get(highBoard), 最高连板: highBoard,
    ladderRate: Math.round(((total - get(1)) / total) * 1000) / 10,
  };
}

const MS_LADDER_TTL = 5 * 60 * 1000; // 日度数据低频, 5min 缓存
const LADDER_BACKFILL_DAYS = 12;      // 趋势图回填最近交易日数
const LADDER_CONCURRENCY = 3;         // 回源并发上限, 控制慢速上游压力

/** 最近 n 个交易日(跳过周末), 返回按日期倒序 */
function lastTradingDays(n) {
  const days = [];
  const d = new Date();
  while (days.length < n) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    d.setDate(d.getDate() - 1);
  }
  return days;
}

/** 拉取单日连板梯队记录(东财涨停池+炸板池统计), 无数据返回 null */
async function fetchLadderDay(date, { timeout = 15000 } = {}) {
  const ymd = String(date).replace(/-/g, "");
  const [zt, zb] = await Promise.allSettled([
    emTopicPool("ZTPool", ymd),
    emTopicPool("ZBPool", ymd),
  ]);
  const ztPool = zt.status === "fulfilled" ? zt.value?.pool : null;
  const zbPool = zb.status === "fulfilled" ? zb.value?.pool : null;
  if (!Array.isArray(ztPool)) return null;
  const lad = ladderFromPool(ztPool);
  const zbN = Array.isArray(zbPool) ? zbPool.length : 0;
  const blownRate = ztPool.length + zbN > 0 ? Math.round((zbN / (ztPool.length + zbN)) * 1000) / 10 : 0;
  return {
    "日期": date,
    "一板": lad.firstBoard,
    "二板": lad.secondBoard,
    "三板": lad.thirdBoard,
    "高度板": lad.highBoard,
    "连板率(%)": lad.ladderRate,
    "今日涨停破板率(%)": blownRate,
    "昨日涨停今表现(%)": "",
    "昨日连板今表现(%)": "",
    "昨日破板今表现(%)": "",
    "市场评价": `最高${lad.最高连板}板`,
  };
}

/** 上游原始字段 -> 归一化记录(供 DB 落库与前端) */
function toLadderRow(raw) {
  if (!raw) return null;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  return {
    date: String(raw["日期"] || ""),
    firstBoard: Math.round(num(raw["一板"])),
    secondBoard: Math.round(num(raw["二板"])),
    thirdBoard: Math.round(num(raw["三板"])),
    highBoard: Math.round(num(raw["高度板"])),
    ladderRate: num(raw["连板率(%)"]),
    blownRate: num(raw["今日涨停破板率(%)"]),
    yestLimitUpPerf: num(raw["昨日涨停今表现(%)"]),
    yestLadderPerf: num(raw["昨日连板今表现(%)"]),
    yestBrokenPerf: num(raw["昨日破板今表现(%)"]),
    comment: String(raw["市场评价"] || ""),
  };
}

/** 有限并发批量回源(控制对慢速上游的压力) */
async function mapLimitConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i]); } catch { results[i] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

/** 构建连板梯队: 回填最近若干交易日到 DB, 返回最新可用汇总 + 趋势 */
async function buildLadder() {
  const days = lastTradingDays(LADDER_BACKFILL_DAYS);
  const existing = getLadderTrend();
  const byDate = new Map(existing.map((r) => [r.date, r]));
  const now = Date.now();
  // 仅回源 DB 缺失或已过期的日期(稳态下只有当日, 其余走 DB)
  const missing = days.filter((d) => {
    const e = byDate.get(d);
    return !e || now - (e.updatedAt || 0) > MS_LADDER_TTL;
  });
  if (missing.length) {
    const fresh = await mapLimitConcurrent(missing, LADDER_CONCURRENCY, (date) => fetchLadderDay(date));
    const rows = fresh.filter(Boolean).map(toLadderRow).filter((r) => r.date);
    if (rows.length) upsertLadderTrends(rows);
  }
  const all = getLadderTrend(); // 全量(升序)
  const nonEmpty = all.filter((r) => r.firstBoard != null);
  const latest = nonEmpty[nonEmpty.length - 1];
  return {
    current: latest ? toLadderRow({ "日期": latest.date, "一板": latest.firstBoard, "二板": latest.secondBoard, "三板": latest.thirdBoard, "高度板": latest.highBoard, "连板率(%)": latest.ladderRate, "今日涨停破板率(%)": latest.blownRate, "昨日涨停今表现(%)": latest.yestLimitUpPerf, "昨日连板今表现(%)": latest.yestLadderPerf, "昨日破板今表现(%)": latest.yestBrokenPerf, "市场评价": latest.comment }) : null,
    trend: all.slice(-LADDER_BACKFILL_DAYS).reverse(),
  };
}
// 市场情绪轮询时段: 每日 08:59 - 15:00(收盘)。15:00 后停止轮询并定格数据, 次日 08:59 自动恢复。
// 返回 { active, state, label } state = "polling" | "stopped"
function marketSentimentPollState(now = new Date()) {
  if (process.env.MS_FORCE_ACTIVE === "1") return { active: true, state: "polling", label: "轮询中(强制)" }; // 运维/测试: 强制走实时轮询
  const m = now.getHours() * 60 + now.getMinutes();
  const start = 8 * 60 + 59; // 08:59
  const end = 15 * 60;       // 15:00
  const active = m >= start && m < end;
  return { active, state: active ? "polling" : "stopped", label: active ? "轮询中" : "已停止" };
}
// 收盘定格: 15:00 后把当日最后一次成功数据持久化为离线快照(存 SQLite meta).
// 用 meta 键去重, 每天仅落一次; 开盘拿到新数据后由 handleMarketSentimentV2 清除。
function scheduleMsDaily() {
  const tryCapture = () => {
    try {
      const ps = marketSentimentPollState();
      if (ps.active) return; // 轮询时段: 数据由实时轮询负责, 无需离线快照
      const off = loadMsOffline();
      if (off && off.date === new Date().toISOString().slice(0, 10)) return; // 今日已保存
      const snap = loadMsSnapshot();
      if (snap) {
        saveMsOffline(snap.payload || snap);
        console.log(`[ms-daily] 收盘定格已保存 ${off ? "overwrite" : "new"} (${new Date().toLocaleString("zh-CN")})`);
      }
    } catch (e) { console.error("[ms-daily] error:", e?.message || e); }
  };
  tryCapture();
  setInterval(tryCapture, 30 * 1000).unref();
}
async function handleMarketSentimentV2() {
  const ps = marketSentimentPollState();
  // 收盘(15:00后): 停止轮询, 直接返回定格快照, 不请求上游 KPL
  if (!ps.active) {
    const off = loadMsOffline();
    const last = off?.payload || loadMsSnapshot()?.payload;
    if (last) return { ...last, dataSuccess: true, fromCache: true, pollState: "stopped" };
    return { ...msFallbackPayload(), pollState: "stopped" };
  }
  try {
    // 东财数据源(替代原 kpl mood/rise-fall/ladder-broken):
    //   - 涨跌家数: 上证+深证聚合 f104/f105/f106
    //   - 涨停/跌停/炸板: push2ex 涨停池/跌停池/炸板池(实时)
    //   - 量能: 两市成交额 今日 ulist + 昨日 push2his 日K(5min 缓存)
    //   - 连板梯队: buildLadder(东财涨停池统计, 落库 ladder_trend)
    const todayYmd = todayStr();
    const results = await Promise.allSettled([
      emBreadthNow(),
      emTopicPool("ZTPool", todayYmd),
      emTopicPool("DTPool", todayYmd),
      emTopicPool("ZBPool", todayYmd),
      buildLadder(),
      cached("em-turnover", 5 * 60 * 1000, () => emTurnoverPair()),
    ]);

    const breadth = results[0].status === "fulfilled" ? results[0].value : null;
    const ztPool = results[1].status === "fulfilled" ? results[1].value : null;
    const dtPool = results[2].status === "fulfilled" ? results[2].value : null;
    const zbPool = results[3].status === "fulfilled" ? results[3].value : null;
    const ladder = results[4].status === "fulfilled" ? results[4].value : { current: null, trend: [] };
    const turnoverPair = results[5].status === "fulfilled" ? results[5].value : null;

    // 核心数据(涨跌家数/涨停池)全部失败时: 回退到日内最后一次成功快照
    if (!breadth && !ztPool) {
      console.error("[market-sentiment-v2] em data failed, results:", results.map(r => r.status));
      const snap = loadMsSnapshot();
      if (snap) return { ...snap, fromCache: true, refetch: "fallback-snapshot" };
      return msFallbackPayload();
    }

    // --- mood ---
    const upCount = breadth?.up ?? 0;
    const downCount = breadth?.down ?? 0;
    const limitUp = ztPool?.count ?? (ztPool?.pool ? ztPool.pool.length : 0);
    const limitDown = dtPool?.count ?? (dtPool?.pool ? dtPool.pool.length : 0);
    const turnover = turnoverPair?.today ?? 0;
    const prevTurnover = turnoverPair?.yesterday ?? 0;
    const ratio = downCount > 0 ? (upCount / downCount) : 1;
    const marketColor = upCount >= downCount ? 1 : 0;
    const totalCount = upCount + downCount;
    const upRatio = totalCount > 0 ? (upCount / totalCount * 100) : 50;

    // 市场情绪评分 (0-100)
    const sentimentScore = Math.min(100, Math.max(0, Math.round(upRatio)));
    let sentimentLevel, sentimentDesc;
    if (sentimentScore >= 75) { sentimentLevel = "极强"; sentimentDesc = "市场情绪高涨"; }
    else if (sentimentScore >= 60) { sentimentLevel = "偏强"; sentimentDesc = "市场情绪乐观"; }
    else if (sentimentScore >= 45) { sentimentLevel = "震荡"; sentimentDesc = "市场情绪平稳"; }
    else if (sentimentScore >= 30) { sentimentLevel = "偏弱"; sentimentDesc = "市场情绪低迷"; }
    else { sentimentLevel = "极弱"; sentimentDesc = "市场情绪恐慌"; }

    // 量能变化
    const turnoverChange = prevTurnover > 0 ? ((turnover - prevTurnover) / prevTurnover * 100) : 0;
    let volLevel;
    if (turnoverChange >= 20) volLevel = "放量";
    else if (turnoverChange >= 5) volLevel = "温和放量";
    else if (turnoverChange >= -5) volLevel = "正常";
    else if (turnoverChange >= -20) volLevel = "温和缩量";
    else volLevel = "缩量";

    // 今日实时趋势点写入 market_trend(积累趋势; 炸板率 = 炸板/(涨停+炸板))
    const blownLimitUpCount = zbPool?.pool ? zbPool.pool.length : 0;
    const blownLimitUpRate = (limitUp + blownLimitUpCount) > 0 ? Math.round((blownLimitUpCount / (limitUp + blownLimitUpCount)) * 1000) / 10 : 0;
    const today = dashToday();
    upsertTrends([{ date: today, limitUp, limitDown, brokenUp: blownLimitUpCount, blownUp: blownLimitUpCount, blownRate: blownLimitUpRate }]);
    const trendData = msTrendFromStore();
    // 覆写今日实时点(消除"延后一天"感知)
    if (Array.isArray(trendData)) {
      const realtime = { limitUp, limitDown, blownUp: blownLimitUpCount, blownRate: blownLimitUpRate };
      const first = trendData[0];
      if (first && first.date === today) {
        trendData[0] = { ...first, ...realtime, date: today };
      } else {
        trendData.unshift({ date: today, ...realtime });
      }
    }

    const payload = {
      dataSuccess: true,
      mood: {
        upCount, downCount, limitUp, limitDown,
        turnover, prevTurnover, ratio, marketColor,
        totalCount, upRatio: Math.round(upRatio * 10) / 10,
        downRatio: totalCount > 0 ? Math.round((downCount / totalCount * 100) * 10) / 10 : 0,
        turnoverChange: Math.round(turnoverChange * 10) / 10,
        volLevel,
      },
      sentiment: {
        sentimentScore, sentimentLevel, sentimentDesc,
      },
      ladder: {
        date: ladder?.current?.date || "",
        firstBoard: ladder?.current?.firstBoard ?? 0,
        secondBoard: ladder?.current?.secondBoard ?? 0,
        thirdBoard: ladder?.current?.thirdBoard ?? 0,
        highBoard: ladder?.current?.highBoard ?? 0,
        ladderRate: ladder?.current?.ladderRate ?? 0,
        brokenRate: ladder?.current?.blownRate ?? 0,
        yestLimitUpPerf: ladder?.current?.yestLimitUpPerf ?? 0,
        yestLadderPerf: ladder?.current?.yestLadderPerf ?? 0,
        yestBrokenPerf: ladder?.current?.yestBrokenPerf ?? 0,
        comment: ladder?.current?.comment || "",
        trend: ladder?.trend || [],
      },
      riseFall: {
        limitUpCount: limitUp,
        limitDownCount: limitDown,
        blownLimitUpCount,
        brokenLimitUpCount: blownLimitUpCount,
        blownLimitUpRate,
        yesterdayLimitUpPerf: 0,
        yesterdayBrokenPerf: 0,
        date: today,
        trendData,
      },
    };
    // 保存最近一次成功快照(实时持久化, 供失败时回退)
    saveMsSnapshot(payload);
    // 开盘拿到实时新数据: 清除前一日收盘定格的离线快照
    if (loadMsOffline()) { clearMsOffline(); console.log("[ms-daily] 已清除前一日离线定格数据"); }
    return { ...payload, pollState: "polling" };
  } catch (e) {
    console.error("[market-sentiment-v2] kpl error:", e.message);
    // 实时加载失败: 回退到日内最后一次成功刷新数据
    const snap = loadMsSnapshot();
    if (snap) return { ...snap, fromCache: true, refetch: "fallback-snapshot", pollState: "polling" };
    return { ...msFallbackPayload(), pollState: "polling" };
  }
}

/* ---------------- 市场情绪新闻: 基于同花顺 THS 网关 news (替代原 kpl news-flash) ---------------- */
async function handleNewsAnalystKPL() {
  try {
    const j = await thsFetch("/api/ths/news", {}, 10000);
    const items = j?.success ? (j.data || []) : [];
    if (!items.length) {
      return { success: true, fetchTime: new Date().toISOString(), platformStats: { success: 0, total: 0 }, flowData: null, sentimentData: null, hotTopics: [], stockNews: [] };
    }
    // 提取关键词做情绪分析
    const positiveKw = ["涨", "升", "增", "利好", "突破", "创新高", "反弹", "放量", "拉升", "资金流入"];
    const negativeKw = ["跌", "降", "减", "利空", "破位", "新低", "回调", "缩量", "流出", "风险"];
    let posCount = 0, negCount = 0;
    const stockNews = items.map(item => {
      const title = item.Title || "";
      // 来源: thsdk news 的 Properties 中 source=xxx
      const src = (String(item.Properties || "").match(/source=([^\n]+)/) || [])[1] || "同花顺";
      let score = 0;
      for (const kw of positiveKw) { if (title.includes(kw)) score += 10; }
      for (const kw of negativeKw) { if (title.includes(kw)) score -= 10; }
      if (score > 0) posCount++;
      else if (score < 0) negCount++;
      return {
        platform: src.trim(),
        category: "",
        title,
        content: title,
        matchedKeywords: [],
        score,
      };
    });
    const total = items.length;
    const sentimentIndex = total > 0 ? Math.round((posCount / total) * 100) : 50;
    const sentimentClass = sentimentIndex >= 60 ? "乐观" : sentimentIndex >= 40 ? "中性" : "悲观";
    // 提取热门话题(按标题关键词聚类, thsdk news 无板块字段, 按证券代码聚类兜底)
    const topicMap = {};
    for (const item of items) {
      const name = String(item.Stock || item.Code || "").trim();
      if (name) topicMap[name] = (topicMap[name] || 0) + 1;
    }
    const hotTopics = Object.entries(topicMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count, heat: Math.round(count / total * 100), crossPlatform: 1, sources: ["同花顺"] }));
    return {
      success: true,
      fetchTime: new Date().toISOString(),
      platformStats: { success: items.length > 0 ? 1 : 0, total: 1 },
      flowData: {
        totalScore: posCount + negCount + 500,
        socialScore: Math.round(posCount * 40 + 100),
        newsScore: Math.round(negCount * 30 + 100),
        financeScore: Math.round((posCount + negCount) * 20 + 100),
        techScore: Math.round(hotTopics.length * 15 + 50),
        level: sentimentClass,
        analysis: `共${total}条快讯，积极${posCount}条，消极${negCount}条`,
        platformDetails: [{ platform: "ths", name: "同花顺快讯", category: "快讯", count: total, score: sentimentIndex }],
      },
      sentimentData: { sentimentIndex, sentimentClass, flowFactor: 0, financeFactor: 0, keywordFactor: sentimentIndex, positiveCount: posCount, negativeCount: negCount },
      hotTopics,
      stockNews,
    };
  } catch (e) {
    console.error("[news-analyst] ths error:", e.message);
    return { success: false, error: e.message };
  }
}

/* ---------------- 股票搜索(名称/拼音首字母→代码) ---------------- */
async function handleStockSearch(query) {
  if (!query || query.length < 1) return [];
  // THS 主源: search_symbols(替代新浪 suggest, 免 GBK 解析与 WAF 拦截); 失败回退新浪
  try {
    const j = await thsThrottled("/api/ths/search", { q: query }, { timeout: 6000, retries: 1 });
    if (j?.success && j.data?.length) {
      const out = [];
      for (const s of j.data) {
        const sym = thsSymbolOf(s["THSCODE"] || s["代码"] || "");
        if (!sym) continue; // 仅保留 A股(sh/sz/bj)
        out.push({ code: sym, name: String(s["名称"] || s["Name"] || ""), pinyin: "" });
      }
      if (out.length) return out.slice(0, 10);
    }
  } catch (e) { console.error(`[ths-search] ${query} error:`, e?.message || e); }
  const url = `https://suggest3.sinajs.cn/suggest/type=&key=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const buf = await resp.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buf);
  const m = text.match(/suggestvalue="([^"]+)"/);
  if (!m) return [];
  // 格式: name,type,code,fullCode,pinyin,...;
  const results = [];
  for (const part of m[1].split(";")) {
    const f = part.split(",");
    if (f.length >= 4 && /^(sh|sz|bj)\d{6}$/.test(f[3])) {
      results.push({ code: f[3], name: f[0], pinyin: f[4] || "" });
    }
  }
  return results.slice(0, 10);
}

/* ---------------- 风口聚合: 基于 kpl.liuhepc.cn 多接口 dims 聚合 ---------------- */
// 风口关键词归一化: 同义词 -> 规范风口名
const FENK_SYNONYMS = {
  算力: ["算力", "算力租赁", "算力概念", "算力网", "算力网络", "算力服务", "算力调度"],
  芯片: ["芯片", "芯片概念", "半导体", "半导体概念", "存储芯片", "磷化铟", "半导体设备"],
  医药: ["医药", "医药生物", "医药概念", "创新药", "创新药概念", "CRO", "CDMO", "减肥药", "GLP-1", "生物医药", "生物医药概念", "病毒防治", "中药", "中药概念"],
  机器人: ["机器人", "机器人概念", "人形机器人", "机器人产业链", "机器人减速器", "减速器"],
  通信: ["通信", "通信概念", "光模块", "光模块概念", "光通信", "光器件", "5G", "CPO", "共封装光学"],
  人工智能: ["人工智能", "人工智能概念", "AI", "AI概念", "AI应用", "AI医疗", "AI安全", "端侧AI", "AI算力"],
  核电: ["核电", "核电概念", "核能", "核工业", "铀"],
  脑机接口: ["脑机接口", "脑机"],
  游戏: ["游戏", "游戏概念", "网游"],
  有色金属: ["有色金属", "有色金属概念", "金属钨", "金属锗", "小金属", "小金属概念", "稀土永磁", "稀土", "铜", "铜缆", "覆盖铜"],
  光伏: ["光伏", "光伏概念", "太阳能", "光伏储能"],
  新能源汽车: ["新能源汽车", "新能源车", "汽车电子", "汽车零部件", "汽车整车", "整车", "车载芯片", "汽车芯片"],
  军工: ["军工", "军工概念", "国防军工", "军工电子", "军工信息化"],
  量子科技: ["量子科技", "量子通信", "量子计算", "量子信息"],
  云计算: ["云计算", "云计算概念", "数据中心", "数据中心概念", "液冷", "液冷服务器", "数据中心液冷"],
  存储: ["存储", "存储概念", "存储芯片", "HBM"],
  电力: ["电力", "电力概念", "特高压", "电网设备", "智能电网", "电网", "电网改革", "绿色电力", "绿电"],
  MLCC: ["MLCC", "MLCC概念", "被动元件", "电容"],
  光刻机: ["光刻机", "光刻机概念", "光刻胶", "光刻胶概念"],
  纺织: ["纺织", "服装家纺", "纺织制造", "纺织服装", "服装", "家纺"],
  虚拟现实: ["虚拟现实", "VR", "AR", "元宇宙", "虚拟人"],
  数字经济: ["数字经济", "数字科技", "数字中国"],
  卫星导航: ["卫星导航", "卫星互联网", "商业航天", "卫星", "航空航天", "大飞机"],
  低空经济: ["低空经济", "飞行汽车", "eVTOL"],
  数据要素: ["数据要素", "数据确权", "数据资产", "数据", "大数据", "大数据概念"],
  氢能源: ["氢能源", "氢能", "氢能概念", "氢燃料电池", "电解槽", "燃料电池", "燃料电池概念"],
  固态电池: ["固态电池", "固态电池概念"],
  充电桩: ["充电桩", "充电桩概念", "换电", "充电", "充电设施"],
  储能: ["储能", "储能概念"],
  风电: ["风电", "风电概念", "海上风电", "风力发电"],
  软件: ["软件", "软件概念", "国产软件", "信创", "信创概念", "操作系统"],
  金融科技: ["金融科技", "互联网金融", "证券", "券商", "证券概念", "银行", "银行概念", "保险", "保险概念"],
  区块链: ["区块链", "区块链概念", "数字货币", "数字货币概念", "Web3"],
  在线教育: ["在线教育", "教育科技"],
  农业: ["农业", "种业", "乡村振兴", "农业信息化", "数字农业"],
  石油: ["石油", "石油概念", "油气", "油气开采"],
  天然气: ["天然气", "天然气概念", "LNG"],
  煤炭: ["煤炭", "煤炭概念", "煤化工"],
  化工: ["化工", "化工概念", "氟化工", "磷化工"],
  体育产业: ["体育产业", "体育", "体育概念"],
  医美: ["医美", "医美概念"],
  贵金属: ["贵金属", "黄金", "白银"],
  跨境电商: ["跨境电商", "跨境支付"],
  高送转: ["高送转", "送转预期"],
  次新股: ["次新股", "次新"],
  股权转让: ["股权转让", "股权变更"],
  重组: ["并购重组", "重大资产重组", "股权重组", "并购", "重组"],
  文化传媒: ["文化传媒", "影视", "出版", "传媒", "传媒概念"],
  旅游: ["旅游", "景区", "酒店餐饮"],
  海南: ["海南", "海南自贸港"],
  深圳: ["深圳", "深圳国资"],
  医疗器械: ["医疗器械", "医疗器械概念", "医疗设备"],
  医疗服务: ["医疗服务", "民营医院"],
  生物疫苗: ["生物疫苗", "疫苗"],
  锂电池: ["锂电池", "锂电池概念", "锂电", "锂矿"],
  新能源: ["新能源", "新能源概念"],
  智能驾驶: ["智能驾驶", "智能驾驶概念", "自动驾驶", "无人驾驶", "汽车智能化", "智能座舱"],
  伺服: ["伺服", "伺服电机"],
  传感器: ["传感器", "MEMS"],
  网络安全: ["网络安全", "网络安全概念", "信息安全"],
  半导体材料: ["半导体材料", "半导体材料概念", "电子特气", "电子特气概念"],
  电子化学品: ["电子化学品", "光刻胶概念"],
  面板: ["面板", "面板概念", "OLED", "LCD"],
  消费电子: ["消费电子", "消费电子概念", "智能穿戴", "智能穿戴概念", "AR眼镜"],
  华为: ["华为", "华为概念", "华为产业链", "华为海思"],
  苹果: ["苹果", "苹果概念", "苹果产业链"],
  特斯拉: ["特斯拉", "特斯拉概念"],
  英伟达: ["英伟达", "英伟达概念"],
  印刷电路板: ["印刷电路板", "PCB", "覆铜板", "覆铜板概念"],
  智能穿戴: ["智能穿戴", "可穿戴"],
  封装: ["封装", "封装概念", "芯片封测", "封测概念"],
  晶圆: ["晶圆", "晶圆概念"],
  集成电路: ["集成电路", "集成电路概念", "芯片设计", "芯片设计概念"],
  第三代半导体: ["第三代半导体", "第三代半导体概念", "功率半导体"],
  钢铁: ["钢铁", "钢铁概念"],
  基建: ["基建", "基建概念", "基础建设"],
  房地产: ["房地产", "地产", "房地产概念"],
  白酒: ["白酒", "白酒概念"],
  食品饮料: ["食品饮料", "食品饮料概念"],
  零售: ["零售", "零售概念"],
  家电: ["家电", "家电概念"],
  科技: ["科技", "科技概念"],
  计算机: ["计算机", "计算机概念"],
  电子: ["电子", "电子概念", "电子化学品"],
  汽车: ["汽车", "汽车概念"],
  物联网: ["物联网", "物联网概念"],
};

// 归一化风口关键词: 命中同义词表返回规范名, 否则原样兜底
function canonFeng(key) {
  const k = String(key || "").trim();
  if (!k) return "";
  for (const [canon, syns] of Object.entries(FENK_SYNONYMS)) {
    if (syns.includes(k)) return canon;
  }
  return k;
}

// 维度权重顺序(与前端 useFengWeights 一致)与默认值
const FENG_DIM_ORDER = ["limitUp", "ladder", "capital", "theme", "news"];
const FENG_DEFAULT_WEIGHTS = { limitUp: 30, ladder: 20, capital: 20, theme: 15, news: 15 };

// 解析前端传入权重 "30,20,20,15,15", 非法/缺省回退默认
function parseFengWeights(raw) {
  const out = { ...FENG_DEFAULT_WEIGHTS };
  if (!raw) return out;
  const parts = String(raw).split(",").map((x) => Number(x.trim()));
  if (parts.length !== 5) return out;
  for (let i = 0; i < 5; i++) {
    const v = parts[i];
    if (Number.isFinite(v)) out[FENG_DIM_ORDER[i]] = Math.max(0, Math.min(100, v));
  }
  return out;
}

// 用归一化权重合成最终评分(权重归一化后求和, 近似加权平均)
function fengWeightedScore(dims, w) {
  const sum = w.limitUp + w.ladder + w.capital + w.theme + w.news;
  if (sum <= 0) return 0;
  const s =
    (dims.limitUp || 0) * w.limitUp +
    (dims.ladder || 0) * w.ladder +
    (dims.capital || 0) * w.capital +
    (dims.theme || 0) * w.theme +
    (dims.news || 0) * w.news;
  return Math.round(s / sum);
}

/** 龙头股数据源(市场板块实时热点)共享缓存访问器:
 *  风口面板(fengk-front)与龙头池(leader-pool)共用同一 15s 缓存条目,
 *  确保两者始终基于完全相同的数据源快照, 不会因各自独立拉取上游而出现偏差。
 *  date 为 "" 时与 fengk-front 缺省一致(不计日期的实时口径)。 */
function getFengFrontBase(date) {
  return cached(`fengk-front:${date}`, 15000, () => handleFengFrontBase(date));
}

// 聚合各东财网页接口的"维度原始分", 归一化到 0-100 的 dims; 不在此处算最终分(权重由前端决定)
async function handleFengFrontBase(date) {
  // 东财数据源(替代原 kpl 6 上游):
  //   - 涨停个股+连板高度: 东财涨停池 ZTPool(含连板 lbc / 行业 hybk / 封单 fund)
  //   - 板块资金: 东财行业板块主力净额榜 clist f62
  //   - 热门题材: 东财概念板块涨幅榜 clist f3
  //   - 题材新闻: 同花顺 THS news
  // 各上游并行(Promise.allSettled), 单源失败不影响其他字段; 外层的 15s 缓存保证刷新时秒回。
  const todayYmd = todayStr();
  const results = await Promise.allSettled([
    emTopicPool("ZTPool", todayYmd),
    emTopicPool("ZBPool", todayYmd),
    emBoardFlowList(),
    emConceptRiseList(),
    thsFetch("/api/ths/news", {}, 10000),
  ]);

  const [ztRes, zbRes, flowRes, concRes, newsRes] = results;

  // 涨停个股(东财涨停池): 统一字段映射; 无数据时留空(不兜底, 如实标注)
  const ztPool = ztRes.status === "fulfilled" ? ztRes.value?.pool : null;
  const boardList = (ztPool || []).map((s) => ({
    stock_code: s.c,
    stock_name: s.n,
    limit_up_reason: s.hybk || s.zttj?.name || "",
    concepts: s.hybk || "",
    consecutive_days: s.lbc || s.zttj?.days || 1,
    seal_amount: s.fund || 0,
    limit_up_price: num(s.zttj?.price || s.p || 0) / 1000, // 东财涨停池价格单位为厘(1元=1000厘), ÷1000 换为元
    change_pct: s.zdp || 0,
  }));

  // 板块资金 [[name, netIn], ...](行业板块主力净额榜)
  const ydList = flowRes.status === "fulfilled" ? (flowRes.value || []) : [];

  // 热门题材(位置越靠前越热): 概念板块涨幅榜
  const themeList = concRes.status === "fulfilled" ? (concRes.value || []) : [];

  // 题材新闻(thsdk news → 兼容原 Title/ZSName 结构)
  const newsList = (newsRes.status === "fulfilled" && newsRes.value?.success)
    ? (newsRes.value.data || []).map((n) => ({ Title: n.Title || "", ZSName: String(n.Stock || n.Code || "") }))
    : [];

  // 板块连板梯队(替代原 ladder/sector): 从涨停池按行业聚合连板高度
  const ladderSectors = [];
  {
    const byBoard = new Map();
    for (const s of boardList) {
      const b = s.limit_up_reason || "其他";
      if (!byBoard.has(b)) byBoard.set(b, []);
      byBoard.get(b).push(s);
    }
    for (const [bname, stocks] of byBoard) {
      ladderSectors.push({ sector_name: bname, stocks: stocks.map((s) => ({ consecutive_days: s.consecutive_days })) });
    }
  }

  const windMap = new Map();
  const getWind = (name) => {
    if (!windMap.has(name)) {
      windMap.set(name, {
        name,
        limitUpCount: 0,
        maxConsecutive: 0,
        capital: 0,
        themeHeat: 0,
        newsCount: 0,
        news: [],
        leaders: [],
        ladders: {},
      });
    }
    return windMap.get(name);
  };

  // 涨停板: 涨停家数 / 龙头(封单); 连板高度与梯队由 ladder/sector 提供
  // (realtime-boards 的 consecutive_days 恒为 1, 不能用于连板统计)
  for (const s of boardList) {
    const name = canonFeng(s.limit_up_reason);
    if (!name) continue;
    const w = getWind(name);
    w.limitUpCount++;
    w.leaders.push({
      code: s.stock_code,
      name: s.stock_name,
      price: s.limit_up_price,
      pct: s.change_pct,
      seal: s.seal_amount || 0,
    });
  }

  // 板块连板: 从东财涨停池按行业聚合的连板梯队(含真实 consecutive_days ≥ 2)
  for (const sec of ladderSectors) {
    const name = canonFeng(sec.sector_name);
    if (!name) continue;
    const w = getWind(name);
    const merge = (st) => {
      const days = st?.consecutive_days || 0;
      if (days > 0) {
        w.maxConsecutive = Math.max(w.maxConsecutive, days);
        w.ladders[days] = (w.ladders[days] || 0) + 1;
      }
    };
    (sec.stocks || []).forEach(merge);
    (sec.broken_stocks || []).forEach(merge);
  }

  // 板块资金排名
  for (const row of ydList) {
    const [plateName, val] = Array.isArray(row) ? row : [];
    const name = canonFeng(plateName);
    if (!name) continue;
    const w = getWind(name);
    w.capital = Math.max(w.capital, num(val));
  }

  // 热门题材热度(位置加权)
  themeList.forEach((t, idx) => {
    const rawName = typeof t === "string" ? t : t?.name || t?.title || t?.theme || "";
    const name = canonFeng(rawName);
    if (!name) return;
    const w = getWind(name);
    w.themeHeat = Math.max(w.themeHeat, themeList.length - idx);
  });

  // 题材新闻: 按板块名/关键词命中, 收集驱动新闻
  for (const n of newsList) {
    const title = n?.Title || n?.title || "";
    if (!title) continue;
    const zs = canonFeng(n?.ZSName || n?.zsName || "");
    const kword = canonFeng(n?.Kword || n?.kword || "");
    const name = zs || kword;
    if (!name) continue;
    const w = getWind(name);
    w.newsCount++;
    w.news.push({
      title,
      time: n?.TimeStamp || n?.timestamp || 0,
      stocks: (n?.Stocks || n?.stocks || []).map((s) => ({
        code: s.Code || s.code,
        name: s.Name || s.name,
        rate: s.Rate ?? s.rate,
      })),
    });
    if (w.news.length > 5) w.news.length = 5;
  }

  // 兜底: 有涨停但 ladder/sector 未覆盖的风口, 视为首板(连板高度=1)
  for (const w of windMap.values()) {
    if (w.limitUpCount > 0 && w.maxConsecutive === 0) {
      w.maxConsecutive = 1;
      w.ladders[1] = w.limitUpCount;
    }
    // 龙头股: 按封单金额降序取前 5(此前仅收集"递增加压子序列"会漏掉封单较小的涨停股)
    w.leaders.sort((a, b) => (b.seal || 0) - (a.seal || 0));
    if (w.leaders.length > 5) w.leaders.length = 5;
  }

  // 各维度最大原始值(用于归一化到 0-100)
  const windList = [...windMap.values()];
  const maxLimitUp = Math.max(1, ...windList.map((w) => w.limitUpCount));
  const maxConsecutive = Math.max(1, ...windList.map((w) => w.maxConsecutive));
  const maxCapital = Math.max(1, ...windList.map((w) => w.capital));
  const maxTheme = Math.max(1, ...windList.map((w) => w.themeHeat));
  const maxNews = Math.max(1, ...windList.map((w) => w.newsCount));

  const enriched = windList.map((w) => ({
    name: w.name,
    dims: {
      limitUp: Math.round((w.limitUpCount / maxLimitUp) * 100),
      ladder: Math.round((w.maxConsecutive / maxConsecutive) * 100),
      capital: Math.round((w.capital / maxCapital) * 100),
      theme: Math.round((w.themeHeat / maxTheme) * 100),
      news: Math.round((w.newsCount / maxNews) * 100),
    },
    limitUpCount: w.limitUpCount,
    maxConsecutive: w.maxConsecutive,
    capital: w.capital,
    leaders: w.leaders,
    ladders: Object.entries(w.ladders)
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([days, count]) => ({ days: Number(days), count })),
    news: w.news,
  }));

  return {
    date: date || (ztRes.status === "fulfilled" ? ztRes.value?.date || "" : ""),
    updatedAt: Date.now(), // 龙头股数据源构建时间戳(供追溯)
    source: {
      boards: ztRes.status === "fulfilled" && boardList.length > 0,
      ydPlate: flowRes.status === "fulfilled",
      theme: concRes.status === "fulfilled",
      news: newsRes.status === "fulfilled",
      fengBest: false, // 原 kpl fengk-best 已由东财涨停池接管
    },
    windList: enriched.slice(0, 30),
  };
}
/* ------------------------------------------------------------- */

/* ---------------- 核心标的参考池(市场实时热点 → 龙头股) ----------------
 * 数据源: 市场板块实时热点(fengk-front 聚合的 KPL 涨停/连板/板块资金) +
 *        腾讯行情(qt.gtimg.cn, 补齐流通市值/总市值/成交额)。
 * 龙头股筛选标准(封单占流通市值优先, 全部可量化):
 *   - 封单占流通市值 sealRatio 权重 40%  (市场认可度/承接强度, 小盘封单占比高更强势)
 *   - 板块涨停家数 boardLimitUp 权重 25% (板块影响力)
 *   - 连板高度 ladder       权重 20%  (龙头地位/市场认可)
 *   - 板块资金流入 capital   权重 15%  (板块影响力/资金合力)
 *   sealRatio = 封单金额 / 流通市值(×100%)
 *   score = 0.40*sealN + 0.25*boardN + 0.20*ladderN + 0.15*capitalN (各维度在池内归一化到 0-100)
 * 过滤门槛:
 *   - 仅保留有效 A股(腾讯行情可取, 流通市值 > 0)
 *   - 剔除超大市值(totalMarketCap > 1000 亿): 题材龙头通常为中小盘, 巨型权重难以连板
 * 动态更新: 每 15s 自动重算(复用 fengk-front 缓存), 手动刷新可强制重建; 变动追踪见 getLeaderPool。
 * ------------------------------------------------------------- */
const LEAD_POOL_TTL = 15000;
const LEAD_POOL_MAX = 30;            // 参考池容量上限
const LEAD_MEGA_CAP = 1000;          // 总市值上限(亿), 防止巨型权重混入龙头池
// 剔除板基础: 科创板(688)与创业板(300)不在龙头池范围内
const LEAD_EXCLUDE_PREFIXES = ["688", "300"];
const LEAD_WEIGHTS = { seal: 0.4, boardLimitUp: 0.25, ladder: 0.2, capital: 0.15 };
const LEAD_DIM_ORDER = ["seal", "boardLimitUp", "ladder", "capital"];

/** 解析龙头池打分权重(逗号分隔 4 个非负值, 顺序 seal,boardLimitUp,ladder,capital):
 *  支持小数(0.4)或百分比(40)输入, 解析后归一化到和为 1; 非法/缺省回退默认 LEAD_WEIGHTS。 */
function parseLeaderWeights(raw) {
  const out = { ...LEAD_WEIGHTS };
  if (!raw) return out;
  const parts = String(raw).split(",").map((x) => Number(x.trim()));
  if (parts.length !== 4) return out;
  for (let i = 0; i < 4; i++) {
    const v = parts[i];
    if (Number.isFinite(v)) out[LEAD_DIM_ORDER[i]] = Math.max(0, v);
  }
  const sum = out.seal + out.boardLimitUp + out.ladder + out.capital;
  if (sum > 0) {
    out.seal /= sum;
    out.boardLimitUp /= sum;
    out.ladder /= sum;
    out.capital /= sum;
  }
  return out;
}

/** 裸 6 位 A股代码 → 腾讯风格前缀(sh/sz/bj); 已带前缀则原样返回 */
function prefixedCode(code) {
  const c = String(code || "").trim().toLowerCase();
  if (/^\d{6}$/.test(c)) {
    const d = c[0];
    if (d === "6" || d === "9") return `sh${c}`;
    if (d === "0" || d === "2" || d === "3") return `sz${c}`;
    if (d === "4" || d === "8") return `bj${c}`;
  }
  return c;
}

// 龙头股池变动追踪状态(跨刷新保留, 用于标注 新增/移除/维持)
let lastLeaderCodeSet = new Set();

/** 数据校验: 将龙头池逐条与龙头股数据源(windList.leaders)比对, 发现任何偏差即标记不一致。
 *  校验维度与打分所用字段完全对齐: 代码存在性 / 封单 seal / 所属板块 board /
 *  板块涨停家数 boardLimitUp / 连板高度 ladder。返回一致性报告供追溯。 */
function validateLeaderConsistency(pool, base) {
  const checkedAt = Date.now();
  const leaderByCode = new Map();
  for (const w of (base.windList || [])) {
    for (const L of (w.leaders || [])) {
      if (!L.code) continue;
      const prev = leaderByCode.get(L.code);
      // 与 buildLeaderPool 去重口径一致: 同股跨板块时保留板块涨停家数最大者
      if (!prev || (prev.boardLimitUp || 0) < (w.limitUpCount || 0)) {
        leaderByCode.set(L.code, {
          seal: L.seal || 0,
          board: w.name,
          boardLimitUp: w.limitUpCount || 0,
          ladder: w.maxConsecutive || 0,
        });
      }
    }
  }
  const mismatches = [];
  for (const c of pool) {
    const baseRec = leaderByCode.get(c.code);
    if (!baseRec) {
      mismatches.push({ code: c.code, name: c.name, field: "present", poolVal: "在池", baseVal: "数据源缺失" });
      continue;
    }
    if (Math.abs((baseRec.seal || 0) - (c.seal || 0)) > 1)
      mismatches.push({ code: c.code, name: c.name, field: "seal", poolVal: c.seal, baseVal: baseRec.seal });
    if ((baseRec.board || "") !== (c.board || ""))
      mismatches.push({ code: c.code, name: c.name, field: "board", poolVal: c.board, baseVal: baseRec.board });
    if ((baseRec.boardLimitUp || 0) !== (c.boardLimitUp || 0))
      mismatches.push({ code: c.code, name: c.name, field: "boardLimitUp", poolVal: c.boardLimitUp, baseVal: baseRec.boardLimitUp });
    if ((baseRec.ladder || 0) !== (c.ladder || 0))
      mismatches.push({ code: c.code, name: c.name, field: "ladder", poolVal: c.ladder, baseVal: baseRec.ladder });
  }
  return {
    consistent: mismatches.length === 0,
    checkedAt,
    poolSize: pool.length,
    sourceSectors: (base.windList || []).length,
    mismatches,
  };
}

/* 从市场板块实时热点提取龙头股, 量化打分并补齐市值/成交额, 形成核心标的参考池。
 * weights 为打分权重(可手动传入, 已归一化), 缺省用默认 LEAD_WEIGHTS。 */
async function buildLeaderPool(weights) {
  const w = weights || LEAD_WEIGHTS;
  const date = dashToday();
  // 与风口面板(fengk-front)共用同一 15s 缓存快照, 保证龙头池与龙头股数据源无偏差
  const base = await getFengFrontBase(date);
  const windList = base.windList || [];

  // 1) 扁平化收集各板块龙头(每板块按封单前5, 已由 handleFengFrontBase 排序裁剪)
  const collectors = [];
  for (const w of windList) {
    for (const L of (w.leaders || [])) {
      if (!L.code) continue;
      collectors.push({
        code: L.code,
        name: L.name,
        price: L.price,
        pct: L.pct,
        seal: L.seal || 0,
        board: w.name,
        boardLimitUp: w.limitUpCount || 0,
        ladder: w.maxConsecutive || 0,
        capital: w.capital || 0,
      });
    }
  }

  // 空池(上游全部失败/无涨停): 返回空参考池, 不污染变动追踪
  if (!collectors.length) {
    return {
      date,
      updatedAt: Date.now(),
      pool: [],
      poolSize: 0,
      change: { added: [], removed: [...lastLeaderCodeSet], kept: [] },
      meta: {
        weights: w,
        filters: { totalMarketCapMax: LEAD_MEGA_CAP, excludePrefixes: LEAD_EXCLUDE_PREFIXES },
        sourceLabel: "市场板块实时热点(fengk-front) + 腾讯行情",
        source: base.source || {},
        baseUpdatedAt: base.updatedAt || 0,
      },
      validation: { consistent: true, checkedAt: Date.now(), poolSize: 0, sourceSectors: 0, mismatches: [] },
    };
  }

  // 2) 按代码去重: 同股跨板块时保留板块影响力(涨停家数)最大者
  const byCode = new Map();
  for (const c of collectors) {
    const prev = byCode.get(c.code);
    if (!prev || c.boardLimitUp > prev.boardLimitUp) byCode.set(c.code, c);
  }
  const uniq = [...byCode.values()];

  // 3) 腾讯行情补齐 流通市值/总市值/成交额(handleQuotes 内部按代码 1.5s 缓存)
  const quotes = await handleQuotes(uniq.map((c) => prefixedCode(c.code)).join(","));
  for (const c of uniq) {
    const q = quotes[prefixedCode(c.code)] || quotes[String(c.code).trim().toLowerCase()];
    if (!q) continue;
    c.floatMarketCap = q.floatMarketCap || 0; // 亿
    c.totalMarketCap = q.totalMarketCap || 0; // 亿
    c.amount = q.amount || 0;                 // 万元(A股)
    c.turnover = q.turnover || 0;             // 换手率(%)
  }

  // 4) 过滤门槛: 有效 A股(流通市值>0) 且 非超大市值 且 不在剔除板(688 科创板 / 300 创业板)
  const isExcludedBoard = (code) => LEAD_EXCLUDE_PREFIXES.some((p) => String(code || "").startsWith(p));
  let pool = uniq.filter((c) => c.floatMarketCap > 0 && c.totalMarketCap <= LEAD_MEGA_CAP && !isExcludedBoard(c.code));

  // 5) 量化打分(各维度池内归一化): 封单占流通市值优先
  //    封单维度采用"封单金额 / 流通市值"比例, 归一化后更公平地反映承接强度(小盘封单占比高 → 更强势)
  const maxSealRatio = Math.max(0, ...pool.map((c) => (c.floatMarketCap > 0 ? (c.seal / (c.floatMarketCap * 1e8)) * 100 : 0)));
  const maxBoard = Math.max(1, ...pool.map((c) => c.boardLimitUp));
  const maxLadder = Math.max(1, ...pool.map((c) => c.ladder));
  const maxCapital = Math.max(1, ...pool.map((c) => c.capital));
  for (const c of pool) {
    // 封单占流通市值百分比(%, 供展示与追溯)
    c.sealRatio = c.floatMarketCap > 0 ? +(c.seal / (c.floatMarketCap * 1e8)) * 100 : 0;
    const sealS = maxSealRatio > 0 ? (c.sealRatio / maxSealRatio) * 100 : 0;
    const boardS = maxBoard ? (c.boardLimitUp / maxBoard) * 100 : 0;
    const ladderS = maxLadder ? (c.ladder / maxLadder) * 100 : 0;
    const capitalS = maxCapital ? (c.capital / maxCapital) * 100 : 0;
    c.score = Math.round(w.seal * sealS + w.boardLimitUp * boardS + w.ladder * ladderS + w.capital * capitalS);
    c.weights = w;
  }
  pool.sort((a, b) => b.score - a.score);
  pool = pool.slice(0, LEAD_POOL_MAX);

  // 6) 变动追踪: 与上次对比, 标注 新增/移除/维持
  const next = new Set(pool.map((c) => c.code));
  const change = { added: [], removed: [], kept: [] };
  for (const c of pool) {
    if (lastLeaderCodeSet.has(c.code)) change.kept.push({ code: c.code, name: c.name, board: c.board, score: c.score });
    else change.added.push({ code: c.code, name: c.name, board: c.board, score: c.score });
  }
  for (const code of lastLeaderCodeSet) {
    if (!next.has(code)) change.removed.push(code);
  }
  lastLeaderCodeSet = next;

  return {
    date,
    updatedAt: Date.now(),
    pool,
    poolSize: pool.length,
    change,
    meta: {
      weights: w,
      filters: { totalMarketCapMax: LEAD_MEGA_CAP, excludePrefixes: LEAD_EXCLUDE_PREFIXES },
      sourceLabel: "市场板块实时热点(fengk-front) + 腾讯行情",
      source: base.source || {},        // 龙头股数据源各上游可用状态(可追溯)
      baseUpdatedAt: base.updatedAt || 0, // 龙头股数据源构建时间戳
    },
    validation: validateLeaderConsistency(pool, base), // 定期校验: 每次刷新与数据源比对
  };
}

/** 获取龙头股参考池(15s 缓存; force=true 强制重建; weights 参与缓存 key, 不同权重组合各自独立) */
async function getLeaderPool(force = false, weights) {
  const w = weights || LEAD_WEIGHTS;
  const key = `philia-leader-pool:${w.seal},${w.boardLimitUp},${w.ladder},${w.capital}`;
  if (force) {
    // 强制重建: 清除全部权重组合的龙头池缓存
    for (const k of cache.keys()) if (k.startsWith("philia-leader-pool:")) cache.delete(k);
    // 同步清除共享的龙头股数据源缓存, 使龙头池与风口面板基于同一份最新快照重建
    for (const k of cache.keys()) if (k.startsWith("fengk-front:")) cache.delete(k);
  }
  return cached(key, LEAD_POOL_TTL, () => buildLeaderPool(w));
}

/** 龙头池与龙头股数据源一致性深度校验(供巡检/手动验证):
 *  强制重建龙头股数据源, 与本机当前龙头池做全量比对, 返回差异报告。 */
async function validateLeaderPoolEndpoint() {
  const date = dashToday();
  for (const k of cache.keys()) if (k.startsWith("fengk-front:")) cache.delete(k); // 强制取最新数据源
  const base = await getFengFrontBase(date);
  // 复用 buildLeaderPool 的打分与过滤逻辑, 基于最新数据源重新推导"应然池"
  const pool = await cached(`philia-leader-pool`, LEAD_POOL_TTL, buildLeaderPool);
  const report = validateLeaderConsistency(pool.pool || [], base);
  return {
    date,
    checkedAt: Date.now(),
    report,
    source: base.source || {},
    baseUpdatedAt: base.updatedAt || 0,
    pool: pool.pool || [],
    note: report.consistent
      ? "龙头池与龙头股数据源完全一致, 无偏差"
      : `发现 ${report.mismatches.length} 处偏差, 详见 mismatches`,
  };
}

/* ------------------------------------------------------------- */

/* ---------------- 主机路由表 ---------------- */
const routes = {
  "/api/quotes": async (q) => handleQuotes(q.get("codes") || ""), // 内部按代码独立缓存(TTL 1.5s)
  "/api/minute": async (q) => getMinute(q.get("code") || "sh000001"), // 单指数分时(按代码独立缓存 5s)
  // 批量分时: 指数面板一次取全部指数, 内部按代码复用 getMinute 缓存与并发去重, 减少 HTTP 往返
  "/api/minutes": async (q) => {
    const codes = (q.get("codes") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const rs = await Promise.all(codes.map((c) => getMinute(c).catch(() => ({ code: c, prec: 0, points: [] }))));
    const map = Object.create(null);
    // 以请求时的原始代码(含大小写)为 key, 保证前端按 def.code 能取到(handleMinute 内部会小写化 code 字段)
    for (let i = 0; i < codes.length; i++) if (rs[i]) map[codes[i]] = rs[i];
    return map;
  },
  "/api/boards": async (q) =>
    cached(`boards:${q.get("type")}:${q.get("dir")}:${q.get("n")}`, 5000, () =>
      handleBoards(q.get("type") || "01", q.get("dir") || "0", q.get("n") || "30")
    ),
  "/api/board-stocks": async (q) =>
    cached(`bstocks:${q.get("code")}:${q.get("dir")}:${q.get("n")}`, 8000, () =>
      handleBoardStocks(q.get("code") || "", q.get("dir") || "down", q.get("n") || "10")
    ),
  "/api/rank": async (q) =>
    cached(`rank:${q.get("sort")}:${q.get("asc")}:${q.get("n")}`, 5000, () =>
      handleRank(q.get("sort") || "changepercent", q.get("asc") || "0", q.get("n") || "30")
    ),
  "/api/moneyflow": async (q) =>
    cached(`mf:${q.get("n")}`, 8000, () =>
      // 东财主源, 失败回退新浪
      handleMoneyFlowEM(q.get("n") || "20").then((rows) => {
        if (rows.length) return rows;
        return handleMoneyFlow(q.get("n") || "20");
      }).catch(() => handleMoneyFlow(q.get("n") || "20"))
    ),
  "/api/stock-flow": async (q) =>
    handleStockFlows(q.get("code") || "").then((rows) => rows[0] || Promise.reject(new Error("empty stock-flow"))),
  "/api/stock-flows": async (q) => handleStockFlows(q.get("codes") || ""),
  "/api/stock-main-forces": async (q) =>
    cached(`smf:${q.get("code")}`, 30000, () => handleStockMainForces(q.get("code") || "")), // 主力净额, 30s 缓存(减少上游慢请求)
  "/api/board-flow": async (q) => cached(`bf:${q.get("n")}`, 120000, () => handleBoardFlow(q.get("n") || "20")),
  "/api/stock-boards": async (q) => {
    // 行业/概念为每日更新的基础静态数据: 一律从库读取, 首次(未入库)补种一次, 不做实时外呼
    const code = q.get("code") || "";
    let row = getStock(code);
    if (!row || (!row.industry && !row.area && (!row.concepts || row.concepts.length === 0))) {
      if (!inCooldown(code, "boards")) {
        try {
          const b = await handleStockBoards(code);
          if (b && (b.industry || b.area || b.concepts.length > 0)) {
            row = row || { code };
            row.industry = b.industry; row.area = b.area; row.concepts = b.concepts; row.boards_ts = Date.now();
            upsertStock(row);
            clearBackoff(code, "boards");
          } else failBackoff(code, "boards");
        } catch { failBackoff(code, "boards"); }
      }
      row = getStock(code);
    }
    return { code, industry: row?.industry || "", area: row?.area || "", concepts: row?.concepts || [] };
  },
  "/api/stock-profile": async (q) =>
    cached(`sp:${q.get("code")}`, 24 * 3600 * 1000, () => handleStockProfile(q.get("code") || "")), // 主营/公司名, 24h 缓存
  "/api/stock-quote": async (q) =>
    cached(`sq:${q.get("code")}`, 10000, () => handleStockQuote(q.get("code") || "")), // 实时行情, 10s 缓存(价格由报价中心5s覆盖, 此处减少上游慢请求)
  "/api/stock-detail": async (q) => handleStockDetail(q.get("code") || ""), // 个股详情聚合(本地数据库: 按需抓取+失败回退+行业概念永久保留)
  "/api/stock-finance": async (q) =>
    cached(`sfn:${q.get("code")}`, 24 * 3600 * 1000, () => handleStockFinance(q.get("code") || "")), // 财务指标, 24h 缓存
  "/api/news": async (q) =>
    cached(`news:${q.get("page")}:${q.get("size")}`, 8000, () =>
      handleNews(q.get("page") || "1", q.get("size") || "40")
    ),
  "/api/treasuries": async () => cached("treasuries", 30000, () => handleTreasuries()),
  "/api/finance-main": async (q) =>
    cached(`fin-main:${q.get("code")}`, 3600000, () => handleFinanceMain(q.get("code") || "")), // 单公司近12期主指标, 1h缓存
  "/api/finance-board": async (q) => {
    const p = validPeriod(q.get("period"));
    return cached(`fin-board:${p}`, 3600000, () => handleFinanceBoard(p)); // 盈利榜+行业聚合+披露日历, 1h缓存
  },
  "/api/finance-forecast": async (q) => {
    const p = validPeriod(q.get("period"));
    return cached(`fin-forecast:${p}`, 3600000, () => handleFinanceForecast(p)); // 业绩预告, 1h缓存
  },
  "/api/treasury-history": async () => cached("treasury-history", 6 * 3600 * 1000, () => handleTreasuryHistory()),
  "/api/health": async () => ({ status: "up", ts: Date.now(), cache: cache.size }),
  /* --------------------------------------------------------------------------
   * GET/POST /api/ths/account — 同花顺 THS 网关账号配置
   * GET:  读 server/ths-account.json, 返回 {configured, username, mac, gatewayAlive}(不回传明文密码)
   * POST: body {username, password, mac} 写文件并同步网关内存账号热重连; password 留空则保留原密码
   * ------------------------------------------------------------------------ */
  "/api/ths/account": async (q, body) => {
    const file = path.join(__dirname, "ths-account.json");
    const alive = async () => {
      try {
        const r = await fetch(`${THS_GATEWAY}/api/ths/account`, { signal: AbortSignal.timeout(1500) });
        return r.ok;
      } catch { return false; }
    };
    if (body === undefined) {
      let configured = false, username = "", mac = "";
      try {
        if (fs.existsSync(file)) {
          const acc = JSON.parse(fs.readFileSync(file, "utf-8"));
          configured = !!(acc.username && acc.password);
          username = acc.username || "";
          mac = acc.mac || "";
        }
      } catch (e) { console.error("[ths-account] read error:", e?.message || e); }
      return { configured, username, mac, gatewayAlive: await alive() };
    }
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "").trim();
    const mac = String(body?.mac || "").trim();
    if (!username) throw Object.assign(new Error("账号不能为空"), { status: 400 });
    // 密码留空则保留原密码(避免每次保存都需重输)
    let finalPwd = password;
    if (!finalPwd) {
      try {
        if (fs.existsSync(file)) {
          const acc = JSON.parse(fs.readFileSync(file, "utf-8"));
          finalPwd = acc.password || "";
        }
      } catch { finalPwd = ""; }
    }
    if (!finalPwd) throw Object.assign(new Error("密码不能为空(首次配置需填写)"), { status: 400 });
    fs.writeFileSync(file, JSON.stringify({ username, password: finalPwd, mac }, null, 2), "utf-8");
    console.log("[ths-account] saved", username);
    // 同步网关内存账号并热重连(网关在线时); 失败不影响文件已保存
    try {
      await fetch(`${THS_GATEWAY}/api/ths/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: finalPwd, mac }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) { console.error("[ths-account] gateway sync failed:", e?.message || e); }
    return { configured: true, username, mac, gatewayAlive: true };
  },
  /* --------------------------------------------------------------------------
   * GET /api/monitor — 系统监控接口(供前端"系统监控"面板)
   * 功能: 汇总各 API 接口的调用性能指标、服务端内存状态与本地数据库状态。
   * 输入: 无(不受用户输入影响, 亦不参与限流 IP 计数)。
   * 输出: {ok:true, data: MonitorData, ts} 其中 data 结构见 buildMonitorData。
   * 返回: 200 成功; 正常情况下不会失败(500 级为进程级异常)。
   * 错误: 无业务错误码; 仅当进程异常时由外层统一返回 502。
   * 调用: 前端 monitor() 每 10s 轮询一次; 本接口自身不计入性能指标统计。
   * 注意: 指标为内存滚动统计, 服务重启后清零; 本接口不落库、不写日志。
   * ------------------------------------------------------------------------ */
  "/api/monitor": async () => buildMonitorData(),
  "/api/openrouter-usage": async () => cached("or-usage", 3600000, () => handleOpenRouterUsage()), // 1h cache
  "/api/stock-search": async (q) =>
    cached(`ssearch:${q.get("q")}`, 5000, () => handleStockSearch(q.get("q") || "")), // 前端击键触发, 短缓存防新浪WAF
  "/api/plugin-news-analyst": async () => cached("plugin-news-analyst", 30000, () => handleNewsAnalystKPL()),
  "/api/plugin-market-sentiment": async () => cached("plugin-market-sentiment", 15000, () => handleMarketSentimentV2()),
  // 风口聚合: dims 聚合 15s 缓存(仅按 date 缓存, 权重不参与缓存 key, 每次请求独立计分)
  "/api/fengk-front": async (q) => {
    const date = q.get("date") || "";
    const weights = parseFengWeights(q.get("weights") || "");
    const base = await getFengFrontBase(date); // 与龙头池共用同一缓存快照
    const windList = (base.windList || []).map((w) => ({ ...w, score: fengWeightedScore(w.dims, weights) }));
    windList.sort((a, b) => b.score - a.score);
    return { ...base, weights, windList };
  },
  /* --------------------------------------------------------------------------
   * PHILIA AI 综合分析(@/api/philia/*)
   * 技能/模型读取 + Key 校验 + 配置加密读写 + LLM 分析(降频缓存) + 历史
   * 注意: 涉及 LLM 调用与私有密钥, 均加入 PROTECTED_ROUTES(仅同源)并单独限流。
   * ------------------------------------------------------------------------ */
  // 核心标的参考池(市场实时热点 → 龙头股): 15s 自动刷新, force=1 强制重建, weights=权重
  "/api/philia/leader-pool": async (q) => getLeaderPool(q.get("force") === "1", parseLeaderWeights(q.get("weights"))),
  // 龙头池与龙头股数据源一致性校验(强制取最新数据源全量比对, 供巡检/手动验证)
  "/api/philia/leader-pool/validate": async () => validateLeaderPoolEndpoint(),
  // 龙头情绪复盘(5 模块): 今日龙头核心/今日情绪周期/今日机会/今日风险/昨日梯队双日对照; force=1 强制重算
  "/api/philia/market-analyze": async (q, body) => philia.analyzeMarket({ model: body?.model, skills: body?.skills, force: !!body?.force }),
  // 最小 key 接口: GET 读配置(不含明文 key); POST 带 key 先校验再保存, validateOnly=1 仅校验不保存
  "/api/philia/key": async (q, body) => {
    if (body === undefined) return philia.getConfig();
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const validateOnly = !!body?.validateOnly;
    if (key) {
      const v = await philia.validateKey(key);
      if (!v.valid) {
        if (validateOnly) return { valid: false, error: v.error || "Key 无效" };
        throw Object.assign(new Error(v.error || "Key 无效"), { status: 400 });
      }
      if (validateOnly) return { valid: true, label: v.label || null };
    }
    return philia.saveConfig({ key: key || undefined, model: body?.model, skills: body?.skills });
  },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

// 静态资源安全头; CSP 仅随 HTML 下发(脚本均为构建产物, 内联 style 属性需 unsafe-inline)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https:", // 浏览器直连兜底源(qt.gtimg.cn / wscn / binance 等)
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join("; ");

const STATIC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

/* ---------------- 同源校验与 CORS(经 CF Tunnel 公网可达, 默认不授权任何跨源浏览器读取) ---------------- */
const PROTECTED_ROUTES = new Set([
  "/api/openrouter-usage",
  // PHILIA AI: 涉及私有密钥与 LLM 调用, 仅允许同源访问
  "/api/philia/market-analyze",
  "/api/philia/key",
  // 同花顺账号凭据, 仅允许同源访问
  "/api/ths/account",
]);

// 环回地址互认: 开发期 vite 代理(:3000→:3001)跨端口转发, Origin/Host 端口必然不同, 视为同源
const isLoopbackHost = (h) => /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])(:\d+)?$/.test(h);

// 带 Origin/Referer 时其 host 必须与请求 Host 一致(或同为环回); 都不带(curl/同源导航)则放行
function isSameOrigin(req) {
  const host = req.headers.host;
  if (!host) return true;
  for (const h of [req.headers.origin, req.headers.referer]) {
    if (!h) continue;
    try {
      const oh = new URL(h).host;
      if (oh !== host && !(isLoopbackHost(oh) && isLoopbackHost(host))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// 全端点统一: 仅同源(或环回开发)浏览器请求反射 Origin, 跨源一律不下发 ACAO
function corsHeadersFor(req) {
  const origin = req.headers.origin;
  return { "Access-Control-Allow-Origin": origin && isSameOrigin(req) ? origin : null };
}

/* ---------------- 按客户端 IP 限流(CF Tunnel 后真实 IP 取 CF-Connecting-IP 头) ---------------- */
function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// 固定窗口计数器: windowMs 内超过 max 次返回 false; 定时清扫防 Map 无界增长
function makeLimiter(windowMs, max) {
  const hits = new Map(); // ip -> { ts, count }
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (now - h.ts > windowMs) hits.delete(ip);
  }, windowMs);
  sweeper.unref();
  return (ip) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.ts > windowMs) {
      hits.set(ip, { ts: now, count: 1 });
      return true;
    }
    h.count++;
    return h.count <= max;
  };
}

const apiLimiter = makeLimiter(60 * 1000, 240); // 公开 /api: 每 IP 每分钟 240 次(单大屏客户端实测约 100+)
const protectedLimiter = makeLimiter(60 * 1000, 20); // 私有 key 端点: 每 IP 每分钟 20 次, 防脚本刷配额
const philiaLimiter = makeLimiter(60 * 1000, 5); // PHILIA 分析: 每 IP 每分钟 5 次(LLM 计费, 严控滥用)

// 读取 POST body, 超过 limit 字节即停止累积({ tooBig: true }), 防止无限读入
function readBodyWithLimit(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners("data");
        req.resume(); // 排空剩余数据, 避免背压卡死连接
        done({ tooBig: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done({ buf: Buffer.concat(chunks) }));
    req.on("error", () => done({ buf: Buffer.concat(chunks) }));
    req.on("close", () => done({ buf: Buffer.concat(chunks) })); // 客户端中途断连兜底, 防止悬挂
  });
}

/* ============================================================================
 * 接口性能监控子系统(供前端"系统监控"面板使用)
 * ----------------------------------------------------------------------------
 * 功能: 在服务端以内存滚动统计的方式, 记录每个 API 接口的调用次数、响应耗时、
 *       成功率与错误信息, 并通过 /api/monitor 暴露给前端监控面板展示。
 * 存储: 全部指标保存在进程内存(API_METRICS Map)中, 服务重启即清空, 不做持久化。
 * 目的: 定位接口资源挤占(慢接口/高频接口/报错接口), 支撑性能优化与告警。
 * 注意: 指标累计量随进程运行时间持续增长, 但样本最近 200 条滚动, 内存占用有界。
 * ========================================================================== */
const METRIC_SAMPLES = 200; // 每个接口路径在内存中保留的最近样本数(滚动窗口)
/** 各接口性能指标容器: path -> { count,total,max,errors,errs[],samples[],lastTs,winStart,winCount } */
const API_METRICS = new Map();

/**
 * 记录一次接口调用指标。
 *
 * @param {string} path  接口路径(如 "/api/stock-detail"), 作为指标分组键。
 * @param {number} ms    本次调用的耗时(毫秒)。
 * @param {boolean} ok   本次调用是否成功(true=成功, false=失败/异常)。
 * @param {string} [errMsg] 失败时的错误信息(可选), 仅成功时为空; 会截断至 120 字符入列。
 * @returns {void} 无返回值。指标写入内存 Map, 由 /api/monitor 读取。
 * @note 调用方在服务端请求处理流程中统一调用(见底部 http.createServer);
 *       失败的错误信息仅在 !ok 时记录, 成功后清空历史错误列表, 避免错误堆积。
 */
function recordMetric(path, ms, ok, errMsg) {
  let m = API_METRICS.get(path);
  if (!m) {
    m = { count: 0, total: 0, max: 0, errors: 0, errs: [], samples: [], lastTs: 0, winStart: Date.now(), winCount: 0 };
    API_METRICS.set(path, m);
  }
  m.count++; m.total += ms; if (ms > m.max) m.max = ms;
  if (!ok) { m.errors++; if (errMsg) m.errs.push({ ts: Date.now(), msg: String(errMsg).slice(0, 120) }); }
  else m.errs = [];
  m.samples.push({ ms, ok, ts: Date.now() });
  if (m.samples.length > METRIC_SAMPLES) m.samples.shift();
  m.lastTs = Date.now();
  // 每分钟滑动窗口: 统计该分钟内调用次数, 用于计算调用速率(rate1m)
  if (Date.now() - m.winStart > 60000) { m.winStart = Date.now(); m.winCount = 0; }
  m.winCount++;
}

/**
 * 计算一段耗时样本的分位数(如 p95/p99)。
 *
 * @param {Array<{ms:number,ok:boolean,ts:number}>} arr 近 METRIC_SAMPLES 条耗时样本。
 * @param {number} q 分位数(0~1, 如 0.95 表示 95 分位)。
 * @returns {number} 该分位对应的耗时(毫秒); 样本为空时返回 0。
 * @note 采用排序后取索引法, 非真分位数插值, 对监控场景足够且实现简单。
 */
function pct(arr, q) {
  const n = arr.length; if (!n) return 0;
  const s = [...arr].sort((a, b) => a.ms - b.ms);
  return s[Math.min(n - 1, Math.ceil(q * n) - 1)].ms;
}

/**
 * 汇总 /api/monitor 的响应数据: 各接口性能指标 + 服务端状态 + 本地数据库状态。
 *
 * @returns {Object} 监控数据对象, 结构如下:
 *   - ts:        {number} 数据生成时间戳(毫秒)。
 *   - uptime:    {number} 服务进程已运行时长(秒)。
 *   - serverMem: {Object} Node 进程内存占用(字节), 含 rss/heapTotal/heapUsed/external/arrayBuffers。
 *   - endpoints: {Array}  各接口指标数组(按调用次数降序), 每项见下方注释。
 *   - db:        {Object} SQLite 本地库状态: stocks=个股缓存条数, trends=趋势记录条数, dbPath=库文件路径。
 *   - cache:     {Object} 内存缓存条目数: entries=内存缓存 Map 当前大小。
 * @note 无输入参数; 每次调用都实时读取内存指标与进程状态, 开销极小。
 */
function buildMonitorData() {
  const now = Date.now();
  const endpoints = [];
  for (const [path, m] of API_METRICS) {
    endpoints.push({
      path,                                  // 接口路径
      count: m.count,                        // 累计调用次数(进程启动以来)
      avg: m.count ? Math.round(m.total / m.count) : 0,            // 平均耗时(ms)
      p95: m.samples.length ? pct(m.samples, 0.95) : 0,            // 95 分位耗时(ms), 无样本时为 0
      max: m.max,                            // 最大耗时(ms)
      errors: m.errors,                      // 累计错误次数
      successRate: m.count ? Math.round((1 - m.errors / m.count) * 1000) / 10 : 100, // 成功率(%, 保留 1 位小数)
      rate1m: m.winCount,                    // 最近 1 分钟调用次数(调用速率)
      lastTs: m.lastTs,                      // 最近一次调用时间戳(毫秒)
      lastErr: m.errs[m.errs.length - 1] || null, // 最近一条错误 {ts,msg}, 无错误为 null
    });
  }
  endpoints.sort((a, b) => b.count - a.count);
  return {
    ts: now,
    uptime: process.uptime(),
    serverMem: process.memoryUsage(),
    endpoints,
    db: {
      stocks: stockCount(),
      trends: trendCount(),
      dbPath: DB_PATH,
      // 数据库性能监控指标(读/写调用次数与耗时, 供面板识别热路径/瓶颈)
      metrics: getDbMetrics(),
    },
    cache: { entries: cache.size },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    if (routes[u.pathname]) {
      const cors = corsHeadersFor(req);
      // 按 IP 限流(先于缓存命中判断, 防唯一 key 旋转造成的上游请求放大)
      // LLM 计费端点(/api/philia/analyze 与 /api/philia/market-analyze)共用 philiaLimiter(5 次/分钟)严控并发
      const isLlmbilling = u.pathname === "/api/philia/analyze" || u.pathname === "/api/philia/market-analyze";
      const limiter = isLlmbilling ? philiaLimiter : (PROTECTED_ROUTES.has(u.pathname) ? protectedLimiter : apiLimiter);
      const allowed = limiter(clientIp(req));
      if (!allowed) {
        send(res, 429, { ok: false, error: "too many requests" }, cors);
        return;
      }
      // 私有 API key 端点: 跨源请求直接拒绝, 防止被刷配额
      if (PROTECTED_ROUTES.has(u.pathname) && !isSameOrigin(req)) {
        send(res, 403, { ok: false, error: "forbidden" }, cors);
        return;
      }
      // 用户输入参数长度上限(缓存 key 由参数拼接, 防止无界增长)
      for (const v of u.searchParams.values()) {
        if (v.length > 2000) {
          send(res, 400, { ok: false, error: "param too long" }, cors);
          return;
        }
      }
      let t0 = 0;
      try {
        let body;
        if (req.method === "POST") {
          const r = await readBodyWithLimit(req, 256 * 1024);
          if (r.tooBig) {
            res.on("finish", () => req.destroy()); // 响应送达后再回收连接
            send(res, 413, { ok: false, error: "payload too large" }, cors);
            return;
          }
          try { body = JSON.parse(r.buf.toString()); } catch { body = {}; }
        }
        t0 = Date.now();
        const data = await routes[u.pathname](u.searchParams, body);
        const ms = Date.now() - t0;
        recordMetric(u.pathname, ms, true);
        if (u.pathname !== "/api/monitor") console.log(`[api] ${u.pathname} ${ms}ms`);
        send(res, 200, { ok: true, data, ts: Date.now() }, cors);
      } catch (e) {
        // 内部细节只记日志; err.status 由可预期的业务错误(如队列满)携带, 其 message 可安全回显
        const ms = Date.now() - t0;
        recordMetric(u.pathname, ms, false, e?.message || e);
        console.error("[api]", u.pathname, "error:", e?.message || e);
        send(res, e?.status || 502, { ok: false, error: e?.status ? e.message : "upstream error" }, cors);
      }
      return;
    }
    // /api/ 下未命中的路由返回 404 JSON, 不走 SPA fallback
    if (u.pathname.startsWith("/api/")) {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }
    // 静态资源 + SPA fallback
    let p = decodeURIComponent(u.pathname);
    if (p === "/") p = "/index.html";
    const file = path.join(DIST, path.normalize(p));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      send(res, 403, { ok: false });
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        // 带扩展名的资源未命中: 直接 404, 不回退 index.html(避免 200+HTML 伪装成 JS/CSS)
        if (path.extname(file)) return send(res, 404, { ok: false, error: "not found" });
        fs.readFile(path.join(DIST, "index.html"), (e2, html) => {
          if (e2) return send(res, 404, { ok: false });
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": CSP,
            ...STATIC_HEADERS,
          });
          res.end(html);
        });
        return;
      }
      const headers = {
        "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        ...STATIC_HEADERS,
      };
      if (file.endsWith(".html")) headers["Content-Security-Policy"] = CSP;
      res.writeHead(200, headers);
      res.end(buf);
    });
  } catch (e) {
    console.error("[server] error:", e?.message || e);
    send(res, 500, { ok: false, error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[market-cockpit] listening on :${PORT}`);
  // 注入龙头股参考池提供者, 供 PHILIA 分析上下文使用(避免循环依赖: philia-ai 不 require index)
  if (typeof philia.setLeaderPoolGetter === "function") philia.setLeaderPoolGetter(getLeaderPool);
  scheduleDailyBoardsRefresh(); // 每日行业/概念批量刷新(启动后立即检查一次, 之后每小时)
  scheduleMsDaily(); // 市场情绪收盘定格(15:00后保存离线快照, 每30s检查)
  ensureThsGateway(); // 确保 THS 数据网关运行(未启动则自动拉起)
});

/* ---------------- THS 数据网关自动拉起 ----------------
 * 个股分时/新闻等依赖同花顺 thsdk, 由 server/ths-gateway.py 提供。
 * Node 服务启动时探测网关, 不可达则后台拉起 Python 进程, 避免手动启动。 */
function ensureThsGateway() {
  const probe = async () => {
    try {
      const r = await fetch(`${THS_GATEWAY}/api/ths/industry`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) { console.log("[ths-gateway] 已连接:", THS_GATEWAY); return; }
    } catch { /* 不可达, 拉起 */ }
    try {
      const py = process.platform === "win32" ? "python" : "python3";
      const { spawn } = require("child_process");
      const p = spawn(py, [path.join(__dirname, "ths-gateway.py"), "--port", "9877"], { detached: true, stdio: "ignore", windowsHide: true });
      p.unref();
      console.log(`[ths-gateway] 未检测到网关, 已自动拉起 THS 数据网关(port 9877)`);
    } catch (e) {
      console.error("[ths-gateway] 拉起失败:", e?.message || e);
    }
  };
  probe();
  setTimeout(probe, 3000).unref(); // 3s 后再确认一次(网关启动需连接 THS)
}
