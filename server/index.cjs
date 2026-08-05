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
const { getStock, upsertStock, stockCount, allStockCodes, getMeta, setMeta, deleteMeta, saveMsOffline, loadMsOffline, clearMsOffline, upsertTrends, getTrends, trendCount, DB_PATH } = require("./stock-db.cjs");

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

/* ---------------- 开盘啦 API 客户端 (kpl.liuhepc.cn) ---------------- */
const KPL_BASE = "https://kpl.liuhepc.cn";
const KPL_API_KEY = process.env.KPL_API_KEY || "kpl-4ed522163bf8dad3aeb1d9613791661eb62ed88ed6e82067";

async function kplFetch(path, params = {}) {
  const url = new URL(path, KPL_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  // node fetch 对 kpl.liuhepc.cn 有间歇性 TLS 断连; fetch 失败时回退 curl 兜底, 保证市场情绪等模块稳定
  try {
    const resp = await fetch(url.toString(), {
      headers: { "X-API-Key": KPL_API_KEY, "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    const json = await resp.json();
    return json;
  } catch (e) {
    console.error(`[kplFetch] ${path} fetch failed, fallback curl:`, e.message);
    try {
      const text = await curlText(url.toString(), {
        referer: "https://kpl.liuhepc.cn/",
        timeout: 8000,
        encoding: "utf-8",
      });
      return JSON.parse(text);
    } catch (e2) {
      console.error(`[kplFetch] ${path} curl fallback failed:`, e2.message);
      return null;
    }
  }
}

function todayStr() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0) d.setDate(d.getDate() - 2);
  else if (day === 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
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
  // ★ 腾讯为最高优先级: 先取腾讯(覆盖全部代码, 含 A股核心指数)
  if (missing.length) {
    // 按 60 个/块分块并发(报价中心全集可达数百, 单 URL 过长会被上游拒绝)
    const chunks = [];
    for (let i = 0; i < missing.length; i += 60) chunks.push(missing.slice(i, i + 60));
    const texts = await Promise.all(chunks.map((c) => fetchText(`https://qt.gtimg.cn/q=${encodeURIComponent(c.join(","))}`, { gbk: true })));
    const ts = Date.now();
    for (const text of texts) {
      for (const line of text.split(";")) {
        const q = parseTencentLine(line.trim());
        if (q) {
          out[q.symbol] = q;
          if (q.symbol !== "usVIX") cacheSet(`q:${q.symbol}`, { ts, data: q, inflight: null, ttl: QUOTE_CACHE_TTL }); // usVIX 由新浪覆盖值接管
        }
      }
    }
  }
  // 腾讯缺失的 A股核心指数(上证/深证/创业板/科创50): 回退开盘啦 KPL 兜底
  const KPL_INDEX_MAP = { sh000001: "SH000001", sz399001: "SZ399001", sz399006: "SZ399006", sh000688: "SH000688" };
  const kplIndexCodes = missing.filter((c) => KPL_INDEX_MAP[c] && !out[c]);
  if (kplIndexCodes.length) {
    try {
      const kplData = await kplFetch("/api/advanced/zs-real", { date: todayStr() });
      const list = kplData?.data || [];
      if (list.length) {
        const ts = Date.now();
        for (const item of list) {
          const sid = String(item.stock_id || "").toLowerCase();
          const symbol = kplIndexCodes.find(c => c === sid);
          if (!symbol || out[symbol]) continue;
          const price = parseFloat(item.last_px);
          const change = parseFloat(item.increase_amount) || 0;
          const pctStr = String(item.increase_rate || "0%").replace("%", "");
          const pct = parseFloat(pctStr) || 0;
          const prev = price - change;
          if (!isNaN(price) && !isNaN(prev)) {
            const q = {
              symbol,
              name: String(item.name || ""),
              price,
              prev,
              change: +change.toFixed(2),
              pct: +pct.toFixed(2),
              open: prev,
              high: price,
              low: price,
              amount: Math.round(parseFloat(item.turnover) / 10000) || 0,
              turnover: 0,
              time: kplData.date || "",
            };
            out[symbol] = q;
            cacheSet(`q:${symbol}`, { ts, data: q, inflight: null, ttl: QUOTE_CACHE_TTL });
          }
        }
      }
    } catch (e) {
      console.error("[kpl-index] zs-real fetch error:", e?.message || e);
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
            out[code] = {
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
            cacheSet(`q:${code}`, { ts: Date.now(), data: out[code], inflight: null, ttl: QUOTE_CACHE_TTL });
          }
        }
      } catch (e) {
        console.error(`[sina-daily-index] ${code} fetch error:`, e?.message || e);
      }
    }
  }
  return out;
}

/* ---------------- 腾讯分钟线(指数/个股 日内走势) ---------------- */
/* ---------------- A股个股分时: 主备健康切换(KPL主 / 腾讯备) ----------------
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
  if (!s) { s = { primary: "kpl", fail: 0, okOnBackup: 0 }; minuteSrcState.set(code, s); }
  return s;
}

/** KPL 个股分时; 成功返回 {code,prec,points}, 失败/空返回 null */
async function kplMinuteFetch(code) {
  const stockCode = code.replace(/^s[hz]/, "");
  const kplData = await kplFetch("/api/v2/stock/intraday", { code: stockCode });
  const trend = kplData?.trend;
  if (trend && Array.isArray(trend) && trend.length) {
    const prec = parseFloat(kplData.preclose_px) || 0;
    const pts = trend.filter(p => String(p[0]).includes(":")).map(p => ({ t: p[0], p: parseFloat(p[1]) }));
    return { code, prec, points: pts };
  }
  return null;
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
  // usN225(日经225) 和 usKS11(韩国KOSPI) 从新浪全球指数分钟线获取
  const SINA_INDEX_MAP = { usN225: "N225", usKS11: "KS11" };
  if (SINA_INDEX_MAP[code]) {
    try {
      const symbol = SINA_INDEX_MAP[code];
      const text = await curlText(
        `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=${symbol}`,
        { referer: `https://finance.sina.com.cn/futures/quotes/${symbol}.shtml`, encoding: "utf-8", timeout: 5000 }
      );
      const arr = parseJsonp(text)?.minLine_1d || [];
      const pts = arr.filter((f) => String(f[0]).includes(":")).map((f) => ({ t: f[0], p: num(f[1]) }));
      // 从新浪日线API获取昨收作为prec(hq.sinajs.cn不支持全球指数)
      let prec = 0;
      try {
        const dailyText = await fetchTextAny(`https://gi.finance.sina.com.cn/hq/daily?symbol=${symbol}&num=2`, { referer: "https://finance.sina.com.cn/", timeout: 4000 });
        let dailyJson;
        try {
          dailyJson = parseJsonp(dailyText);
        } catch {
          dailyJson = JSON.parse(dailyText);
        }
        const dailyRows = dailyJson?.result?.data || dailyJson?.data || [];
        if (dailyRows.length >= 2) {
          const prev = parseFloat(dailyRows[dailyRows.length - 2].c);
          if (!isNaN(prev)) prec = prev;
        }
      } catch { /* prec remains 0 */ }
      return { code, prec, points: pts };
    } catch (e) {
      console.error(`[sina-minute] ${code} error:`, e?.message || e);
      return { code, prec: 0, points: [] };
    }
  }
  // A股个股分时: 主备健康切换(KPL主 / 腾讯备), 轮流使用保证数据平滑与容错
  if (/^s[hz]\d{6}$/.test(code) && !code.startsWith("sh000") && !code.startsWith("sz399")) {
    const st = minuteState(code);
    if (st.primary === "kpl") {
      // 主源 = KPL
      try {
        const k = await kplMinuteFetch(code);
        if (k) { st.fail = 0; return { ...k, source: "kpl" }; }
      } catch (e) { console.error(`[kpl-minute] ${code} error:`, e?.message || e); }
      // 主源失败(返回null或抛异常均落到此): 累计失败, 达到阈值切换为备源
      st.fail++;
      if (st.fail >= MINUTE_SWITCH_THRESHOLD) { st.primary = "tencent"; st.fail = 0; st.okOnBackup = 0; console.log(`[minute-src] ${code} -> tencent (kpl x${MINUTE_SWITCH_THRESHOLD} fail)`); }
      // 本轮回退腾讯, 保证有数据
      try { return { ...(await tencentMinuteFetch(code) || { code, prec: 0, points: [] }), source: "tencent" }; }
      catch (e) { console.error(`[tencent-minute] ${code} error:`, e?.message || e); return { code, prec: 0, points: [], source: "tencent" }; }
    } else {
      // 主源 = 腾讯(备源)
      try {
        const t = await tencentMinuteFetch(code);
        if (t && t.points.length) {
          st.fail = 0; st.okOnBackup++;
          // 备源连续成功若干次后, 探测一次主源(KPL)以判断是否恢复, 恢复则切回
          if (st.okOnBackup >= MINUTE_RECOVER_PROBE) {
            st.okOnBackup = 0;
            try {
              const k = await kplMinuteFetch(code);
              if (k) { st.primary = "kpl"; console.log(`[minute-src] ${code} -> kpl (recovered)`); return { ...k, source: "kpl" }; }
            } catch (e) { console.error(`[kpl-minute] ${code} recover probe error:`, e?.message || e); }
          }
          return { ...t, source: "tencent" };
        }
      } catch (e) { console.error(`[tencent-minute] ${code} error:`, e?.message || e); }
      // 备源失败: 累计失败, 达到阈值切回主源
      st.fail++;
      if (st.fail >= MINUTE_SWITCH_THRESHOLD) { st.primary = "kpl"; st.fail = 0; console.log(`[minute-src] ${code} -> kpl (tencent x${MINUTE_SWITCH_THRESHOLD} fail)`); }
      // 本轮回退 KPL
      try { return { ...(await kplMinuteFetch(code) || { code, prec: 0, points: [] }), source: "kpl" }; }
      catch (e) { console.error(`[kpl-minute] ${code} error:`, e?.message || e); return { code, prec: 0, points: [], source: "kpl" }; }
    }
  }
  const url = code.startsWith("us")
    ? `https://web.ifzq.gtimg.cn/appstock/app/usMinute/query?code=${encodeURIComponent(code)}`
    : `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${encodeURIComponent(code)}`;
  const text = await fetchText(url);
  const json = JSON.parse(text);
  const d = json?.data?.[code];
  const arr = d?.data?.data || [];
  const prec = num(d?.data?.prec || d?.qt?.[code]?.[4] || 0);
  // 返回 "HHMM price vol" -> [分钟索引, 价格]
  const pts = arr.map((s) => {
    const p = s.split(" ");
    return { t: p[0], p: num(p[1]) };
  });
  return { code, prec, points: pts };
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

/* ---------------- 个股所属板块/概念(F10概念, KPL) ---------------- */
// 从 kpl-api-docs 的 /api/v2/f10-concept 聚合: 行业/地域/概念(替代原东财 f58/f127/f128/f129)
async function handleStockBoards(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return { code: String(code || ""), industry: "", area: "", concepts: [] };
  const data = await kplFetch("/api/v2/f10-concept", { code: stockCode });
  const list = data?.List || [];
  const names = list.map((x) => String(x.CName || "").trim()).filter(Boolean);
  const area = names.find((n) => /(省|市|自治区|特别行政区)$/.test(n)) || "";
  const industry = names[0] || "";
  const concepts = names.filter((n) => n !== area && n !== industry);
  return { code: String(code || ""), industry, area, concepts };
}

/** 个股主营业务/公司信息(KPL company-info, 24h 缓存) */
async function handleStockProfile(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return { code: String(code || ""), mainBusiness: "" };
  const data = await kplFetch("/api/stock/company-info", { code: stockCode });
  const info = data?.data?.List?.XXList?.[0];
  return {
    code: String(code || ""),
    mainBusiness: info?.MainSale || "",
    name: data?.data?.Name || info?.CName || "",
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
          const row = getStock(code) || { code };
          row.industry = b.industry; row.area = b.area; row.concepts = b.concepts; row.boards_ts = Date.now();
          upsertStock(row);
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

/* ---------------- 个股实时行情(KPL 盘口 pankou, 5s 缓存) ---------------- */
// 从 kpl-api-docs 的 /api/v2/stock/pankou 聚合: 最新价/涨跌/换手/振幅/量比/PE/PB/市值/成交额
async function handleStockQuote(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return null;
  const data = await kplFetch("/api/v2/stock/pankou", { code: stockCode });
  const r = data?.real;
  if (!r) return null;
  return {
    code: String(code || ""),
    name: data.name || "",
    price: num(r.last_px),
    prev: num(data.preclose_px),
    change: num(r.px_change),
    pct: num(r.px_change_rate),
    open: num(r.open_px),
    high: num(r.high_px),
    low: num(r.low_px),
    amount: Math.round(num(r.total_turnover) / 10000), // 成交额(万元) = total_turnover(元)/10000
    vol: num(r.total_amount), // 成交量(手) = total_amount(手)
    turnover: num(r.turnover_ratio), // 换手率(%)
    amplitude: num(r.amplitude), // 振幅(%)
    volRatio: num(r.vol_ratio), // 量比
    pe: num(r.pe_rate), // 市盈率
    pb: num(r.dyn_pb_rate), // 市净率
    marketValue: num(r.market_value), // 总市值(元)
    time: String(data.day || ""),
  };
}

/* ---------------- 个股财务指标(KPL F10财务摘要, 24h 缓存) ---------------- */
// 从 kpl-api-docs 的 /api/v2/f10-finance-info 聚合: 营收/净利/ROE/毛利率/负债率等
async function handleStockFinance(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return null;
  const data = await kplFetch("/api/v2/f10-finance-info", { code: stockCode });
  const key = data?.key || [];
  const rows = (data?.List || []).filter((r) => Array.isArray(r) && r.length >= key.length);
  if (!rows.length) return null;
  const latest = rows[0]; // 最新一期(接口按日期降序)
  const idx = (name) => key.indexOf(name);
  const get = (name) => {
    const i = idx(name);
    return i >= 0 ? String(latest[i] || "").replace(/[元%]/g, "") : "";
  };
  return {
    code: String(code || ""),
    date: get("ShowDate") || get("Date") || "",
    revenue: get("GJZB_YYSR"),
    netProfit: get("GJZB_JLR"),
    dedProfit: get("GJZB_KFJLR"),
    eps: get("MGZB_MGSY"),
    bvps: get("MGZB_MGJZC"),
    roe: get("YLNL_JZCSYL"),
    roeYoY: get("YLNL_JZCSYLTB"),
    grossMargin: get("YLNL_XSMLL"),
    inventoryTurnover: get("YLNL_CHZZL"),
    debtRatio: get("ZBJG_ZCFZL"),
    profitYoY: get("CZNL_JLRTBZZL"),
    revenueYoY: get("CZNL_YYSRTBZZL"),
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

/* ---------------- 个股主力净额(KPL 主力资金 main-forces) ---------------- */
// 从 kpl-api-docs 的 /api/stock/main-forces 聚合: 主力净额/主动买卖/成交(主动口径)
async function handleStockMainForces(code) {
  const stockCode = String(code || "").replace(/^(sh|sz|bj)/, "").toLowerCase();
  if (!/^\d{6}$/.test(stockCode)) return Promise.reject(new Error("invalid stock code"));
  const data = await kplFetch("/api/stock/main-forces", { code: stockCode });
  if (!data || !data.summary) return null;
  const buy = data.buy || {};
  const sell = data.sell || {};
  return {
    code,
    day: data.day || "",
    netAmount: num(data.summary.net_amount) * 10000, // 主力净额(元) = 万元×10000
    totalAmount: num(data.summary.total_amount) * 10000, // 主动买卖成交额(元) = 万元×10000
    buyAmount: num(buy.amount) * 10000,
    sellAmount: num(sell.amount) * 10000,
    buyRatio: num(buy.ratio),
    sellRatio: num(sell.ratio),
    mainForce: String(data.summary.main_force || ""),
  };
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
    sentiment: { plateId: "", bullishCount: 0, bearishCount: 0, totalStockCount: 0, netBullish: 0, sentimentScore: 0, sentimentLevel: "", sentimentDesc: "", stockSamples: [] },
    riseFall: { limitUpCount: 0, limitDownCount: 0, blownLimitUpCount: 0, brokenLimitUpCount: 0, blownLimitUpRate: 0, yesterdayLimitUpPerf: 0, yesterdayBrokenPerf: 0, date: "", trendData: [] },
  };
}

/* ---------------- 市场情绪v2: 基于 kpl 三接口 (mood / sentiment-indicator / rise-fall) ---------------- */
// 降API压力优化: rise-fall 返回的 250 日历史趋势 + 昨日表现是"每日变化"的低频数据,
// 不必随 mood 每 15s 轮询; 用较长 TTL 缓存(5min)解耦, 约 20 倍削减该接口调用量。
// 实时涨停/跌停家数已由 mood API 提供, 不受影响。cached 失败会自动回退旧数据。
const MS_RISE_FALL_TTL = 5 * 60 * 1000; // 5 分钟
// 市场情绪轮询时段: 每日 08:59 - 15:00(收盘)。15:00 后停止轮询并定格数据, 次日 08:59 自动恢复。
// 返回 { active, state, label } state = "polling" | "stopped"
function marketSentimentPollState(now = new Date()) {
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
    // 使用 allSettled 防止单个API失败拖垮整体; rise-fall 走 5min 缓存降低调用频率
    const results = await Promise.allSettled([
      kplFetch("/api/market/mood"),
      kplFetch("/api/market/sentiment-indicator"),
      cached("kpl-rise-fall", MS_RISE_FALL_TTL, () => kplFetch("/api/market/rise-fall")),
    ]);

    const mood = results[0].status === "fulfilled" ? results[0].value : null;
    const sentimentInd = results[1].status === "fulfilled" ? results[1].value : null;
    const riseFall = results[2].status === "fulfilled" ? results[2].value : null;

    // 如果 mood 接口失败: 回退到日内最后一次成功快照; 无快照则返回兜底结构
    if (!mood) {
      console.error("[market-sentiment-v2] mood API failed, results:", results.map(r => r.status));
      const snap = loadMsSnapshot();
      if (snap) return { ...snap, fromCache: true, refetch: "fallback-snapshot" };
      return msFallbackPayload();
    }

    // --- mood ---
    const upCount = mood?.上涨家数 ?? 0;
    const downCount = mood?.下跌家数 ?? 0;
    const limitUp = mood?.涨停家数 ?? 0;
    const limitDown = mood?.跌停家数 ?? 0;
    const turnover = mood?.全市场流通量 ?? 0;
    const prevTurnover = mood?.前日流通量 ?? 0;
    const ratio = mood?.涨跌比 ?? 1;
    const marketColor = mood?.市场颜色 ?? 0;
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

    // --- sentiment-indicator ---
    const bullishCodes = sentimentInd?.bullish_codes || [];
    const bearishCodes = sentimentInd?.bearish_codes || [];
    const allStocks = sentimentInd?.all_stocks || [];
    let bullishCount = bullishCodes.length;
    let bearishCount = bearishCodes.length;
    const totalStockCount = allStocks.length;
    let stockSamples = [];

    // 若bullish/bearish为空，通过all_stocks实时查询涨跌分布
    if (bullishCount === 0 && bearishCount === 0 && allStocks.length > 0) {
      const sample = allStocks.slice(0, 20);
      const sinaCodes = sample.map(c => c.startsWith("6") ? `sh${c}` : `sz${c}`);
      try {
        const text = await fetchTextAny(`https://hq.sinajs.cn/list=${sinaCodes.join(",")}`, {
          referer: "https://finance.sina.com.cn/", gbk: true, timeout: 5000,
        });
        const re = /hq_str_(\w+)="([^"]*)"/g;
        let m;
        while ((m = re.exec(text))) {
          const f = m[2].split(",");
          if (f.length >= 4 && f[0]) {
            const prev = parseFloat(f[2]);
            const cur = parseFloat(f[3]);
            if (isFinite(prev) && isFinite(cur)) {
              if (cur > prev) bullishCount++;
              else if (cur < prev) bearishCount++;
              stockSamples.push({
                code: m[1].slice(2), // 去掉sh/sz前缀
                name: f[0],
                price: cur,
                change: ((cur - prev) / prev * 100).toFixed(2),
              });
            }
          }
        }
      } catch (e) {
        console.error("[sentiment] stock quote fetch failed:", e.message);
      }
    }

    // --- rise-fall ---
    const rf = riseFall || {};
    const rawData = Array.isArray(rf?.raw_data) ? rf.raw_data : [];
    // 合并进本地存储(实时更新当天数据, 新增替换最旧; 当日数据实时落盘)
    const stored = mergeMsTrend(rawData);
    // 从本地存储取最近半年趋势数据(最新在前), 供图表使用
    const trendData = msTrendFromStore();

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
        plateId: sentimentInd?.plate_id || "",
        bullishCount, bearishCount, totalStockCount,
        netBullish: bullishCount - bearishCount,
        sentimentScore, sentimentLevel, sentimentDesc,
        stockSamples, // 成分股列表
      },
      riseFall: {
        limitUpCount: rf?.limit_up_count ?? 0,
        limitDownCount: rf?.limit_down_count ?? 0,
        // 炸板 = raw_data 最新一条第5字段 r[5]; 炸板率 = r[5]/(涨停数 + r[5]) 与上游自洽
        blownLimitUpCount: rawData[0] ? (rawData[0][5] || 0) : (rf?.blown_limit_up_count ?? 0),
        brokenLimitUpCount: rf?.broken_limit_up_count ?? 0,
        blownLimitUpRate: rf?.blown_limit_up_rate ?? 0,
        yesterdayLimitUpPerf: rf?.yesterday_limit_up_performance ?? 0,
        yesterdayBrokenPerf: rf?.yesterday_broken_performance ?? 0,
        date: rf?.date ?? "",
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

/* ---------------- 市场情绪新闻: 基于 kpl.liuhepc.cn API (替代原Python插件) ---------------- */
async function handleNewsAnalystKPL() {
  try {
    const news = await kplFetch("/api/advanced/news-flash", { page_size: 30 });
    const items = news?.data || [];
    if (!items.length) {
      return { success: true, fetchTime: new Date().toISOString(), platformStats: { success: 0, total: 0 }, flowData: null, sentimentData: null, hotTopics: [], stockNews: [] };
    }
    // 提取关键词做情绪分析
    const positiveKw = ["涨", "升", "增", "利好", "突破", "创新高", "反弹", "放量", "拉升", "资金流入"];
    const negativeKw = ["跌", "降", "减", "利空", "破位", "新低", "回调", "缩量", "流出", "风险"];
    let posCount = 0, negCount = 0;
    const stockNews = items.map(item => {
      const title = item.Title || "";
      let score = 0;
      for (const kw of positiveKw) { if (title.includes(kw)) score += 10; }
      for (const kw of negativeKw) { if (title.includes(kw)) score -= 10; }
      if (score > 0) posCount++;
      else if (score < 0) negCount++;
      return {
        platform: item.Source || "开盘啦",
        category: item.ZSName || "",
        title,
        content: title,
        matchedKeywords: [],
        score,
      };
    });
    const total = items.length;
    const sentimentIndex = total > 0 ? Math.round((posCount / total) * 100) : 50;
    const sentimentClass = sentimentIndex >= 60 ? "乐观" : sentimentIndex >= 40 ? "中性" : "悲观";
    // 提取热门话题 (按板块名聚类)
    const topicMap = {};
    for (const item of items) {
      const name = item.ZSName || "";
      if (name) {
        topicMap[name] = (topicMap[name] || 0) + 1;
      }
    }
    const hotTopics = Object.entries(topicMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count, heat: Math.round(count / total * 100), crossPlatform: 1, sources: ["开盘啦"] }));
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
        platformDetails: [{ platform: "kpl", name: "开盘啦快讯", category: "快讯", count: total, score: sentimentIndex }],
      },
      sentimentData: { sentimentIndex, sentimentClass, flowFactor: 0, financeFactor: 0, keywordFactor: sentimentIndex, positiveCount: posCount, negativeCount: negCount },
      hotTopics,
      stockNews,
    };
  } catch (e) {
    console.error("[news-analyst] kpl error:", e.message);
    return { success: false, error: e.message };
  }
}

/* ---------------- 股票搜索(名称/拼音首字母→代码) ---------------- */
async function handleStockSearch(query) {
  if (!query || query.length < 1) return [];
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

// 聚合各 kpl 接口的"维度原始分", 归一化到 0-100 的 dims; 不在此处算最终分(权重由前端决定)
async function handleFengFrontBase(date) {
  // 6 个上游各自限时 8s(与 kplFetch 内部 8s 超时一致): kpl.liuhepc.cn 实测单接口 4.4-6.7s,
  // 此前 3s 限时导致 6 个上游全部超时 → windList 恒为空(风口/龙头股无法加载)。
  // 各上游仍并行(Promise.allSettled), 慢接口独立超时不阻塞其他字段; 外层的 15s 缓存保证刷新时秒回。
  const FENG_UPSTREAM_TTL = 8000;
  const results = await Promise.allSettled([
    withTimeout(kplFetch("/api/ladder/realtime-boards"), FENG_UPSTREAM_TTL, "realtime-boards"),
    withTimeout(kplFetch("/api/ladder/sector", date ? { date } : {}), FENG_UPSTREAM_TTL, "sector"),
    withTimeout(kplFetch("/api/fengk/yd-plate", date ? { date } : {}), FENG_UPSTREAM_TTL, "yd-plate"),
    withTimeout(kplFetch("/api/theme/hot"), FENG_UPSTREAM_TTL, "theme-hot"),
    withTimeout(kplFetch("/api/news/theme"), FENG_UPSTREAM_TTL, "theme-news"),
    withTimeout(kplFetch("/api/advanced/fengk-best"), FENG_UPSTREAM_TTL, "fengk-best"),
  ]);

  const [boardsRes, ladderSecRes, ydRes, themeRes, newsRes, fengBestRes] = results;

  // 涨停个股: 优先 realtime-boards, 为空用 fengk-best 兜底
  let boardList = [];
  if (boardsRes.status === "fulfilled") {
    const b = boardsRes.value || [];
    boardList = Array.isArray(b) ? b : b?.data || [];
  }
  if (!boardList.length && fengBestRes.status === "fulfilled") {
    const fb = fengBestRes.value || [];
    const raw = Array.isArray(fb) ? fb : fb?.data || [];
    boardList = raw.map((it) => ({
      stock_code: it.stock_code || it.code,
      stock_name: it.stock_name || it.name,
      limit_up_reason: it.limit_up_reason || it.reason || it.name || "",
      concepts: it.concepts || it.concept || "",
      consecutive_days: it.consecutive_days || it.days || 0,
      seal_amount: it.seal_amount || it.seal || 0,
      limit_up_price: it.limit_up_price || it.price || 0,
      change_pct: it.change_pct || it.pct || 0,
    }));
  }

  // 板块资金 [["芯片",858.32], ...]
  let ydList = [];
  if (ydRes.status === "fulfilled") {
    const yd = ydRes.value || {};
    const list = Array.isArray(yd) ? yd : yd.list;
    if (Array.isArray(list)) ydList = list;
  }

  // 热门题材(位置越靠前越热)
  let themeList = [];
  if (themeRes.status === "fulfilled") {
    const th = themeRes.value || {};
    const themes = Array.isArray(th) ? th : th.themes;
    if (Array.isArray(themes)) themeList = themes;
  }

  // 题材新闻
  let newsList = [];
  if (newsRes.status === "fulfilled") {
    const ns = newsRes.value || {};
    const list = Array.isArray(ns) ? ns : ns.List;
    if (Array.isArray(list)) newsList = list;
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

  // 板块连板: 实时连板梯队(权威连板来源, 含真实 consecutive_days ≥ 2)
  let ladderSectors = [];
  if (ladderSecRes.status === "fulfilled") {
    const ls = ladderSecRes.value || {};
    const sectors = Array.isArray(ls) ? ls : ls.sectors;
    if (Array.isArray(sectors)) ladderSectors = sectors;
  }
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
    date: date || (ydRes.status === "fulfilled" ? ydRes.value?.plate || "" : ""),
    source: {
      boards: boardsRes.status === "fulfilled" && boardList.length > 0,
      ydPlate: ydRes.status === "fulfilled",
      theme: themeRes.status === "fulfilled",
      news: newsRes.status === "fulfilled",
      fengBest: fengBestRes.status === "fulfilled",
    },
    windList: enriched.slice(0, 30),
  };
}
/* ------------------------------------------------------------- */

/* ---------------- 主机路由表 ---------------- */
const routes = {
  "/api/quotes": async (q) => handleQuotes(q.get("codes") || ""), // 内部按代码独立缓存(TTL 1.5s)
  "/api/minute": async (q) =>
    cached(`minute:${q.get("code")}`, 5000, () => handleMinute(q.get("code") || "sh000001")),
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
    const base = await cached(`fengk-front:${date}`, 15000, () => handleFengFrontBase(date));
    const windList = (base.windList || []).map((w) => ({ ...w, score: fengWeightedScore(w.dims, weights) }));
    windList.sort((a, b) => b.score - a.score);
    return { ...base, weights, windList };
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
const PROTECTED_ROUTES = new Set(["/api/openrouter-usage"]);

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
      const allowed = (PROTECTED_ROUTES.has(u.pathname) ? protectedLimiter : apiLimiter)(clientIp(req));
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
  scheduleDailyBoardsRefresh(); // 每日行业/概念批量刷新(启动后立即检查一次, 之后每小时)
  scheduleMsDaily(); // 市场情绪收盘定格(15:00后保存离线快照, 每30s检查)
});
