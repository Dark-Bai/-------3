# PHILIA 平台 · 游资视角 AI 综合分析模块 — 技术方案

> 版本 v1.0 · 状态：待评审 · 前置：实施前需通过本文档评审
> 技术栈约束：React 19 + Vite 7 + TS + Tailwind（手写 SVG 图表，不引入图表库）；后端零依赖原生 Node `server/index.cjs` + SQLite（`node:sqlite`）；不引入新依赖。

---

## 0. 评审结论（依据前置确认）

| 决策项 | 结论 |
|--------|------|
| AI 提供商 | **OpenRouter 聚合**（复用现有 `OR_KEY` 机制，deepseek-v4-flash 走 OpenRouter） |
| API Key 存储 | **后端加密存储 + 代理**（密钥不出服务端，AI 请求全走后端） |
| 交付范围 | **仅本技术方案文档**（评审通过后再排期实现） |
| 分析执行 | **真实调用 LLM + 降频缓存**（按数据快照哈希做 TTL 缓存，控制成本） |

---

## 1. 项目背景与现状分析

### 1.1 现状

- **`PhiliaPanel`**（[PhiliaPanel.tsx](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/src/components/dash/PhiliaPanel.tsx)）为首页中央 rowSpan=2 的空白占位块，`rowStart` 居中，占据原「商品·美债」+ philia 区域，是本次功能落地的主容器。
- **后端** `server/index.cjs`：零依赖原生 HTTP 服务，内置开盘啦 KPL 客户端（`kplFetch`，`KPL_API_KEY`）、本地 SQLite（`stock-db.sqlite`，见 [stock-db.cjs](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/server/stock-db.cjs)）、OpenRouter 集成、同源校验 + IP 限流 + 监控面板。
- **技能库**：`youzi-qijie-jinghua\SKILL.md`（七大游资交易思维合集，含 front-matter `name`/`description`）。
- **数据源**：KPL `kpl.liuhepc.cn`（225+ 接口，`X-API-Key` 认证）、腾讯/新浪/东财、本地市场情绪/连板趋势库。

### 1.2 目标

在 `PhiliaPanel` 内实现「游资视角 AI 综合分析」模块：
1. 一个专用功能按钮（可视化标识 + 交互反馈）→ 弹出模态配置窗口（API Key / 模型 / 技能多选）。
2. 触发后：校验 Key → 聚合本地库 + 互联网数据 → 注入所选游资技能 → 调 OpenRouter 大模型 → 输出结构化分析。
3. 面板下方 1/4 区域做数据可视化（与「市场情绪模块」同风格）。

---

## 2. 总体架构与数据流

### 2.1 架构分层

```
┌────────────────────────── 前端 (React, src/) ─────────────────────────┐
│  DashboardHeader(新增按钮) ─→ PhiliaModal(配置) ─→ PhiliaContext(状态)  │
│  PhiliaPanel(结果区3/4 + 可视化区1/4) ←─ usePhiliaAnalysis(轮询/缓存)   │
└───────────────┬───────────────────────────────────────────────────────┘
                │ 同源 /api/philia/*
┌───────────────▼─────────────────── 后端 (server/index.cjs) ───────────┐
│  /api/philia/config  保存/读取加密Key(不返回明文)                        │
│  /api/philia/validate OpenRouter校验Key                                 │
│  /api/philia/context 组装「市场数据白皮书」(本地库+KPL+资讯)              │
│  /api/philia/analyze LLM调用(降频缓存) + 结构化结果持久化                │
│  /api/philia/skills  读取技能库目录                                     │
│  server/philia-keystore.cjs   AES-256-GCM 加密存储                      │
│  server/stock-db.cjs(扩展)  ai_analysis / ai_key 表                     │
└──────────┬──────────────────────┬──────────────────────────────────────┘
           │ KPL kplFetch         │ SQLite 本地库
     ┌─────▼──────┐         ┌─────▼──────────────┐
     │ 开盘啦225+  │         │ stocks/market_trend │
     │ 腾讯/新浪   │         │ ladder_trend/新增表  │
     └────────────┘         └────────────────────┘
```

### 2.2 端到端数据流（时序）

```
用户 点击头部按钮 ──► 打开 PhiliaModal
   ├─ 选模型(默认 deepseek-v4-flash) + 多选技能 + 填 API Key
   └─ 点「开始分析」
        │ POST /api/philia/validate   (仅校验，验证 Key 有效性)
        │ ◄─ { valid: true, 模型名, 余额状态 }
        │ POST /api/philia/analyze { model, skills, force }
        │   后端:
        │   1) 计算 数据快照哈希 key = sha256(date + model + skills)
        │   2) 命中 ai_analysis 缓存(TTL内) → 直接返回缓存
        │   3) 未命中 → 组装 context(本地库 + KPL + 资讯)
        │   4) 注入技能提示词 → 调 OpenRouter chat/completions
        │      response_format=json_object，temperature 低，max_tokens 上限
        │   5) 解析校验 JSON → 结构化 → UPSERT 落库 → 返回
        │ ◄─ { structured: { sentiment, opportunities, risks, cores } }
前端 渲染结果区(3/4) + 可视化区(1/4)
```

---

## 3. 交互界面设计

### 3.1 功能按钮（DashboardHeader 新增）

- **位置**：`DashboardHeader` 右侧，紧邻「系统监控(Activity)」按钮左侧。
- **视觉标识**：`lucide-react` 的 `Sparkles` 图标（或 `Orbit`），配色沿用复古报刊风：未激活 `bg-[#ede4d4] text-[#8b7a5e]`，悬停 `hover:border-[#d4943a]/60 hover:text-[#d4943a]`。
- **激活反馈**：配置已保存（有 Key）时高亮为 `border-[#4a6b3f]/60 bg-[#4a6b3f]/10 text-[#4a6b3f]`；未配置时右上角加一个琥珀色小圆点提醒。
- **交互反馈**：点击打开模态窗口；分析进行中时按钮内显示旋转 spinner 并禁用。
- **TV 兼容**：绑定 `data-tv-focusable`、`tabIndex`（遵循现有 TV 模式约定）。

### 3.2 模态窗口（新组件 `PhiliaModal.tsx`）

- **触发器**：按钮点击；`Dialog` 样式手写（不引入 shadcn dialog，保持零依赖），居中浮层 + 半透明遮罩，支持 ESC 关闭、点击遮罩关闭。
- **宽度**：约 520px，与全局复古卡面一致（`bg-[#faf6ee] border-[#e0d5c0]`）。

#### 输入项（按需求）

| 输入项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| API Key | `<input type="password">` | ✅ 强制 | 格式校验：**只允许 `sk-or-` 前缀 + 字母数字**（OpenRouter key 形如 `sk-or-v1-…`）；失焦即校验并提示；通过 `POST /api/philia/validate` 实时验证有效性 |
| AI 模型 | 下拉 `select` | 可选 | 至少 3 项，含 **deepseek-v4-flash 正式版**；默认该模型。候选列表（经 OpenRouter model 列表过滤可用项） |
| 技能 | 多选 checkbox 列表 | 可选 | 从 `GET /api/philia/skills` 读取 `youzi-qijie-jinghua` 目录，展示技能 `name` + `description`；支持多选（可选「全选」）；未选时回退为「通用市场分析」模式 |

**候选模型列表（示例，实际以 OpenRouter `/api/v1/models` 过滤存在性）**

| 显示名 | OpenRouter model id |
|--------|---------------------|
| DeepSeek V4 Flash（正式版） | `deepseek/deepseek-v4-flash` |
| DeepSeek V3 | `deepseek/deepseek-chat` |
| OpenAI GPT-4o | `openai/gpt-4o` |
| Anthropic Claude Sonnet | `anthropic/claude-3.5-sonnet` |

> 注：具体 model id 以 OpenRouter 官方实际返回为准，前端通过模型列表接口动态渲染，避免硬编码失效。

#### 底部操作
- 「开始分析」主按钮（绿 `#4a6b3f`）：提交配置 + 触发分析；进行中变 spinner。
- 「仅保存设置」次按钮：仅存 Key/模型/技能，不触发分析。
- 安全提示文案：`密钥仅加密存储于本机服务端，绝不出现在前端缓存与网络日志中`。

---

## 4. AI 调用与数据分析

### 4.1 数据源聚合（后端 `/api/philia/context`）

组装一份**「市场数据白皮书」**，作为 LLM 上下文。来源与接口：

| 维度 | 数据源 | 具体接口/库表 | 用途 |
|------|--------|---------------|------|
| 市场情绪得分 | 本地库 | `market_trend`（历史）+ 当日实时计算 | sentiment 评分依据 |
| 连板梯队 | 本地库 | `ladder_trend` | 情绪周期阶段判断 |
| 涨跌停 | KPL | `/api/market/limit-up-down`、`/api/market/rise-fall` | 赚钱/亏钱效应 |
| 情绪指标 | KPL | `/api/market/mood`、`/api/market/sentiment-indicator` | 量化情绪分 |
| 炸板率 | KPL | `/api/ladder/broken`（实时） | 风险信号 |
| 龙头/连板核心 | KPL | `/api/market/limit-up-ladder` | 核心标的识别 |
| 游资动向 | KPL | `/api/lhb/youzi-dongxiang` | 结合技能库判龙头 |
| 热门题材 | KPL | `/api/theme/hot`、`/api/news/theme` | 机会领域 |
| 快讯 | KPL/新浪 | `/api/advanced/news-flash`（或现有 news） | 事件驱动 |
| 个股基本面 | 本地库 | `stocks`（industry/concepts） | 推荐依据 |

- **权限**：KPL 走既有 `kplFetch`（`X-API-Key`），**不向用户暴露 KPL key**；本地库只读访问，聚合结果仅服务端可见。
- **TTL**：context 计算按 5 分钟缓存（复用 `cached()` 机制），避免重复抓取。

### 4.2 LLM 调用与结构化输出（后端 `/api/philia/analyze`）

- **协议**：OpenRouter `POST https://openrouter.ai/api/v1/chat/completions`，`Authorization: Bearer <userKey>`（由服务端解密后使用，**不出服务端**）。
- **Prompt 组装**：
  1. 系统提示词固定为「A股市场分析助手」，要求**只输出合法 JSON**。
  2. 注入所选技能的原文片段（从 `SKILL.md` 按 front-matter `name` 匹配章节，截取核心策略/决策启发式）。
  3. 注入市场数据白皮书（上文 context，做长度裁剪，分块送入）。
  4. 明确输出 JSON Schema（见 4.3）。
- **生成参数**：`response_format: {type:"json_object"}`、`temperature: 0.3`、`max_tokens: 4096`、`timeout: 120s`。
- **降频缓存**（成本控制核心）：
  - 缓存键 `key = sha256(dateStr + model + sortedSkillsHash)`。
  - 命中且未过 TTL（默认 30 分钟，盘中可配）→ 直接返回，**不重复计费**。
  - 前端「强制刷新」按钮传 `force=1` 绕过缓存。
- **结构化校验**：LLM 返回 JSON 经模式校验（每字段类型/范围），失败则重试 1 次；仍失败返回错误并提供上次缓存兜底。

### 4.3 结构化输出 Schema

```jsonc
{
  "sentiment": {
    "score": 72,            // 0-100 量化评分
    "level": "回暖期",       // 情绪周期阶段
    "comment": "……"         // 文字说明
  },
  "opportunities": [         // ≥3 个机会
    {
      "type": "题材/龙头/弱转强/趋势",
      "sector": "AI算力",
      "analysis": "……",
      "expectedReturn": "30%-50%",   // 预期收益分析
      "weight": 0.35                 // 综合权重(百分比标注用)
    }
  ],
  "risks": [                 // ≥3 个风险
    {
      "level": "高/中/低",
      "scope": "全市场/板块/个股",
      "description": "……",
      "mitigation": "……",
      "weight": 0.30
    }
  ],
  "stocks": [                // 3-5 只核心标的
    {
      "name": "……",
      "code": "sh600519",
      "reason": "龙头/连板/基本面……",
      "target": "目标价区间",
      "weight": 0.20
    }
  ]
}
```

> 权重约束：`sentiment`(0.1) + 各 `opportunities.weight` + 各 `risks.weight` + 各 `stocks.weight` 归一化和 ≈ 1，前端据此标注每项百分比。

### 4.4 结果持久化

扩展 [stock-db.cjs](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/server/stock-db.cjs) 新增表：

```sql
CREATE TABLE IF NOT EXISTS ai_analysis (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key     TEXT UNIQUE,          -- 降频缓存键
  date          TEXT,                 -- 交易日
  model         TEXT,
  skills_hash   TEXT,
  result        TEXT,                 -- 结构化 JSON
  created_at    INTEGER,
  updated_at    INTEGER
);
CREATE TABLE IF NOT EXISTS ai_key (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  provider  TEXT,                     -- 'openrouter'
  enc_key   TEXT,                     -- AES-256-GCM 密文(BASE64)
  enc_iv    TEXT,                     -- 初始化向量
  model     TEXT,                     -- 上次选择
  skills    TEXT,                     -- 上次选择(JSON数组)
  updated_at INTEGER
);
```

---

## 5. 数据可视化模块（下方 1/4 区域）

### 5.1 布局与风格

- `PhiliaPanel` body 纵向分两段：上方 3/4 为分析结果（评分卡 + 机会/风险/核心标的列表），**下方 1/4 为可视化区**。
- 风格完全对齐[市场情绪模块](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/src/components/dash/MarketSentimentPanel.tsx)：`bg-[#f5f0e6]/40`、`border-[#e0d5c0]`、字号 9-11px、色板 `#b8533a/#4a6b3f/#d4943a/#a8987e`，**手写 SVG**（复用 `smoothPath`、ResizeObserver 自适应等既有模式）。
- 可视化区顶部一行小 Tabs 切换三张图，右侧时间范围筛选 + 导出按钮。

### 5.2 三类图表

| 图表 | 类型 | 数据来源 | 权重标注 |
|------|------|----------|----------|
| **市场情绪走势图** | 折线/面积 | `market_trend` 历史情绪分 + 当日 LLM `sentiment.score` | 标注「情绪分权重 10%」等 |
| **机会-风险矩阵图** | 二维散点 | `opportunities.weight`(x: 预期收益) × `risks.weight`(y: 风险等级) | 每点标注权重百分比 |
| **核心标的权重对比图** | 横向柱状 | `stocks.weight` | 每柱标注公司/代码 + 权重% |

### 5.3 交互能力

- **悬停详情**：SVG 上 `:hover` 显示 tooltip（跟随鼠标，展示名称/数值/说明）。
- **时间范围筛选**：情绪走势图支持 `1D/5D/1M/3M/全部`；机会-风险与权重图支持按 `今日/历史` 切换。
- **数据导出**：右上角「导出 CSV」按钮，将当前图表数据序列化为 CSV 下载（`Blob` + `URL.createObjectURL`，零依赖）。
- **权重展示**：每项指标旁显式标注其综合权重百分比（`weight × 100% + 数据类型`）。

---

## 6. 模块集成要求

### 6.1 需调用的 KPL 具体 API 模块

| 模块名 | 接口路径 | 版本/分类 | 调用权限 | 已在 index.cjs? |
|--------|----------|-----------|----------|-----------------|
| 市场情绪 | `/api/market/mood` | 市场情绪/盘中实时 | 仅服务端 `kplFetch` | ✅ |
| 涨跌分析 | `/api/market/rise-fall` | 市场情绪/盘中实时 | 同上 | ✅ |
| 涨停跌停统计 | `/api/market/limit-up-down` | 市场情绪/盘中实时 | 同上 | 需新增 |
| 连板梯队统计 | `/api/market/limit-up-ladder` | 市场情绪/历史+实时 | 同上 | ✅ |
| 炸板数据 | `/api/ladder/broken` | 连板梯队/实时 | 同上 | ✅ |
| 多空情绪指标 | `/api/market/sentiment-indicator` | 市场情绪/盘中实时 | 同上 | 需新增（**注意：文档标注稳定性差**，作为可选增强，失败不阻塞） |
| 游资动向 | `/api/lhb/youzi-dongxiang` | 龙虎榜/历史+实时 | 同上 | 需新增 |
| 热门主题 | `/api/theme/hot` | 主题 | 同上 | ✅（风口用） |
| 快讯 | `/api/advanced/news-flash` | 资讯 | 同上 | ✅（news-analyst 用） |

> 说明：所有 KPL 调用统一走服务端 `kplFetch`（`X-API-Key` 封装在服务端，**不下发前端**）；对稳定性差的接口（如 sentiment-indicator）采用「短超时 + 失败降级」策略，不阻塞主流程。

### 6.2 本地数据库

- **连接方式**：复用 `stock-db.cjs` 导出的 `getStock / getTrends / getLadderTrend / getMeta / setMeta`；新增 `ai_analysis / ai_key` 表访问函数（只读走读连接池，写走写连接）。
- **数据模型**：见 4.4 建表；`stocks`/`market_trend`/`ladder_trend` 只读引用，不改结构。
- **查询权限**：AI 模块仅通过服务端封装函数访问，前端不直连 DB；分析结果查询走 `/api/philia/history`（不暴露库文件路径）。

### 6.3 认证与权限集成

- **现有机制**（[index.cjs#L2324](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/server/index.cjs)）：同源校验（`isSameOrigin`）+ 跨源不反射 ACAO + IP 限流（`makeLimiter`）。
- **AI 模块新增控制**：
  1. 将 `/api/philia/analyze`、`/api/philia/config` 加入独立**成本限流**（每 IP 每 5 分钟最大 N 次 LLM 调用，防滥用烧钱）。
  2. `config` 读取/写入仅同源；`validate` 限流防暴力尝试。
  3. 模型名**白名单**校验，禁止任意模型 id 注入（防成本/安全风险）。
  4. 密钥 `ai_key.enc_key` 用服务端密钥 AES-256-GCM 加密，`GET /api/philia/config` 只返回 `hasKey: true/false` + 掩码，**绝不回传明文**。

---

## 7. 接口设计（草案）

### 前端 `api.philia` 扩展（[src/lib/api.ts](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/src/lib/api.ts)）

```ts
api.philia = {
  skills:            () => get<PhiliaSkill[]>('/api/philia/skills'),
  models:            () => get<PhiliaModel[]>('/api/philia/models'),        // OpenRouter 可用模型(过滤)
  getConfig:         () => get<PhiliaConfig>('/api/philia/config'),          // 不含明文key
  saveConfig:        (cfg) => post('/api/philia/config', cfg),               // 含key加密存储
  validate:          (key) => post('/api/philia/validate', { key }),
  analyze:           (cfg, force=false) => post('/api/philia/analyze', { ...cfg, force }),
  history:           () => get<PhiliaAnalysis[]>('/api/philia/history'),
};
```

### 后端路由（[index.cjs](file:///c:/Users/A/Desktop/峰策/驾驶舱改%20-%20副本/server/index.cjs) 新增）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/philia/skills` | 读 `youzi-qijie-jinghua` 目录，解析 SKILL.md front-matter |
| GET | `/api/philia/models` | 调 OpenRouter `/api/v1/models` 过滤（30min TTL） |
| GET | `/api/philia/config` | 返回 `hasKey`/mask/model/skills（无明文） |
| POST | `/api/philia/config` | 加密保存 key+model+skills |
| POST | `/api/philia/validate` | OpenRouter `/api/v1/auth/key` 校验 |
| POST | `/api/philia/analyze` | 组装 context + LLM + 降频缓存 + 落库 |
| GET | `/api/philia/history` | 历史分析列表 |

> 新增模块文件建议：`server/philia-keystore.cjs`（加解密）、`server/philia-ai.cjs`（context 组装 + LLM 调用 + 缓存），`server/index.cjs` 仅挂路由，保持主文件可控。

---

## 8. 安全策略

1. **密钥机密性**：AES-256-GCM 加密落库；服务端密钥来自 `server/.env`（`PHILIA_ENC_KEY`），缺失则首次启动生成并提示持久化；密钥永不进前端、日志、错误信息。
2. **最小暴露**：`GET /api/philia/config` 不回传明文；监控面板不记录 key。
3. **成本防护**：模型白名单 + IP 级 LLM 调用限流 + `max_tokens` 上限 + 降频缓存，三重控制成本。
4. **输入卫生**：技能名/模型名做白名单/长度校验，防提示词注入与路径穿越（技能目录读取用 `basename` 白名单）。
5. **传输安全**：沿用同源校验、CORS 不反射、`X-Frame-Options: DENY`、`Referrer-Policy`。
6. **结构化校验**：LLM 输出 JSON 严格模式校验，防畸形数据污染前端渲染。
7. **免责声明**：结果区固定展示「AI 生成内容，仅供研究，不构成投资建议」（与 SKILL.md 责任声明一致）。

---

## 9. 测试计划

### 9.1 单元/接口测试
- `/api/philia/skills`：目录存在/缺失/空目录、front-matter 解析、非法文件名。
- `/api/philia/config`：加解密往返、掩码返回、非法 key 格式拒绝。
- `/api/philia/validate`：有效/无效/过期 key、限流。
- `/api/philia/analyze`：缓存命中（不重复计费）、force 绕过、LLM 超时/畸形 JSON 重试、KPL 失败降级。
- 权重归一化校验（各部分 weight 和在容差内）。

### 9.2 前端交互测试
- 按钮激活态/未配置红点/分析中 spinner/TV 焦点。
- 模态：Key 格式校验、模型下拉、技能多选/全选、ESC/遮罩关闭。
- 三张图：hover tooltip、时间筛选、CSV 导出、窗口缩放自适应、TV 模式。

### 9.3 集成与回归
- 确认新增路由不破坏既有 `/api/monitor`、市场情绪、个股详情等功能。
- 同源/CORS/限流回归；`npm run build` TS 检查通过；`npm run lint` 无错误。
- 成本验证：相同快照重复分析次数=缓存命中次数，确认未重复计费。

### 9.4 验收标准
- 按钮 → 配置 → 分析 → 结构化结果 → 可视化的全链路可用。
- 至少 3 个模型可选（含 deepseek-v4-flash 正式版）、技能多选生效。
- 输出含：情绪分(0-100)+说明、≥3 机会(类型/领域/预期收益)、≥3 风险(等级/范围/缓解)、3-5 核心标的(名称/代码/依据/目标价)。
- 可视化区权重标注、交互、导出齐备，风格与市场情绪模块一致。

---

## 10. 实施里程碑（评审通过后）

| 阶段 | 内容 |
|------|------|
| M1 | 后端：`philia-keystore.cjs`、`philia-ai.cjs`、DB 扩展、6 个路由 |
| M2 | 前端：`api.philia`、`PhiliaModal`、`PhiliaContext`、头部按钮 |
| M3 | 前端：`PhiliaPanel` 结果区渲染 |
| M4 | 前端：可视化区三图 + 交互 + 导出 |
| M5 | 测试、成本验证、回归、上线 |

---

*本文档为技术方案，评审通过后进入实施。*