/**
 * API 并行压力测试脚本 (纯 Node fetch/undici, 无外部依赖)
 * 用法: node stress.cjs <并发数> <时长秒> [url] [--same-ip | --multi-ip | --warm]
 *   --same-ip  固定同一 X-Forwarded-For (触发单IP限流, 验证防过载)
 *   --multi-ip 每请求随机IP (默认, 规避限流测真实并发吞吐)
 *   --warm      先发1次请求预热缓存再压测
 */
const { performance } = require("perf_hooks");
const http = require("http");

// 带 keep-alive 的专用连接池, 避免全局 fetch 默认连接复用差导致的客户端 TypeError
const agent = new http.Agent({ keepAlive: true, maxSockets: 4096, maxFreeSockets: 512 });

const args = process.argv.slice(2);
const idx = args.map((a) => a.startsWith("--")).indexOf(true);
const opts = idx === -1 ? [] : args.slice(idx);
const [concurrent = 100, duration = 10, url = "http://localhost:3000/api/health"] = idx === -1 ? args : args.slice(0, idx);
const C = parseInt(concurrent, 10);
const D = parseInt(duration, 10);
const ipMode = opts.includes("--same-ip") ? "same" : "multi";
const warm = opts.includes("--warm");
// --limit N: 模拟"前端调用机制"的并发上限(信号量), 限制同时在途请求数 N
const limitIdx = opts.indexOf("--limit");
const CAP = limitIdx !== -1 && opts[limitIdx + 1] ? parseInt(opts[limitIdx + 1], 10) : 0;

// 简单信号量: cap<=0 表示不限并发
let inFlight = 0;
let waiters = [];
function acquire() {
  if (CAP <= 0 || inFlight < CAP) { inFlight++; return Promise.resolve(); }
  return new Promise((r) => waiters.push(r));
}
function release() {
  inFlight--;
  const next = waiters.shift();
  if (next) { inFlight++; next(); }
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: "GET",
      headers,
      agent,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.setTimeout(10000, () => req.destroy(new Error("timeout_cause")));
    req.on("error", reject);
    req.end();
  });
}

let sent = 0, ok = 0, err = 0, status429 = 0, status5xx = 0;
const errCodes = {};
const latencies = [];
let running = true;
const r = () => Math.floor(Math.random() * 254) + 1;

async function one() {
  await acquire();
  const start = performance.now();
  const headers = {};
  if (ipMode === "multi") headers["X-Forwarded-For"] = `${r()}.${r()}.${r()}.${r()}`;
  else headers["X-Forwarded-For"] = "10.0.0.1";
  try {
    const res = await get(url, headers);
    const ms = performance.now() - start;
    latencies.push(ms);
    sent++;
    if (res.statusCode === 200) ok++;
    else {
      err++;
      if (res.statusCode === 429) status429++;
      else if (res.statusCode >= 500) status5xx++;
    }
  } catch (e) {
    const cause = (e && e.message) || e.name || "unknown";
    errCodes[cause] = (errCodes[cause] || 0) + 1;
    err++; sent++;
  } finally {
    release();
  }
}

async function worker() {
  while (running) await one();
}

async function main() {
  if (warm) { try { await get(url, {}); } catch {} }
  const tasks = [];
  for (let i = 0; i < C; i++) tasks.push(worker());
  setTimeout(() => { running = false; }, D * 1000);
  await Promise.all(tasks);
  report();
}

function report() {
  if (latencies.length === 0) { console.log("无请求完成"); process.exit(0); }
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p = (q) => latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)];
  const rps = sent / D;
  console.log(`\n=== 压测结果 [并发=${C} 时长=${D}s 模式=${ipMode}-ip${CAP > 0 ? ` 并发上限=${CAP}` : ""}${warm ? " 预热+缓存" : ""}] ===`);
  console.log(`目标: ${url}`);
  console.log(`总请求: ${sent}  |  吞吐: ${rps.toFixed(1)} req/s`);
  console.log(`响应时间: 平均=${avg.toFixed(1)}ms  P95=${p(0.95).toFixed(1)}ms  P99=${p(0.99).toFixed(1)}ms  Max=${latencies[latencies.length - 1].toFixed(1)}ms`);
  console.log(`成功(200)=${ok}  失败=${err}  429限流=${status429}  5xx=${status5xx}`);
  console.log(`错误率: ${(err / sent * 100).toFixed(2)}%`);
  if (Object.keys(errCodes).length) console.log(`错误码: ${JSON.stringify(errCodes)}`);
  process.exit(0);
}

main();