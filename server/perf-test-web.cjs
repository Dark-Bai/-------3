/**
 * 网页数据源性能测试(东方财富公开接口)
 * 测量涨停池/炸板池/跌停池/涨跌家数 4 路数据源的响应时间与成功率,
 * 对比: 单路串行 vs 生产环境 Promis e.allSettled 并行。
 */
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const EM_UT = "7eea3edcaed734bea9cbfc24409ed989";

function todayCompact() {
  const d = new Date();
  let off = 0;
  const w = d.getDay();
  if (w === 0) off = -2; else if (w === 6) off = -1;
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function fetchTextEM(url, { referer = "https://quote.eastmoney.com/", timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "*/*", Referer: referer },
      signal: ctrl.signal,
    });
    return Buffer.from(await resp.arrayBuffer()).toString("utf-8");
  } finally {
    clearTimeout(timer);
  }
}

async function emGet(url) {
  const text = await fetchTextEM(url);
  return JSON.parse(text);
}

async function fetchTopicPool(kind) {
  const url = `https://push2ex.eastmoney.com/getTopic${kind}?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${todayCompact()}`;
  const j = await emGet(url);
  const pool = Array.isArray(j.data.pool) ? j.data.pool : [];
  return { count: typeof j.data.tc === "number" ? j.data.tc : pool.length, pool };
}

async function fetchBreadth() {
  const url = "https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.000001,0.399001&fields=f104,f105,f106&np=1&fltt=2&invt=2";
  const j = await emGet(url);
  const diff = j?.data?.diff || [];
  const sum = (f) => diff.reduce((a, b) => a + (Number(b[f]) || 0), 0);
  return { up: sum("f104"), down: sum("f105"), flat: sum("f106") };
}

/** 生产环境并行模型 */
async function runParallel() {
  const t0 = Date.now();
  const results = await Promise.allSettled([
    fetchTopicPool("ZTPool"),
    fetchTopicPool("ZBPool"),
    fetchTopicPool("DTPool"),
    fetchBreadth(),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const zt = results[0].status === "fulfilled" ? results[0].value : null;
  return { ms: Date.now() - t0, ok, total: results.length, ztCount: zt?.count ?? 0 };
}

/** 单路串行模型(对比) */
async function runSerial() {
  const t0 = Date.now();
  const zt = await fetchTopicPool("ZTPool");
  const zb = await fetchTopicPool("ZBPool");
  const dt = await fetchTopicPool("DTPool");
  const breadth = await fetchBreadth();
  return { ms: Date.now() - t0, ok: 4, total: 4, ztCount: zt.count ?? 0 };
}

(async () => {
  const N = 8;
  const par = [];
  const ser = [];
  for (let i = 0; i < N; i++) {
    par.push(await runParallel());
    ser.push(await runSerial());
  }
  const avg = (a) => a.reduce((s, x) => s + x.ms, 0) / a.length;
  const p50 = (a) => { const s = [...a].sort((x, y) => x.ms - y.ms); return s[Math.floor(s.length / 2)].ms; };
  const max = (a) => Math.max(...a.map((x) => x.ms));
  const okRate = (a) => (a.filter((x) => x.ok === x.total).length / a.length) * 100;

  console.log("\n===== 网页数据源性能测试(东方财富) =====", new Date().toLocaleString());
  console.log(`测试次数: ${N} 次\n`);
  console.log("【并行模型 - 生产环境采用】(4 路 Promise.allSettled)");
  console.log(`  成功率: ${okRate(par).toFixed(0)}%`);
  console.log(`  平均: ${avg(par).toFixed(0)}ms  P50: ${p50(par)}ms  Max: ${max(par)}ms`);
  console.log(`  最近一次涨停家数: ${par[N - 1].ztCount}`);
  console.log(`  各次耗时: ${par.map((x) => x.ms).join(", ")}ms`);
  console.log("\n【串行模型 - 对比】(4 路顺序请求)");
  console.log(`  成功率: ${okRate(ser).toFixed(0)}%`);
  console.log(`  平均: ${avg(ser).toFixed(0)}ms  P50: ${p50(ser)}ms  Max: ${max(ser)}ms`);
  console.log(`  各次耗时: ${ser.map((x) => x.ms).join(", ")}ms`);
  console.log(`\n并行相对串行提速: ${(avg(ser) / avg(par)).toFixed(1)}x`);
})();