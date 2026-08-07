# THSDK Web 单页示例

这个目录是 THSDK 的独立 Web 示例，提供一个本地单页面查询台，适合第一次接触 SDK 时直接看接口字段、请求参数和表格化结果。

## 目录

- `app.py`：页面服务实现
- `__main__.py`：模块启动入口
- `screenshots/`：README 使用的页面截图

## 启动

在项目根目录执行：

```bash
python3 -m thsdk.examples.webapp --host 127.0.0.1 --port 8765
```

打开 `http://127.0.0.1:8765`。

## 页面特点

- 每个接口的必填参数都已预置默认值
- 左侧快捷预设覆盖全部已接入接口
- 已内置 `market_data_block`、`market_data_cn/us/hk/uk/bond/fund/future/forex/index` 这组市场数据查询接口
- `market_data_xxx` 留空证券代码时，会自动先取对应市场列表，再按 `market` 分组查询并合并结果
- 列表结果里的代码列可直接点击，自动切换到对应 `market_data_xxx` 详情查询
- `data` 和 `extra` 会自动转成表格或文本展示
- 服务进程内复用单个 THS TCP 连接，避免每次请求重复登录
- 单例连接会自行维持会话，遇到未登录或连接异常时会自动断开并重连一次
- 大表默认只渲染前 20 行，按需再展开，减少浏览器卡顿
- `extra` 和原始 JSON 默认折叠，展开时才生成内容

## 截图案例

### 首次打开先试证券搜索

![证券搜索示例](screenshots/case_search_symbols.png)
