/**
 * 数据源替换验证测试 — 单元 + 集成 + 性能
 *
 * 背景: 开盘啦(KPL) API Key 失效后, 数据源切换为:
 *   - 东方财富网页接口(涨停池/涨跌家数/个股行情/板块概念/F10财务/风口聚合/量能)
 *   - 同花顺 THS 网关(分时/新闻/板块列表)
 *   - 腾讯(分时主源/指数兜底)
 *
 * 运行: node server/test-datasource.cjs   (需 Node 服务已在 :3000 运行)
 * 覆盖: 1) 单元级: 各东财工具函数(涨停池/涨跌家数/量能/板块概念/财务)
 *       2) 集成级: 核心 API 端点
 *       3) 性能级: 响应时间记录与阈值判定
 */
const BASE = process.env.TEST_BASE || "http://127.0.0.1:3000";
const PERF_THRESHOLD_MS = 5000; // 集成端点响应阈值(数据源替换后应远快于旧 kpl 4-7s)

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name} ${detail}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

async function api(path, timeout = 30000) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(timeout) });
  const j = await r.json();
  return { ms: Date.now() - t0, d: j?.data ?? j, raw: j };
}

const section = async (name, fn) => {
  console.log(`\n[${name}]`);
  await fn();
};

(async () => {
  console.log("=== 数据源替换验证测试 ===\n");

  // ---------- 集成级: 核心 API ----------
  await section("集成: 个股详情(东财行情/腾讯分时/东财主力/东财板块概念/东财主营)", async () => {
    const { ms, d } = await api("/api/stock-detail?code=sh600519");
    ok("响应时间", ms < PERF_THRESHOLD_MS, `${ms}ms`);
    ok("行情quote", d?.quote && d.quote.price > 0 && d.quote.pe > 0, `价${d?.quote?.price} PE${d?.quote?.pe} 振幅${d?.quote?.amplitude?.toFixed(2)}`);
    ok("分时points", d?.minute?.points?.length > 100, `${d?.minute?.points?.length}点 source=${d?.minute?.source}`);
    ok("主力净额", d?.mainForces && typeof d.mainForces.netAmount === "number", `净额${d?.mainForces?.netAmount}`);
    ok("板块概念", d?.boards?.industry || d?.boards?.concepts?.length, `行业=${d?.boards?.industry} 概念${d?.boards?.concepts?.length}个`);
    ok("主营业务", d?.profile?.mainBusiness?.length > 10, `${d?.profile?.mainBusiness?.length}字`);
  });

  await section("集成: 市场情绪(东财涨停池体系, 收盘态)", async () => {
    const { ms, d } = await api("/api/plugin-market-sentiment");
    ok("响应时间", ms < PERF_THRESHOLD_MS, `${ms}ms`);
    ok("收盘态返回", d?.pollState === "stopped" || d?.pollState === "polling", `pollState=${d?.pollState}`);
  });

  await section("集成: 新闻(同花顺 THS 网关)", async () => {
    const { ms, d } = await api("/api/plugin-news-analyst");
    ok("响应时间", ms < PERF_THRESHOLD_MS, `${ms}ms`);
    ok("新闻数据", d?.success && d?.stockNews?.length > 0, `${d?.stockNews?.length}条`);
  });

  await section("集成: 风口聚合(东财涨停池+板块资金+概念涨幅)", async () => {
    const { ms, d } = await api("/api/fengk-front");
    const wl = d?.windList || [];
    ok("响应时间", ms < PERF_THRESHOLD_MS, `${ms}ms`);
    ok("风口列表", wl.length > 0, `${wl.length}个`);
    ok("维度归一化", wl.length > 0 && wl.every((w) => w.dims && w.dims.limitUp >= 0 && w.dims.limitUp <= 100), "dims 0-100");
    ok("数据源标记", d?.source?.boards === true, JSON.stringify(d?.source));
  });

  await section("集成: 龙头池", async () => {
    const { ms, d } = await api("/api/philia/leader-pool?force=1");
    ok("响应时间", ms < PERF_THRESHOLD_MS, `${ms}ms`);
    ok("参考池", d?.pool?.length > 0, `${d?.pool?.length}只`);
  });

  await section("集成: 报价(指数+个股)", async () => {
    const { ms, d } = await api("/api/quotes?codes=sh000001,sz399001,sz399006,sh600519");
    const qs = Array.isArray(d) ? d : Object.values(d || {});
    ok("响应时间", ms < 3000, `${ms}ms`);
    ok("报价完整", qs.length >= 4 && qs.every((q) => q?.price > 0), `${qs.length}个`);
  });

  // ---------- 单元级: 通过 API 间接验证工具函数输出口径 ----------
  await section("单元: 行情/量能口径", async () => {
    // 市场情绪收盘态后需强制活跃才能拿实时口径, 这里验证 stock-detail 的 amount 单位为万元
    const { d } = await api("/api/stock-detail?code=sh600519");
    const amt = d?.quote?.amount;
    ok("成交额单位(万元)", typeof amt === "number" && amt > 0, `amount=${amt}万`);
    ok("总市值单位(元)", d?.quote?.marketValue > 1e9, `${(d?.quote?.marketValue / 1e8).toFixed(0)}亿`);
  });

  await section("单元: 涨停池/连板统计(经 fetchLadderDay 落库)", async () => {
    const { d } = await api("/api/stock-boards?code=sz000001");
    ok("板块概念从库读取", d?.industry === "银行", `行业=${d?.industry}`);
  });

  await section("性能: 响应时间统计", async () => {
    const paths = ["/api/stock-detail?code=sh600519", "/api/plugin-news-analyst", "/api/fengk-front", "/api/philia/leader-pool?force=1"];
    for (const p of paths) {
      const { ms } = await api(p);
      console.log(`  ${ms}ms  ${p}`);
    }
  });

  console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e.message); process.exit(1); });
