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

/* 连接池机制(同步 API 下的"读写分离多连接"):
 *  - db(写连接): 负责 DDL 与所有写操作(upsert/setMeta/事务)
 *  - dbRead(只读连接池: 2 路轮询): 负责高频读(getStock/getTrends/计数等)
 *  - SQLite WAL 下读写连接天然不互斥; 读连接走独立 cache_size, 避免读操作
 *    与写操作争用同一连接的页缓存, 降低高并发读的锁等待与 I/O 抖动。
 *  - 只读连接在写连接建表之后打开, 保证库文件已就绪。 */

const db = new DatabaseSync(DB_PATH);

/* 数据库性能优化(DatabaseSync 为同步 API, 会阻塞事件循环):
 *  - WAL: 读写并发不互斥, 读取不再阻塞写入, 显著降低高并发下的锁等待
 *  - synchronous=NORMAL: WAL 下崩溃最多丢最近提交, 换取约 2~10x 写吞吐
 *  - busy_timeout: 写入遇到锁时等待而非立即报错, 避免并发写冲突
 *  - temp_store=MEMORY / cache_size: 排序/临时结果走内存, 减少磁盘 I/O */
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -20000;
`);

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

  -- 市场情绪涨跌停趋势(历史累计, 按交易日一行, 永久保留)
  CREATE TABLE IF NOT EXISTS market_trend (
    date        TEXT PRIMARY KEY,   -- 交易日 YYYY-MM-DD
    limit_up    INTEGER,            -- 涨停家数
    limit_down  INTEGER,            -- 跌停家数
    broken_up   INTEGER,            -- 炸板家数
    blown_up    INTEGER,            -- 破板家数
    blown_rate  REAL,               -- 炸板率(%)
    updated_at  INTEGER
  );

  -- 连板梯队趋势(基于 limit-up-ladder, 按交易日一行, 永久保留)
  CREATE TABLE IF NOT EXISTS ladder_trend (
    date              TEXT PRIMARY KEY,   -- 交易日 YYYY-MM-DD
    first_board       INTEGER,            -- 一板
    second_board      INTEGER,            -- 二板
    third_board       INTEGER,            -- 三板
    high_board        INTEGER,            -- 高度板
    ladder_rate       REAL,               -- 连板率(%)
    blown_rate        REAL,               -- 今日涨停破板率(%)
    yest_limitup_perf REAL,               -- 昨日涨停今表现(%)
    yest_ladder_perf  REAL,               -- 昨日连板今表现(%)
    yest_broken_perf  REAL,               -- 昨日破板今表现(%)
    comment           TEXT,               -- 市场评价
    updated_at        INTEGER
  );

  -- 键值元数据(如每日批量刷新标记, 持久化避免重启重复执行)
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- PHILIA AI: 加密存储的用户 API Key 与配置(单行, id 恒为 1)
  CREATE TABLE IF NOT EXISTS ai_key (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    provider  TEXT,                 -- 'openrouter'
    enc_key   TEXT,                 -- AES-256-GCM 密文(base64)
    enc_iv    TEXT,                 -- 初始化向量 + authTag(JSON base64)
    model     TEXT,                 -- 上次选择的模型
    skills    TEXT,                 -- 上次选择的技能(JSON 数组)
    updated_at INTEGER
  );

  -- PHILIA AI: 分析结果(降频缓存, 以 cache_key 为主键去重)
  CREATE TABLE IF NOT EXISTS ai_analysis (
    cache_key   TEXT PRIMARY KEY,   -- sha256(日期+模型+技能哈希)
    date        TEXT,               -- 交易日 YYYY-MM-DD
    model       TEXT,
    skills_hash TEXT,
    result      TEXT,               -- 结构化 JSON
    created_at  INTEGER,
    updated_at  INTEGER
  );
`);

/* 索引结构优化: 针对常用查询条件建索引, 避免全表扫描。
 *  - stocks.code 已是主键(SQLite 自动建唯一索引), 主键查询 O(1)
 *  - market_trend.date 已是主键, ORDER BY date 天然走索引
 *  - 为"按时间筛选/清理"场景补索引: updated_at(冷热归档/清理)、
 *    以及按行业/概念刷新时间定位 staleness 的场景。 */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_stocks_updated ON stocks(updated_at);
  CREATE INDEX IF NOT EXISTS idx_stocks_boards_ts ON stocks(boards_ts);
  CREATE INDEX IF NOT EXISTS idx_trend_updated ON market_trend(updated_at);
`);

/* 只读连接池: 2 路只读连接分担高频读。WAL 下多读连接互不阻塞,
 * 建立索引后 SELECT 走覆盖索引/主键, 读连接几乎不产生写 WAL, 缓存友好。 */
const dbRead = [0, 1].map(() => {
  const c = new DatabaseSync(DB_PATH, { readOnly: true });
  c.exec(`PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -20000;`);
  return c;
});
let readCursor = 0; // 轮询游标, 把读请求打散到不同只读连接
// 返回当前只读连接对应的语句集(与 dbRead 数组一一对应)
const nextReadStmt = () => readStmt[readCursor++ % readStmt.length];

/* 预编译语句缓存: DatabaseSync 每次 prepare 都会走 SQL 解析/编译,
 * 高频调用(如 getStock/upsertStock)下重复 prepare 是纯开销, 这里模块加载时编译一次复用。
 * 读语句在每条只读连接上各编译一份(连接绑定须一一对应), 写语句仅写连接一份。 */
const READ_SQL = {
  getStock: `SELECT * FROM stocks WHERE code = ?`,
  getBoards: `SELECT code, name, industry, area, concepts, boards_ts FROM stocks WHERE code = ?`,
  count: `SELECT COUNT(*) AS c FROM stocks`,
  allCodes: `SELECT code FROM stocks`,
  getMeta: `SELECT value FROM meta WHERE key = ?`,
  getTrends: `SELECT date, limit_up AS limitUp, limit_down AS limitDown, broken_up AS brokenUp, blown_up AS blownUp, blown_rate AS blownRate FROM market_trend ORDER BY date ASC`,
  trendCount: `SELECT COUNT(*) AS c FROM market_trend`,
  getLadderTrend: `SELECT date, first_board AS firstBoard, second_board AS secondBoard, third_board AS thirdBoard, high_board AS highBoard, ladder_rate AS ladderRate, blown_rate AS blownRate, yest_limitup_perf AS yestLimitUpPerf, yest_ladder_perf AS yestLadderPerf, yest_broken_perf AS yestBrokenPerf, comment, updated_at AS updatedAt FROM ladder_trend ORDER BY date ASC`,
  getAiKey: `SELECT provider, enc_key AS encKey, enc_iv AS encIv, model, skills, updated_at AS updatedAt FROM ai_key WHERE id = 1`,
  getAiAnalysis: `SELECT date, model, skills_hash AS skillsHash, result, created_at AS createdAt, updated_at AS updatedAt FROM ai_analysis WHERE cache_key = ?`,
  listAiAnalyses: `SELECT cache_key AS cacheKey, date, model, skills_hash AS skillsHash, result, created_at AS createdAt, updated_at AS updatedAt FROM ai_analysis ORDER BY updated_at DESC LIMIT ?`,
};
// 每条只读连接各编译一份读语句(轮询时按当前连接取用)
const readStmt = dbRead.map((c) => {
  const s = {};
  for (const [k, sql] of Object.entries(READ_SQL)) s[k] = c.prepare(sql);
  return s;
});
const stmt = {
  upsertStock: db.prepare(`
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
  `),
  // 精简列: 行业/概念批量刷新只读/写这几列, 避免全行 SELECT * 与全 JSON 解析
  upsertBoards: db.prepare(`
    INSERT INTO stocks (code, name, industry, area, concepts, boards_ts, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      industry = COALESCE(excluded.industry, stocks.industry),
      area = COALESCE(excluded.area, stocks.area),
      concepts = COALESCE(excluded.concepts, stocks.concepts),
      boards_ts = excluded.boards_ts,
      updated_at = excluded.updated_at
  `),
  setMeta: db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  delMeta: db.prepare(`DELETE FROM meta WHERE key = ?`),
  upsertTrend: db.prepare(`
    INSERT INTO market_trend (date, limit_up, limit_down, broken_up, blown_up, blown_rate, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET
      limit_up   = excluded.limit_up,
      limit_down = excluded.limit_down,
      broken_up  = excluded.broken_up,
      blown_up   = excluded.blown_up,
      blown_rate = excluded.blown_rate,
      updated_at = excluded.updated_at
  `),
  upsertAiKey: db.prepare(`
    INSERT INTO ai_key (id, provider, enc_key, enc_iv, model, skills, updated_at)
    VALUES (1,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      provider  = excluded.provider,
      enc_key   = excluded.enc_key,
      enc_iv    = excluded.enc_iv,
      model     = excluded.model,
      skills    = excluded.skills,
      updated_at = excluded.updated_at
  `),
  upsertAiAnalysis: db.prepare(`
    INSERT INTO ai_analysis (cache_key, date, model, skills_hash, result, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(cache_key) DO UPDATE SET
      date        = excluded.date,
      model       = excluded.model,
      skills_hash = excluded.skills_hash,
      result      = excluded.result,
      updated_at  = excluded.updated_at
  `),
};

// upsertTrends 的批量写用独立语句(事务内复用), 兼容预编译缓存
const upsertTrendStmt = db.prepare(`
  INSERT INTO market_trend (date, limit_up, limit_down, broken_up, blown_up, blown_rate, updated_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(date) DO UPDATE SET
    limit_up   = excluded.limit_up,
    limit_down = excluded.limit_down,
    broken_up  = excluded.broken_up,
    blown_up   = excluded.blown_up,
    blown_rate = excluded.blown_rate,
    updated_at = excluded.updated_at
`);

// upsertLadderTrends 的批量写用独立语句(事务内复用)
const upsertLadderStmt = db.prepare(`
  INSERT INTO ladder_trend (date, first_board, second_board, third_board, high_board, ladder_rate, blown_rate, yest_limitup_perf, yest_ladder_perf, yest_broken_perf, comment, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(date) DO UPDATE SET
    first_board       = excluded.first_board,
    second_board      = excluded.second_board,
    third_board       = excluded.third_board,
    high_board        = excluded.high_board,
    ladder_rate       = excluded.ladder_rate,
    blown_rate        = excluded.blown_rate,
    yest_limitup_perf = excluded.yest_limitup_perf,
    yest_ladder_perf  = excluded.yest_ladder_perf,
    yest_broken_perf  = excluded.yest_broken_perf,
    comment           = excluded.comment,
    updated_at        = excluded.updated_at
`);

const j = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const u = (v) => (v === null || v === undefined ? null : JSON.parse(v));

/* 热点数据内存缓存(LRU + TTL): 行业/概念为日级静态数据, 前端榜单/详情反复读取,
 * 命中缓存可完全省去 SQLite I/O 与 JSON 反序列化, 把读延迟从 ~0.5ms 压到 ~0.01ms。
 *  - 容量上限 + 插入序淘汰, 防无界增长
 *  - 写路径(upsertStockBoards)主动失效对应 code, 保证不返回陈旧值 */
const BOARDS_CACHE_MAX = 20000;
const boardsCache = new Map(); // code -> { ts, data }
function boardsCacheGet(code) {
  const hit = boardsCache.get(code);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > 24 * 3600 * 1000) { boardsCache.delete(code); return undefined; } // 日级 TTL
  return hit.data;
}
function boardsCacheSet(code, data) {
  boardsCache.set(code, { ts: Date.now(), data });
  if (boardsCache.size > BOARDS_CACHE_MAX) {
    const oldest = boardsCache.keys().next().value; // 插入序最旧
    if (oldest !== undefined) boardsCache.delete(oldest);
  }
}
function boardsCacheDel(code) { boardsCache.delete(code); }

/** 读取一只股票的完整记录; 不存在返回 null */
function getStock(code) {
  return dbTimed("getStock", false, () => {
    const row = nextReadStmt().getStock.get(code);
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
  });
}

/** 精简读取行业/概念字段(供每日批量刷新用, 避免全行 SELECT * 与全 JSON 解析) */
function getStockBoards(code) {
  const cached = boardsCacheGet(code);
  if (cached !== undefined) return cached;
  return dbTimed("getStockBoards", false, () => {
    const row = nextReadStmt().getBoards.get(code);
    if (!row) return null;
    const data = {
      code: row.code,
      name: row.name,
      industry: row.industry,
      area: row.area,
      concepts: u(row.concepts),
      boards_ts: row.boards_ts,
    };
    boardsCacheSet(code, data);
    return data;
  });
}

/**
 * 全量覆写某只股票记录(调用方须先读出旧记录再合并新值, 避免清空未刷新字段)
 * 行业/概念/主营业务等"长期字段"只在本次成功抓到时才更新, 因此不会被清空。
 */
function upsertStock(s) {
  const now = Date.now();
  return dbTimed("upsertStock", true, () => {
    stmt.upsertStock.run(
      s.code, s.name ?? null, s.industry ?? null, s.area ?? null,
      s.concepts ? j(s.concepts) : null, s.main_business ?? null,
      s.boards_ts ?? null, s.profile_ts ?? null,
      s.quote ? j(s.quote) : null, s.quote_ts ?? null,
      s.minute ? j(s.minute) : null, s.minute_ts ?? null,
      s.main_forces ? j(s.main_forces) : null, s.main_forces_ts ?? null,
      s.created_at ?? now, now
    );
  });
}

/** 仅更新行业/概念等长期字段(供每日批量刷新用, 大幅减少写放大) */
function upsertStockBoards(code, name, industry, area, concepts, boardsTs) {
  const now = Date.now();
  dbTimed("upsertStockBoards", true, () => {
    stmt.upsertBoards.run(
      code, name ?? null, industry ?? null, area ?? null,
      concepts && concepts.length ? j(concepts) : null, boardsTs ?? null, now, now
    );
  });
  boardsCacheDel(code); // 写路径失效对应缓存, 防返回陈旧行业/概念
}

/** 库内个股总数(用于诊断/运维) */
function stockCount() {
  const r = nextReadStmt().count.get();
  return r ? r.c : 0;
}

/** 全部个股代码(供每日批量刷新行业/概念使用, 即"历史加载过的个股"全集) */
function allStockCodes() {
  return nextReadStmt().allCodes.all().map((r) => r.code);
}

/** 读取持久化键值元数据(如每日批量刷新标记) */
function getMeta(key) {
  const r = nextReadStmt().getMeta.get(key);
  return r ? r.value : null;
}

/** 写入持久化键值元数据 */
function setMeta(key, value) {
  stmt.setMeta.run(key, value);
}

/** 删除持久化键值元数据 */
function deleteMeta(key) {
  stmt.delMeta.run(key);
}

/* ---------------- 市场情绪离线数据(收盘定格) ---------------- */
// 收盘(15:00)后把当日最后一次成功数据持久化为"离线快照", 开盘重新拿到新数据后删除,
// 保证停止轮询期间前端始终展示定格数据。存储于 meta 表, 键 ms_offline。
const MS_OFFLINE_KEY = "ms_offline";

/** 保存市场情绪离线快照(收盘定格) */
function saveMsOffline(payload) {
  try {
    setMeta(MS_OFFLINE_KEY, JSON.stringify({ date: new Date().toISOString().slice(0, 10), savedAt: Date.now(), payload }));
  } catch (e) { console.error("[ms-offline] save error:", e?.message || e); }
}

/** 读取市场情绪离线快照; 不存在返回 null */
function loadMsOffline() {
  try {
    const v = getMeta(MS_OFFLINE_KEY);
    return v ? JSON.parse(v) : null;
  } catch { return null; }
}

/** 删除市场情绪离线快照(开盘拿到新数据后调用) */
function clearMsOffline() {
  deleteMeta(MS_OFFLINE_KEY);
}

/* ---------------- 涨跌停趋势(market_trend) ---------------- */

/** 批量 UPSERT 趋势记录(按日期, 已存在则更新, 历史不变行开销极小) */
function upsertTrends(records) {
  const now = Date.now();
  return dbTimed("upsertTrends", true, () => {
    db.exec("BEGIN");
    try {
      for (const r of records) {
        if (!r || !r.date) continue;
        upsertTrendStmt.run(r.date, r.limitUp ?? null, r.limitDown ?? null, r.brokenUp ?? null, r.blownUp ?? null, r.blownRate ?? null, now);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return records.length;
  });
}

/** 读取全部趋势记录(按日期升序) */
function getTrends() {
  return dbTimed("getTrends", false, () => nextReadStmt().getTrends.all());
}

/** 趋势记录总数 */
function trendCount() {
  const r = nextReadStmt().trendCount.get();
  return r ? r.c : 0;
}

/* ---------------- 连板梯队趋势(ladder_trend) ---------------- */

/** 批量 UPSERT 连板梯队记录(按日期, 已存在则更新) */
function upsertLadderTrends(records) {
  const now = Date.now();
  return dbTimed("upsertLadderTrends", true, () => {
    db.exec("BEGIN");
    try {
      for (const r of records) {
        if (!r || !r.date) continue;
        upsertLadderStmt.run(
          r.date,
          r.firstBoard ?? null, r.secondBoard ?? null, r.thirdBoard ?? null, r.highBoard ?? null,
          r.ladderRate ?? null, r.blownRate ?? null, r.yestLimitUpPerf ?? null, r.yestLadderPerf ?? null, r.yestBrokenPerf ?? null,
          r.comment ?? null, now,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return records.length;
  });
}

/** 读取全部连板梯队记录(按日期升序) */
function getLadderTrend() {
  return dbTimed("getLadderTrend", false, () => nextReadStmt().getLadderTrend.all());
}

/* ---------------- 数据库性能监控(供 /api/monitor 面板) ----------------
 * 以内存计数方式记录每次读/写调用的耗时, 暴露给前端监控面板识别热路径与瓶颈。
 * 指标: 读次数/写次数/读耗时总和/写耗时总和/最近一次耗时/累计错误。 */
const dbMetrics = { reads: 0, writes: 0, readMs: 0, writeMs: 0, errors: 0, lastMs: 0, lastOp: "" };
function dbTimed(op, isWrite, fn) {
  const t0 = Date.now();
  try {
    const r = fn();
    const ms = Date.now() - t0;
    if (isWrite) { dbMetrics.writes++; dbMetrics.writeMs += ms; } else { dbMetrics.reads++; dbMetrics.readMs += ms; }
    dbMetrics.lastMs = ms; dbMetrics.lastOp = op;
    return r;
  } catch (e) {
    dbMetrics.errors++;
    throw e;
  }
}
/** 返回只读快照(供监控面板/AI 诊断) */
function getDbMetrics() {
  return { ...dbMetrics, reads: dbMetrics.reads, writes: dbMetrics.writes };
}

/* ---------------- PHILIA AI: 配置与结果存取 ---------------- */

/** 读取 PHILIA AI 配置(含加密 key 密文); 未配置返回 null */
function getAiKey() {
  const row = nextReadStmt().getAiKey.get();
  if (!row) return null;
  return {
    provider: row.provider,
    encKey: row.encKey,
    encIv: row.encIv,
    model: row.model,
    skills: u(row.skills) || [],
    updatedAt: row.updatedAt,
  };
}

/** 写入 PHILIA AI 配置(单行 id=1) */
function upsertAiKey({ provider, encKey, encIv, model, skills }) {
  return dbTimed("upsertAiKey", true, () =>
    stmt.upsertAiKey.run(provider, encKey, encIv, model ?? null, skills && skills.length ? j(skills) : null, Date.now())
  );
}

/** 读取某次分析结果(按 cache_key); 不存在返回 null */
function getAiAnalysis(cacheKey) {
  const row = nextReadStmt().getAiAnalysis.get(cacheKey);
  if (!row) return null;
  return {
    cacheKey,
    date: row.date,
    model: row.model,
    skillsHash: row.skillsHash,
    result: u(row.result),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 写入/更新某次分析结果(UPSERT, 降频缓存去重) */
function upsertAiAnalysis({ cacheKey, date, model, skillsHash, result }) {
  const now = Date.now();
  return dbTimed("upsertAiAnalysis", true, () =>
    stmt.upsertAiAnalysis.run(cacheKey, date ?? null, model, skillsHash, result ? j(result) : null, now, now)
  );
}

/** 最近 N 条分析记录(按更新时间倒序) */
function listAiAnalyses(limit = 20) {
  return dbTimed("listAiAnalyses", false, () => {
    const rows = nextReadStmt().listAiAnalyses.all(limit);
    return rows.map((r) => ({
      cacheKey: r.cacheKey,
      date: r.date,
      model: r.model,
      skillsHash: r.skillsHash,
      result: u(r.result),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  });
}

module.exports = { getStock, getStockBoards, upsertStock, upsertStockBoards, stockCount, allStockCodes, getMeta, setMeta, deleteMeta, saveMsOffline, loadMsOffline, clearMsOffline, upsertTrends, getTrends, trendCount, upsertLadderTrends, getLadderTrend, getDbMetrics, getAiKey, upsertAiKey, getAiAnalysis, upsertAiAnalysis, listAiAnalyses, DB_PATH };