/**
 * 个股详情本地数据库 (SQLite, 基于 node:sqlite 内置模块, 无第三方依赖)
 *
 * 设计目标:
 *  - 后端把聚合抓取的个股数据落库, 前端通过 /api/stock-detail 从库读取
 *  - 按需抓取: 仅当用户打开某只个股的小窗时才触发该股的 API 抓取/刷新
 *  - 失败回退: 上游 API 出错时, 直接返回库中最近一次成功数据
 *  - 行业/概念等长期数据: 永久保留, 不删除; 至多按 TTL 后台刷新
 */

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "stock-db.sqlite");

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS stocks (
    code          TEXT PRIMARY KEY,          -- 证券代码, 如 sh600519
    name          TEXT,                      -- 证券名称
    -- 长期数据(永久保留, 不删除)
    industry      TEXT,                      -- 所属行业
    area          TEXT,                      -- 所属地域
    concepts      TEXT,                      -- 概念列表 (JSON 数组)
    main_business TEXT,                      -- 主营业务
    boards_ts     INTEGER,                   -- 行业/概念最近刷新时间
    profile_ts    INTEGER,                   -- 主营业务最近刷新时间
    -- 实时/短期数据(按 TTL 刷新, 失败保留旧值)
    quote         TEXT,     quote_ts     INTEGER,  -- 实时行情(盘口)
    minute        TEXT,     minute_ts    INTEGER,  -- 分时数据
    main_forces   TEXT,     main_forces_ts INTEGER, -- 主力净额
    created_at    INTEGER,
    updated_at    INTEGER
  );
`);

const j = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const u = (v) => (v === null || v === undefined ? null : JSON.parse(v));

/** 读取一只股票的完整记录; 不存在返回 null */
function getStock(code) {
  const row = db.prepare(`SELECT * FROM stocks WHERE code = ?`).get(code);
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    industry: row.industry,
    area: row.area,
    concepts: u(row.concepts),
    main_business: row.main_business,
    boards_ts: row.boards_ts,
    profile_ts: row.profile_ts,
    quote: u(row.quote),
    quote_ts: row.quote_ts,
    minute: u(row.minute),
    minute_ts: row.minute_ts,
    main_forces: u(row.main_forces),
    main_forces_ts: row.main_forces_ts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 全量覆写某只股票记录(调用方须先读出旧记录再合并新值, 避免清空未刷新字段)
 * 行业/概念/主营业务等"长期字段"只在本次成功抓到时才更新, 因此不会被清空。
 */
function upsertStock(s) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO stocks (code, name, industry, area, concepts, main_business,
                        boards_ts, profile_ts, quote, quote_ts, minute, minute_ts,
                        main_forces, main_forces_ts, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      industry = COALESCE(excluded.industry, stocks.industry),
      area = COALESCE(excluded.area, stocks.area),
      concepts = COALESCE(excluded.concepts, stocks.concepts),
      main_business = COALESCE(excluded.main_business, stocks.main_business),
      boards_ts = excluded.boards_ts,
      profile_ts = excluded.profile_ts,
      quote = COALESCE(excluded.quote, stocks.quote),
      quote_ts = excluded.quote_ts,
      minute = COALESCE(excluded.minute, stocks.minute),
      minute_ts = excluded.minute_ts,
      main_forces = COALESCE(excluded.main_forces, stocks.main_forces),
      main_forces_ts = excluded.main_forces_ts,
      updated_at = excluded.updated_at
  `).run(
    s.code, s.name ?? null, s.industry ?? null, s.area ?? null,
    s.concepts ? j(s.concepts) : null, s.main_business ?? null,
    s.boards_ts ?? null, s.profile_ts ?? null,
    s.quote ? j(s.quote) : null, s.quote_ts ?? null,
    s.minute ? j(s.minute) : null, s.minute_ts ?? null,
    s.main_forces ? j(s.main_forces) : null, s.main_forces_ts ?? null,
    s.created_at ?? now, now
  );
}

/** 库内个股总数(用于诊断/运维) */
function stockCount() {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM stocks`).get();
  return r ? r.c : 0;
}

module.exports = { getStock, upsertStock, stockCount, DB_PATH };