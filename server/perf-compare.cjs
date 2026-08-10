/**
 * 后端接口性能对比压测(优化前后统一基准)
 * 用法: node server/perf-compare.cjs [BASE]
 * 输出: 各接口 平均/p50/p95/最大 耗时与成功率, 与优化前基线(见 docs/后端全面优化报告.md)对照
 */
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const BASE = process.argv[2] || "http://127.0.0.1:3001";

async function bench(name, url, n, conc) {
  const samples = [];
  let ok = 0, errs = 0;
  let next = 0;
  const worker = async () => {
    while (next < n) {
      const i = next++;
      const s = Date.now();
      try {
        const r = await fetch(BASE + url, { signal: AbortSignal.timeout(25000) });
        if (r.ok) { ok++; } else { errs++; }
        samples.push(Date.now() - s);
      } catch { errs++; samples.push(Date.now() - s); }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)] || samples[samples.length - 1];
  const p = (n) => String(n).padStart(6);
  console.log(`${name.padEnd(30)} avg=${p(Math.round(sum / samples.length))}ms p50=${p(p50)}ms p95=${p(p95)}ms max=${p(samples[samples.length - 1])}ms ok=${ok} err=${errs}`);
}

(async () => {
  console.log("===== 本地后端性能压测 =====", new Date().toLocaleString(), "base=", BASE);
  console.log("(冷启动含首次上游抓取; 连续请求命中 TTL 缓存会显著拉低耗时)\n");
  await bench("/api/quotes·5指数", "/api/quotes?codes=sh000001,sz399001,sz399006,sh000688,usVIX", 10, 5);
  await bench("/api/minutes·4指数", "/api/minutes?codes=sh000001,sz399001,sz399006,sh000688", 8, 4);
  await bench("/api/minute·个股sh600519", "/api/minute?code=sh600519", 8, 4);
  await bench("/api/stock-detail·sh600519", "/api/stock-detail?code=sh600519", 6, 3);
  await bench("/api/stock-quote·sh600519", "/api/stock-quote?code=sh600519", 8, 4);
  await bench("/api/monitor", "/api/monitor", 8, 4);
})();
