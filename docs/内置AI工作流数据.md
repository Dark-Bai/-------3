# 内置 AI 综合分析工作流数据

> 本文档描述 PHILIA 内置 AI 综合分析系统的完整运行机制，覆盖流程步骤、功能说明、关键技术组件、数据处理、决策逻辑、输入输出规范、错误处理与性能指标，供分析与运维参考。

---

## 1. 工作流总览（端到端流程）

```
┌────────┐  ┌──────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐
│ 前端交互 │→│ 事件处理  │→│ 请求转发/鉴权 │→│ 上下文组装 │→│ LLM 调用   │→│ 结果规范化    │→ 持久化 → 前端渲染
└────────┘  └──────────┘  └─────────────┘  └──────────┘  └──────────┘  └────────────┘
  点击分析     runAnalysis   POST /analyze    assembleContext  callLLM       normalizeResult
                            (force 鉴权)      (数据白皮书)    (150s 超时)    (权重归一化)
```

| 阶段 | 入口 | 功能 | 关键组件 |
| --- | --- | --- | --- |
| ① 前端交互 | [PhiliaPanel/PhiliaModal](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/src/components/dash/PhiliaPanel.tsx) | 收集 model + skills，触发分析 | `runAnalysis(model, skills, force)` |
| ② 请求转发 | [PhiliaContext](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/src/components/dash/PhiliaContext.tsx) | 状态管理、错误捕获、防卸载更新 | `api.philia.analyze()`（POST，180s 长超时） |
| ③ 后端鉴权 | [philia-ai.cjs analyze](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/server/philia-ai.cjs#L458) | 模型白名单校验、Key 校验、缓存命中判断 | `MODEL_WHITELIST` / `getAiKey` / `decrypt` |
| ④ 上下文组装 | [assembleContext](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/server/philia-ai.cjs#L202) | 并行拉取 6 路 KPL + 本地趋势 + 龙头池 | `Promise.allSettled` / `kplFetch` |
| ⑤ 提示词构建 | [buildPrompt](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/server/philia-ai.cjs#L297) | 系统提示 + 数据白皮书 + 技能原文 | `contextToText` / `MAX_PROMPT_SKILL_CHARS` |
| ⑥ LLM 调用 | [callLLM](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/server/philia-ai.cjs#L328) | 调 DeepSeek/OpenRouter，要求 JSON 输出 | `AbortSignal.timeout(150000)` |
| ⑦ 结果规范化 | [normalizeResult](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/server/philia-ai.cjs#L378) | 字段清洗、切片、权重归一化 | `num()` 夹取 / 越界收缩 |
| ⑧ 持久化 | [upsertAiAnalysis](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/server/stock-db.cjs) | 写入 SQLite 分析表 | UPSERT 按 cacheKey |

---

## 2. 各阶段功能说明

### 2.1 前端交互（①）
- 入口：面板「重新分析」按钮（`refresh`）或模态框「开始分析」（`handleAnalyze`）。
- 复用最近一次的 `model` 与 `skills`；若未配置则转而打开配置弹窗。
- 分析期间按钮置 `disabled` 防重复提交，但**不阻塞数据查看**（后台处理）。

### 2.2 请求转发（②）
- 统一走 `post()`（[api.ts](file:///c:/Users/A/Desktop/峰策/驾驶舱改 - 副本/src/lib/api.ts#L369)），带并发信号量（上限 6）与 180s 独立长超时。
- 成功 `setAnalysis(r)` 触发面板重渲染；失败 `setAnalysisError` 并抛出。

### 2.3 后端鉴权与缓存（③）
- 模型必须命中 `MODEL_WHITELIST`（防模型 id 注入）。
- Key 必须已配置且可解密（AES-256-GCM）。
- **降频缓存**：`cacheKey = sha256(date|model|sortedSkills)`，非 `force` 时命中缓存直接返回，不重复计费。

### 2.4 上下文组装（④）
- 并行拉取 6 个上游（各带独立超时），任一失败不影响整体（`allSettled`）。
- 叠加本地 SQLite 趋势（近 30 日情绪、近 10 日连板梯队）与注入的龙头股参考池。
- 记录每个数据源名称 + 获取时间（分钟级），随结果下发供追溯。

### 2.5 提示词构建（⑤）
- **系统提示**：固定 JSON schema 契约（sentiment/opportunities/risks/stocks）。
- **用户提示**：数据白皮书文本 + 所选技能原文（截断 ≤8000 字符控成本）。

### 2.6 LLM 调用（⑥）
- 按 Key 前缀判定 provider（`sk-or-` → OpenRouter，其余 → DeepSeek）。
- `temperature=0.3`（低随机性）、`response_format=json_object`（强制 JSON）。
- `max_tokens`：DeepSeek 8192 / OpenRouter 4096。

### 2.7 结果规范化（⑦）
- 数值字段 `num()` 夹取到 [0,1]；列表切片（机会/风险 ≤6，股票 ≤5）。
- **权重归一化**：全段权重和 >1.0001 时按比例收缩到 1。

### 2.8 持久化（⑧）
- 按 `cacheKey` UPSERT 写入 `ai_analysis` 表，含 date/model/skillsHash/result/时间戳。
- `history()` 读取最近记录供冷启动恢复。

---

## 3. 关键技术组件

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `kplFetch` | philia-ai.cjs#L50 | 开盘啦 KPL 客户端，超时 10s/12s，失败返回 null 不抛出 |
| `assembleContext` | philia-ai.cjs#L202 | 数据白皮书聚合 + 5min 缓存 |
| `contextToText` | philia-ai.cjs#L260 | 白皮书压缩为 LLM 文本（token 控制） |
| `buildPrompt` | philia-ai.cjs#L297 | 系统/用户提示词 + 技能注入 |
| `callLLM` | philia-ai.cjs#L328 | 多 provider 适配、150s 超时、JSON 解析 |
| `normalizeResult` | philia-ai.cjs#L378 | 结构校验与权重归一化 |
| `philia-keystore.cjs` | 独立模块 | AES-256-GCM 加解密 Key |
| `stock-db.cjs` | 独立模块 | SQLite 存取：Key/分析/趋势/连板 |
| `MODEL_WHITELIST` | philia-ai.cjs#L44 | 模型白名单（防注入） |
| `leaderPoolGetter` | 注入 | 龙头股参考池（市场实时热点） |

---

## 4. 数据处理流程

### 4.1 上游数据源（`assembleContext` 并行拉取）
| # | KPL 接口 | 超时 | 用途 |
| --- | --- | --- | --- |
| 1 | `/api/market/mood` | 8s | 市场情绪（涨跌家数/涨停跌停/涨跌比/流通量） |
| 2 | `/api/market/rise-fall` | 12s | 涨跌停统计（涨停/跌停/炸板/炸板率） |
| 3 | `/api/market/limit-up-down` | 12s | 涨停/跌停明细 |
| 4 | `/api/ladder/broken` | 12s | 炸板数据 |
| 5 | `/api/theme/hot` | 8s | 热门题材 TOP |
| 6 | `/api/lhb/youzi-dongxiang` | 12s | 游资动向 |

### 4.2 本地数据叠加
- `getTrends()`：近 30 日情绪趋势（date/limitUp/limitDown/blownRate）。
- `getLadderTrend()`：近 10 日连板梯队（一板/二板/三板/高度板/连板率/破板率/评价）。
- `leaderPoolGetter()`：龙头股参考池（评分 TOP，供 LLM 挑选核心标的）。

### 4.3 数据流向
```
上游 JSON → assembleContext 归一为 ctx → contextToText 文本化
        → buildPrompt 拼接 system+user → callLLM → LLM JSON
        → normalizeResult 清洗 → 附 sources 溯源 → upsertAiAnalysis → 前端渲染
```

---

## 5. 决策逻辑

### 5.1 触发决策
- 命中缓存（非 force）→ 直接返回缓存，不调 LLM（降本）。
- 未配置 Key / 非法模型 → 提前 400 拒绝。

### 5.2 数据源容错决策
- 单个上游失败 → `null` 占位，其余数据照常用于分析，不中断整体。
- 龙头池获取失败 → 仅记日志，不阻塞分析。

### 5.3 LLM 推理决策
- 系统提示词固定 JSON 契约，约束输出结构。
- 要求机会 ≥3、风险 ≥3、股票 3-5，且全段 `weight` 之和接近 1。
- 提示词显式要求「优先从龙头股参考池挑选核心标的」。

### 5.4 结果归一化决策
- 全段权重和 >1.0001 → 等比收缩到 1（保证权重可解释、可比较）。

---

## 6. 输入输出规范

### 6.1 输入
| 项 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 必须命中白名单 |
| `skills` | string[] | 技能名数组，按名匹配 `SKILL.md`，排序后参与 cacheKey |
| `force` | boolean | 是否绕过缓存 |

### 6.2 输出（`analyze` 返回值）
```jsonc
{
  "cacheKey": "sha256(date|model|skills)",
  "date": "YYYY-MM-DD",
  "model": "deepseek/deepseek-v4-flash",
  "skillsHash": "技能A,技能B",
  "result": {
    "sentiment": { "score": 0-100, "level": "", "comment": "", "sources": [...] },
    "opportunities": [ { "type", "sector", "analysis", "expectedReturn", "weight" } ],
    "risks": [ { "level": "高/中/低", "scope", "description", "mitigation", "weight" } ],
    "stocks": [ { "name", "code", "reason", "target", "weight" } ]
  },
  "createdAt": 毫秒, "updatedAt": 毫秒, "fromCache": false
}
```

---

## 7. 错误处理机制

| 故障点 | 处理 | 结果 |
| --- | --- | --- |
| 模型不在白名单 | 抛 400 | 前端显示「不支持的模型」 |
| 未配置 API Key | 抛 400 | 前端引导配置 |
| 上游接口超时/失败 | `kplFetch` 捕获返回 null | 数据占位，分析继续 |
| 多个上游同时失败 | `Promise.allSettled` | 不中断，仅记录缺失 |
| 龙头池获取失败 | try/catch + 日志 | 不阻塞分析 |
| LLM 网络超时 | `AbortSignal.timeout(150000)` | 抛 502 |
| LLM HTTP 非 2xx | 解析 `error.message` | 抛 502 |
| LLM 无 content | 从 `reasoning_content` 提取 JSON 兜底 | 尽力恢复 |
| 返回非合法 JSON | `JSON.parse` 失败 | 抛 502 |
| 前端请求超时 | `timeoutSignal(180000)` | 抛「请求超时」toast |
| 组件卸载后回环 | `mounted.current` 守卫 | 阻止 setState |

---

## 8. 性能指标

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 上下文缓存 TTL | 5 min | 数据白皮书复用，避免重复拉上游 |
| 分析结果缓存 TTL | 30 min | 降频缓存，同参数不重复计费 |
| 模型列表缓存 TTL | 30 min | 减少 OpenRouter 请求 |
| LLM 单次超时 | 150 s | 后端等待上限 |
| 前端 analyze 超时 | 180 s | 与后端对齐留余量，防止提前 Abort |
| `max_tokens` | 8192（DS）/ 4096（OR） | 输出预算 |
| `temperature` | 0.3 | 低随机、结果稳定 |
| 技能注入上限 | 8000 字符 | 控制 token 成本 |
| 上游并行拉取 | 6 路并行 | 缩短白皮书组装时间 |
| 单上游超时 | 8s / 12s | 慢源独立超时不拖累整体 |
| 数据源追溯 | sources[name, fetchedAt] | 前端可查数据时效 |

---

## 9. 相关文件

| 文件 | 职责 |
| --- | --- |
| `server/philia-ai.cjs` | 工作流核心（上下文/提示词/LLM/规范化/鉴权） |
| `server/philia-keystore.cjs` | Key 的 AES-256-GCM 加解密 |
| `server/stock-db.cjs` | SQLite 存取（Key/分析/趋势/连板） |
| `server/index.cjs` | `setLeaderPoolGetter` 注入、`/api/philia/*` 路由、限流 |
| `src/components/dash/PhiliaContext.tsx` | 前端全局状态与 runAnalysis |
| `src/components/dash/PhiliaPanel.tsx` | 面板交互与结果展示 |
| `src/lib/api.ts` | `api.philia.analyze`（180s 长超时） |