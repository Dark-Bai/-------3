#!/usr/bin/env node
/**
 * 美债收益率历史存档下载器
 * 从 treasury.gov 官方存档(daily-treasury-rate-archives)拉取完整年份的日度收益率 CSV,
 * 存入 server/treasury-rates/<year>.csv, 随代码库分发; 服务端历史曲线接口从该目录读取。
 *
 * 用法: node scripts/update-treasury-archive.cjs [起始年] [截止年]
 *   默认: 2001 ~ 去年(去年之前均为完整年份, 数据不再变化)
 * 建议每年 1 月重跑一次, 把刚过去的完整年份补进存档。
 */
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "server", "treasury-rates");
const thisYear = new Date().getFullYear();
const startYear = parseInt(process.argv[2], 10) || 2001;
const endYear = parseInt(process.argv[3], 10) || thisYear - 1;

const urlOf = (y) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&_format=csv`;

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (let y = startYear; y <= endYear; y++) {
    const file = path.join(OUT_DIR, `${y}.csv`);
    process.stdout.write(`[${y}] 下载中… `);
    try {
      const resp = await fetch(urlOf(y), { signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      // 存档页对异常年份返回 HTML 错误页, 简单校验 CSV 表头
      if (!/^\s*"?Date"?\s*,/i.test(text)) throw new Error("返回内容不是 CSV");
      fs.writeFileSync(file, text);
      console.log(`OK (${(text.length / 1024).toFixed(1)} KB) -> ${path.relative(process.cwd(), file)}`);
    } catch (e) {
      console.log(`失败: ${e.message}`);
      process.exitCode = 1;
    }
  }
})();
