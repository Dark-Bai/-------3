# THSDK

THSDK 是一个用于股市金融行情数据的 Python SDK，提供便捷的 API 接口来获取股票、期货、外汇等金融市场数据。该库封装了ths底层 C 动态链接库，支持实时数据查询、历史 K 线、分时数据、板块数据等功能。

## 功能特性

- **多市场支持**：支持A股、美股、港股、期货、外汇等市场数据
- **丰富数据类型**：K线数据、分时数据、深度数据、板块数据、成交数据等
- **灵活查询**：支持单只股票批量查询、历史数据查询
- **易用接口**：Pythonic API 设计，支持上下文管理器
- **数据转换**：自动转换为 Pandas DataFrame，便于数据分析

## 安装

```bash
pip install --upgrade thsdk
```

### 系统要求

- Python 3.9+
- 支持的操作系统：Linux (x86_64, arm64), macOS (Intel, Apple Silicon), Windows
- 依赖库：pandas, orjson (可选，用于更快的 JSON 解析)

## 快速开始

```python
from thsdk import THS

# 使用上下文管理器自动处理连接
with THS() as ths:
    # 获取 K 线数据
    response = ths.klines("USZA300033", count=100)
    if response.success:
        df = response.df  # 自动转换为 DataFrame
        print(df.head())

```

### 代码格式规则

- 中国市场固定编码接口使用 `4位市场代码 + 6位数字代码`，例如 `USZA300033`、`USHA600519`
- 国际市场或跨市场通用查询通常使用 `4位市场代码 + 可变长度证券缩写`，例如美股 `UNQQTSLA`
- `klines`、`intraday_data`、`tick_level1`、`tick_super_level1`、`min_snapshot`、`call_auction`、`corporate_action`、`market_data_cn` 这类国内行情接口应传入固定 10 位代码
- `market_data_us`、`market_data_hk`、`market_data_uk`、`market_data_index`、`market_data_forex` 等通用市场查询接口支持可变长度代码

常用 4 位市场代码示例：

- `USHA`：沪市 A 股
- `USZA`：深市 A 股
- `USTM`：北交所
- `USHI`：上证指数
- `USZI`：深证指数
- `URFI`：同花顺行业/概念等板块
- `UNQQ`：美股常见代码前缀示例，如 `UNQQTSLA`
- `UFXB`：外汇

如果手里还没有完整 `THSCODE`，可以先这样处理：

- 只知道股票名称：直接用 `search_symbols("同花顺")`
- 只知道股票代码：可用 `complete_ths_code("300033")` 补齐，也可以用 `search_symbols("300033")` 反查
- 需要调用 `klines`、`intraday_data` 这类固定编码接口时，建议先拿到完整 `THSCODE`，再继续查询

### 目录结构

当前代码已经按职责拆分，核心目录位于 `thsdk/`：

- `thsdk/thsdk.py`：对外聚合入口
- `thsdk/base.py`：连接、动态库调用、通用校验
- `thsdk/domestic.py`：国内固定长度行情接口
- `thsdk/catalog.py`：板块与市场列表接口
- `thsdk/market_queries.py`：`market_data_*` 系列通用查询
- `thsdk/misc_api.py`：问财、资讯、帮助、补全代码等
- `thsdk/response.py`：`Response` / `Payload`
- `thsdk/query_configs.py`：查询配置常量
- `thsdk/validators.py`：市场与代码规则常量
- `thsdk/STRUCTURE.md`：更详细的结构说明

### Web 单页查询工具

仓库内提供了一个独立的 Web 示例目录 `thsdk/examples/webapp/`，用于查询常用 THSDK 接口，并把返回结果自动转成表格展示。

示例目录说明见：[thsdk/examples/webapp/README.md](thsdk/examples/webapp/README.md)

启动方式：

```bash
python3 -m thsdk.examples.webapp --host 127.0.0.1 --port 8765
```

启动后打开 `http://127.0.0.1:8765`。

当前页面支持的常用接口包括：

- `search_symbols`
- `complete_ths_code`
- `klines`
- `intraday_data`
- `tick_level1`
- `min_snapshot`
- `big_order_flow`
- `corporate_action`
- `call_auction_anomaly`
- `news`
- `wencai_nlp`
- `market_data_cn/us/hk/uk/bond/fund/future/forex/index/block`

页面特性：

- 根据所选接口动态渲染参数表单
- 每个接口的必填字段都预置默认值，并带一键快捷预设
- 后端将 `data` / `extra` 统一标准化为表格或文本区域
- 每次请求独立建立并断开 THS 连接，避免页面查询之间共享状态
- 自动优先读取 `THS_USERNAME`、`THS_PASSWORD`、`THS_MAC` 环境变量

截图案例：

首次打开先做证券搜索：

![证券搜索页面截图](src/thsdk/examples/webapp/screenshots/case_search_symbols.png)

### README 维护原则

本项目的 README 会刻意保留较详细的接口示例和返回样例，而不是只放目录索引或极简说明，原因有两点：

- 方便人类读者一站式阅读，不必在多个文档之间来回跳转
- 方便 AI 直接读取完整上下文，用于代码理解、自动补全、脚本生成、问题排查和文档问答

因此后续维护时，README 仍应尽量保留高频接口的详细案例；模块拆分主要服务代码维护，不意味着 README 需要同步变成“只有链接没有内容”的文档。

### 典型使用流程

下面是一个从“代码查询”到“数据获取与分析”的完整示例流程，便于快速上手：

```python
from thsdk import THS

with THS() as ths:
    # 1. 通过名称模糊查询证券代码
    symbols = ths.search_symbols("同花顺")
    if not symbols.success or not symbols.data:
        raise RuntimeError(f"查询证券失败: {symbols.error}")

    thscode = symbols.data[0]["THSCODE"]

    # 2. 使用 THSCODE 获取 K 线数据
    klines = ths.klines(thscode, count=100)
    if not klines.success:
        raise RuntimeError(f"获取 K 线失败: {klines.error}")

    # 3. 转为 DataFrame 做分析
    df = klines.df
    print(df.tail())
```

### 账户配置

SDK 支持多种账户配置方式，优先级从高到低：

1. **直接传入参数**：
```python
ths = THS({
    "username": "your_username",
    "password": "your_password",
    "mac": "3e:8c:40:3e:0a:14"
})
```

2. **环境变量**：
```bash
export THS_USERNAME=your_username
export THS_PASSWORD=your_password
export THS_MAC=your_mac_address
```
```python
ths = THS()  # 自动读取环境变量
```

3. **临时游客账户**（仅用于测试，不推荐生产使用）：
```python
ths = THS()  # 自动使用临时账户
```

> 注意：临时游客账户通常在权限、可访问市场、数据延时等方面存在一定限制。生产环境强烈建议使用正式账户，并通过环境变量或配置管理安全地注入账号信息。

## API 参考

### THS 类

主要的客户端类，用于连接服务器和查询数据。

#### 初始化
```python
THS(ops: Optional[Dict[str, Any]] = None)
```

#### 连接管理
- `connect(max_retries: int = 5) -> Response`：连接到服务器
- `disconnect() -> None`：断开连接

#### 底层查询
- `query_data(params: dict, buffer_size: int = 1024 * 1024 * 2, max_attempts=5) -> Response`：通用查询数据接口

#### 数据查询方法

当前高层接口按职责大致分为四类：

- 国内固定长度行情接口：`klines`、`intraday_data`、`tick_level1`、`tick_super_level1`、`min_snapshot`、`call_auction`、`big_order_flow`、`corporate_action`
- 板块与列表接口：`block`、`block_constituents`、`market_block`、`stock_*_lists`、`ths_industry`、`ths_concept`
- 通用市场查询接口：`market_data_cn/us/hk/uk/bond/fund/future/forex/index/block`
- 杂项工具接口：`search_symbols`、`query_securities`、`wencai_*`、`news`、`ipo_*`、`complete_ths_code`、`help`

##### K线数据
- `klines(ths_code: str, start_time: Optional[datetime] = None, end_time: Optional[datetime] = None, adjust: str = "", interval: str = "day", count: int = -1) -> Response`
  - 获取历史K线数据
  - `ths_code` 仅支持国内固定编码，格式为 `4位市场代码 + 6位数字代码`
  - `interval` 支持：1m, 5m, 15m, 30m, 60m, 120m, day, week, month, quarter, year
  - `adjust` 支持：forward（前复权）, backward（后复权）, ""（不复权）

**请求参数：**
```python
ths.klines("USZA300033", count=3)
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": "2026-03-11 00:00:00",
      "收盘价": 324.64,
      "成交量": 8073410,
      "总金额": 2606503800,
      "开盘价": 321.1,
      "最高价": 326.5,
      "最低价": 318.44
    },
    {
      "时间": "2026-03-12 00:00:00",
      "收盘价": 325.06,
      "成交量": 7190869,
      "总金额": 2333578100,
      "开盘价": 322.42,
      "最高价": 326.88,
      "最低价": 321.21
    }
  ],
  "extra": {
    "ServerDelay": 0,
    "代码": "USZA300033"
  }
}
```

##### 分时数据
- `intraday_data(ths_code: str) -> Response`：日内分时数据
  - `ths_code` 仅支持国内固定编码，格式为 `4位市场代码 + 6位数字代码`

**请求参数：**
```python
ths.intraday_data("USZA300033")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": "2026-03-16 09:30:00+08:00",
      "价格": 317.98,
      "成交量": 23300,
      "总金额": 7408934,
      "领先指标": 4294967295
    },
    {
      "时间": "2026-03-16 09:31:00+08:00",
      "价格": 315.14,
      "成交量": 126600,
      "总金额": 40116357,
      "领先指标": 4294967295
    }
  ],
  "extra": {
    "ServerDelay": 0,
    "代码": "USZA300033"
  }
}
```

- `min_snapshot(ths_code: str, date: Optional[str] = None) -> Response`：历史分时数据
  - `ths_code` 仅支持国内固定编码，格式为 `4位市场代码 + 6位数字代码`

**请求参数：**
```python
ths.min_snapshot("USZA300033", date="20240315")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 1710466200,
      "价格": 135.33,
      "成交量": 11100,
      "外盘成交量": 5550,
      "内盘成交量": 5550,
      "总金额": 1502163
    }
  ],
  "extra": {
    "ServerDelay": 393295,
    "代码": "USZA300033"
  }
}
```

##### 成交数据
- `tick_level1(ths_code: str) -> Response`：3秒tick成交数据
  - `ths_code` 仅支持国内固定编码，格式为 `4位市场代码 + 6位数字代码`

**请求参数：**
```python
ths.tick_level1("USZA300033")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 1773623700,
      "价格": 316,
      "成交方向": 4294967295,
      "交易笔数": 0,
      "当前量": 1400
    },
    {
      "时间": 1773623709,
      "价格": 318,
      "成交方向": 4294967295,
      "交易笔数": 0,
      "当前量": 2000
    }
  ],
  "extra": {
    "ServerDelay": 1,
    "代码": "USZA300033"
  }
}
```

- `tick_super_level1(ths_code: str, date: Optional[str] = None) -> Response`：超级盘口数据（含委托档位）

**请求参数：**
```python
ths.tick_super_level1("USZA300033", date="20240315")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 1710465300,
      "价格": 136.03,
      "成交方向": 4294967295,
      "成交量": 0,
      "外盘成交量": 0,
      "买4价": 0,
      "买4量": 0,
      "卖4价": 0,
      "卖4量": 0,
      "买5价": 0,
      "买5量": 0,
      "卖5价": 0,
      "卖5量": 0,
      "交易笔数": 4294967295,
      "总金额": 4294967295,
      "委托买入价": 4294967295,
      "委托卖出价": 4294967295,
      "买1量": 4294967295,
      "买2价": 4294967295,
      "买2量": 4294967295,
      "买3价": 4294967295,
      "买3量": 4294967295,
      "卖1量": 4294967295,
      "卖2价": 4294967295,
      "卖2量": 4294967295,
      "卖3价": 4294967295,
      "卖3量": 4294967295,
      "当前量": 4294967295
    }
  ],
  "extra": {}
}
```

##### 深度数据
- `depth(ths_code: Union[str, list]) -> Response`：5档深度数据

**请求参数：**
```python
ths.depth("USZA300033")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "买4价": 317.77,
      "买4量": 500,
      "卖4价": 317.88,
      "卖4量": 200,
      "买5价": 317.76,
      "买5量": 400,
      "卖5价": 317.89,
      "卖5量": 200,
      "买1价": 317.8,
      "买1量": 12237,
      "买2价": 317.79,
      "买2量": 200,
      "买3价": 317.78,
      "买3量": 1800,
      "卖1价": 317.81,
      "卖1量": 1700,
      "卖2价": 317.82,
      "卖2量": 300,
      "卖3价": 317.86,
      "卖3量": 300,
      "代码": "USZA300033",
      "昨收价": 318.18
    }
  ],
  "extra": {
    "ServerDelay": 0
  }
}
```

- `order_book_ask(ths_code: str) -> Response`：卖方深度
- `order_book_bid(ths_code: str) -> Response`：买方深度

##### 板块数据
- `block(block_id: int) -> Response`：获取板块数据

**请求参数：**
```python
ths.block(0xE)  # 沪深A股
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "USZA002346",
      "名称": "柘中股份"
    },
    {
      "代码": "USZA002069",
      "名称": "獐子岛"
    }
  ],
  "extra": {
    "ServerDelay": 26,
    "total_count": 5198
  }
}
```

- `block_constituents(link_code: str) -> Response`：板块成分股

**请求参数：**
```python
ths.block_constituents("URFI883404")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "USHA600545",
      "名称": "卓郎智能"
    },
    {
      "代码": "USZA002207",
      "名称": "准油股份"
    }
  ],
  "extra": {
    "ServerDelay": 4294901763,
    "total_count": 318
  }
}
```

- `ths_industry() -> Response`：行业板块

**请求参数：**
```python
ths.ths_industry()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "URFI881165",
      "名称": "综合"
    },
    {
      "代码": "URFI881171",
      "名称": "自动化设备"
    }
  ],
  "extra": {
    "ServerDelay": 4294901765,
    "total_count": 90
  }
}
```

- `ths_concept() -> Response`：概念板块

**请求参数：**
```python
ths.ths_concept()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "URFI885580",
      "名称": "足球概念"
    },
    {
      "代码": "URFI885758",
      "名称": "租售同权"
    }
  ],
  "extra": {
    "ServerDelay": 4294901767,
    "total_count": 390
  }
}
```

- `index_list() -> Response`：指数列表

**请求参数：**
```python
ths.index_list()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "USHI1B0006",
      "名称": "综合指数"
    },
    {
      "代码": "USZI399319",
      "名称": "资源优势"
    }
  ],
  "extra": {
    "ServerDelay": 4294901766,
    "total_count": 580
  }
}
```

##### 通用市场数据
- `market_data_cn(ths_code: Any, query_key: str = "基础数据") -> Response`：A股市场数据
  - `ths_code` 使用国内固定编码，格式为 `4位市场代码 + 6位数字代码`

**请求参数：**
```python
ths.market_data_cn("USZA300033", query_key="基础数据")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "价格": 317.8,
      "成交方向": 17,
      "成交量": 5734581,
      "交易笔数": 32189,
      "总金额": 1809545100,
      "涨速": 0.025,
      "当前量": 100,
      "代码": "USZA300033",
      "名称": "同花顺",
      "昨收价": 318.18,
      "开盘价": 317.98,
      "最高价": 318.74,
      "最低价": 312.38
    }
  ],
  "extra": {
    "ServerDelay": 0
  }
}
```

- `market_data_us(ths_code: Any, query_key: str = "基础数据") -> Response`：美股市场数据
  - 支持 `4位市场代码 + 可变长度证券缩写`，如 `UNQQTSLA`
- `market_data_hk(ths_code: Any, query_key: str = "基础数据") -> Response`：港股市场数据
- `market_data_uk(ths_code: Any, query_key: str = "基础数据") -> Response`：英国市场数据
- `market_data_bond(ths_code: Any, query_key: str = "基础数据") -> Response`：债券市场数据
- `market_data_fund(ths_code: Any, query_key: str = "基础数据") -> Response`：基金市场数据
- `market_data_future(ths_code: Any, query_key: str = "基础数据") -> Response`：期货市场数据
- `market_data_block(block_code: Any, query_key: str = "基础数据") -> Response`：板块市场数据
- `market_data_forex(ths_code: Any, query_key: str = "基础数据") -> Response`：外汇市场数据

**请求参数：**
```python
ths.market_data_forex("UFXBGBPUSD", query_key="基础数据")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "价格": 1.33102,
      "交易笔数": 4294967295,
      "委托买入价": 1.33097,
      "委托卖出价": 1.33107,
      "代码": "UFXBGBPUSD",
      "名称": "英镑/美元",
      "昨收价": 1.3224,
      "开盘价": 1.32367,
      "最高价": 1.33119,
      "最低价": 1.32265
    }
  ],
  "extra": {}
}
```

- `market_data_index(ths_code: Any, query_key: str = "基础数据") -> Response`：指数市场数据
- `market_block(market: str) -> Response`：市场板块数据

**请求参数：**
```python
ths.market_block("UFXB")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "UFXBGBPUSD",
      "名称": "英镑/美元"
    },
    {
      "代码": "UFXBNZDUSD",
      "名称": "新西兰元/美元"
    }
  ],
  "extra": {
    "ServerDelay": 4294901762,
    "total_count": 25
  }
}
```

##### 期权数据
- `option_data(ths_code: Any, query_key: str = "基础数据") -> Response`：期权市场数据

##### 证券查询
- `search_symbols(pattern: str, needmarket: str = "") -> Response`：模糊查询证券代码

适用场景：

- 只知道股票名称、指数名称、板块名称时，直接传名称查询
- 只知道证券代码但不确定市场时，也可以直接传代码查询
- 需要缩小结果范围时，可结合 `needmarket` 使用，例如 `SH,SZ`、`NQ`、`RF`

**请求参数：**
```python
ths.search_symbols("同花顺")
```

```python
ths.search_symbols("300033")
ths.search_symbols("同花顺", "SH,SZ")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "MarketStr": "USZA",
      "Code": "300033",
      "Name": "同花顺",
      "CodeDisplay": "300033",
      "MarketDisplay": "深A",
      "THSCODE": "USZA300033"
    },
    {
      "MarketStr": "URFI",
      "Code": "883404",
      "Name": "同花顺情绪指数",
      "CodeDisplay": "883404",
      "MarketDisplay": "同指",
      "THSCODE": "URFI883404"
    }
  ],
  "extra": {}
}
```

- `query_securities(pattern: str, needmarket: str = "") -> Response`：查询证券信息

##### 杂项数据与工具
- `call_auction(ths_code: str) -> Response`：集合竞价数据

**请求参数：**
```python
ths.call_auction("USZA300033")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 1773624300,
      "成交方向": 2,
      "成交量": 2700,
      "总金额": 858546,
      "委托买入价": 440164,
      "委托卖出价": 563587
    }
  ],
  "extra": {}
}
```

- `big_order_flow(ths_code: str) -> Response`：大单数据

**请求参数：**
```python
ths.big_order_flow("USZA300033")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 1773624300,
      "成交方向": 2,
      "成交量": 2700,
      "总金额": 858546,
      "委托买入价": 440164,
      "委托卖出价": 563587
    }
  ],
  "extra": {}
}
```

- `call_auction_anomaly(market: str = "USHA") -> Response`：竞价异动

**请求参数：**
```python
ths.call_auction_anomaly("USHA")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 1773623700,
      "价格": 1,
      "总金额": 2147483648,
      "代码": "USHA601218",
      "名称": "吉鑫科技",
      "异动类型1": "涨停试盘"
    }
  ],
  "extra": {}
}
```

- `corporate_action(ths_code: str) -> Response`：权息资料

**请求参数：**
```python
ths.corporate_action("USZA300033")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "时间": 20100312,
      "权息资料": "2010-03-12(每十股 转增10.00股 红利3.00元)$"
    }
  ],
  "extra": {
    "ServerDelay": 65536,
    "代码": "USZA300033"
  }
}
```

- `wencai_base(condition: str) -> Response`：问财基础查询
- `order_book_ask(ths_code: str) -> Response`：市场深度卖方数据
- `order_book_bid(ths_code: str) -> Response`：市场深度买方数据

**请求参数：**
```python
ths.wencai_nlp("涨停")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "最新价": "10.79",
      "最新涨跌幅": "9.989806320081534",
      "涨停[20260316]": "涨停",
      "股票代码": "605366.SH",
      "股票简称": "宏柏新材"
    }
  ],
  "extra": {}
}
```

- `news(text_id: int = 0x3814, code: str = "1A0001", market: str = "USHI") -> Response`：资讯列表

  - 获取资讯列表
  - `text_id`: 资讯类型ID，默认0x3814
  - `code`: 证券代码，默认"1A0001"
  - `market`: 市场代码，默认"USHI"

**请求参数：**
```python
ths.news(text_id=0x3814, code="1A0001", market="USHI")
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "Op": "2",
      "Time": 1773669256,
      "Title": "WTI、布伦特原油跌幅进一步扩大",
      "ID": "675330069",
      "Code": "16:1A0001",
      "Stock": "1A0001",
      "Properties": "ctime=1773669228\nsumm=WTI原油失守94美元/桶，日内跌幅5.40%。布伦特原油回落至98美元/桶下方，日内跌3.00%。美国总统特朗普声称，只要伊朗战争结束，油价会像石头一样向下掉。\nsource=同花顺7x24快讯\n"
    },
    {
      "Op": "2",
      "Time": 1773669311,
      "Title": "李成钢：中方反对美方的单边的301调查",
      "ID": "675329930",
      "Code": "16:1A0001",
      "Stock": "1A0001",
      "Properties": "ctime=1773668562\nsumm=中国商务部国际贸易谈判代表兼副部长李成钢16日说，中方对美方单边的301调查的立场是一贯的，我们反对这种单边的调查。我们对这些调查的可能结果对来之不易的中美稳定的经贸关系可能造成的干扰和破坏表示担忧。 (新华社)\nsource=同花顺7x24快讯\n"
    },
    {
      "Op": "2",
      "Time": 1773669387,
      "Title": "李成钢：中美已就一些议题取得初步共识",
      "ID": "675328985",
      "Code": "16:1A0001",
      "Stock": "1A0001",
      "Properties": "ctime=1773665724\nsumm=中国商务部国际贸易谈判代表兼副部长李成钢16日说，过去的一天半时间，中美双方团队进行了深入、坦诚、建设性的磋商。通过这次的磋商，双方已经就一些议题取得了初步共识，下一步我们将继续保持磋商进程。 (新华社)\nsource=同花顺7x24快讯\n"
    }
  ],
  "extra": {}
}
```

##### 列表查询
- `stock_cn_lists() -> Response`：A股列表
- `stock_us_lists() -> Response`：美股列表
- `stock_hk_lists() -> Response`：港股列表
- `stock_bj_lists() -> Response`：北交所列表
- `stock_uk_lists() -> Response`：英国市场列表
- `stock_b_lists() -> Response`：B股列表
- `forex_list() -> Response`：外汇列表

**请求参数：**
```python
ths.forex_list()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "代码": "UFXBGBPUSD",
      "名称": "英镑/美元"
    },
    {
      "代码": "UFXBNZDUSD",
      "名称": "新西兰元/美元"
    }
  ],
  "extra": {
    "ServerDelay": 4294901763,
    "total_count": 25
  }
}
```

- `futures_lists() -> Response`：期货列表
- `option_lists() -> Response`：期权列表（未实现）
- `nasdaq_lists() -> Response`：纳斯达克列表
- `bond_lists() -> Response`：债券列表
- `fund_etf_lists() -> Response`：ETF基金列表
- `fund_etf_t0_lists() -> Response`：ETF T+0基金列表

##### IPO 数据
- `ipo_today() -> Response`：今日IPO数据

**请求参数：**
```python
ths.ipo_today()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "exchange": "GEM",
      "industry_name": "军工电子",
      "industry_ttm": "65.18",
      "issue_count": "3038.7340",
      "issue_pe_static": "33.61",
      "issue_pe_ttm": "26.5659",
      "issue_price": "69.6600",
      "listing_date": null,
      "market_id": "33",
      "order_code": "301682",
      "order_date": "20260316",
      "order_limit_up": "0.8500",
      "pre_issue_info": [],
      "stock_code": "301682",
      "stock_name": "宏明电子",
      "success_date": "20260318",
      "success_rate": "0.0163",
      "top_order": "8.5000"
    }
  ],
  "extra": {}
}
```

- `ipo_wait() -> Response`：待上市IPO数据

**请求参数：**
```python
ths.ipo_wait()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [
    {
      "exchange": "S",
      "industry_name": "小金属",
      "industry_ttm": "40.32",
      "issue_count": "21500.0000",
      "issue_pe_static": null,
      "issue_pe_ttm": null,
      "issue_price": null,
      "listing_date": null,
      "market_id": "33",
      "order_code": "001257",
      "order_date": "20260320",
      "order_limit_up": "4.5000",
      "pre_issue_info": [],
      "stock_code": "001257",
      "stock_name": "盛龙股份",
      "success_date": "20260324",
      "success_rate": null,
      "top_order": "45.0000"
    }
  ],
  "extra": {}
}
```

##### 工具类
- `complete_ths_code(ths_code: Union[str, list]) -> Response`：完整THS代码信息

适用场景：

- 只知道纯证券代码，不知道前面的 4 位市场代码时，先用它补齐
- 补齐后可将返回的完整 `THSCODE` 继续传给 `klines`、`intraday_data`、`market_data_cn` 等接口
- 批量补齐时可直接传入代码列表

**请求参数：**
```python
ths.complete_ths_code("300033")
ths.complete_ths_code(["300033", "600519", "TSLA"])
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": [],
  "extra": {}
}
```

- `help(req: str = "") -> str`：帮助信息

**请求参数：**
```python
ths.help()
```

**返回数据示例：**
```json
{
  "success": true,
  "error": "",
  "data": "似乎没匹配到help查询字段,支持常用help字段:doc,version,about,donation",
  "extra": {}
}
```

##### 连接管理
- `disconnect() -> None`：断开连接

##### 查询证券
- `query_securities(pattern: str, needmarket: str = "") -> Response`：查询证券信息

### Response 类

API 响应的封装类。

#### 属性
- `success: bool`：是否成功
- `error: str`：错误信息
- `data: Optional[Union[Dict[str, Any], List[Dict], str]]`：响应数据
- `extra: Dict[str, Any]`：额外信息

#### 方法
- `df -> pd.DataFrame`：转换为 Pandas DataFrame

## 示例

项目提供了丰富的示例代码，位于 `thsdk/examples/` 目录：

### 数据查询示例
- `kline.py`：K线数据查询
- `intraday_data.py`：日内分时数据查询
- `min_snapshot.py`：历史分时数据查询
- `tick_level1.py`：3秒Tick成交数据查询
- `tick_super_level1.py`：超级盘口数据查询
- `depth.py`：5档深度数据查询
- `depth_details.py`：深度详情查询

### 板块数据示例
- `block.py`：板块数据查询
- `block_constituents.py`：板块成分股查询
- `industry.py`：行业板块查询
- `concept.py`：概念板块查询
- `codes_by_block.py`：按板块查询代码
- `codes_by_market.py`：按市场查询代码

### 市场数据示例
- `market_data_cn.py`：A股固定长度代码市场数据
- `market_data_us.py`：美股市场数据
- `market_data_hk.py`：港股市场数据
- `market_data_uk.py`：英股市场数据
- `market_data_bond.py`：债券市场数据
- `market_data_fund.py`：基金市场数据
- `market_data_future.py`：期货市场数据
- `market_data_block.py`：板块市场数据
- `market_data_forex.py`：外汇市场数据
- `market_data_index.py`：指数市场数据

### 交易数据示例
- `call_auction.py`：集合竞价数据
- `call_auction_anomaly.py`：竞价异动数据
- `big_order_flow.py`：大单数据
- `corporate_action.py`：权息资料

### 查询示例
- `search_symbols.py`：证券模糊查询
- `wencai_nlp.py`：问财自然语言查询
- `query_data.py`：通用查询数据

### 其他示例
- `webapp/`：本地 Web 单页查询工具与截图案例
- `news.py`：资讯查询
- `forex.py`：外汇数据
- `hs300.py`：沪深300指数
- `ipo.py`：IPO数据
- `complete_ths_code.py`：完整THS代码
- `help.py`：帮助信息
- `dde.py`：DDE数据
- `loop.py`：循环查询示例
- `test_thsdk.py`：测试示例

运行示例：
```bash
python thsdk/examples/kline.py
```

一键检查全部示例语法：
```bash
python thsdk/examples/run_all_examples.py
```

一键顺序运行全部示例：
```bash
python thsdk/examples/run_all_examples.py --mode live
```

如果也要包含 `test_thsdk.py`：
```bash
python thsdk/examples/run_all_examples.py --mode live --include-test-script
```

## 错误处理

所有 API 方法返回 `Response` 对象。示例代码的推荐写法是先判断 `if not response:`，失败后立即 `return` 或 `continue`，成功后再访问 `response.df` 或 `response.data`：

```python
response = ths.klines("USZA300033", count=100)
if not response:
    print(f"错误: {response.error}")
    return

df = response.df
print(df)
```

如果需要批量运行 `examples` 目录：

- 只做语法检查：`python thsdk/examples/run_all_examples.py`
- 顺序执行全部示例：`python thsdk/examples/run_all_examples.py --mode live`
- 只执行部分示例：`python thsdk/examples/run_all_examples.py --pattern 'market_data_*.py'`
- 批量 API 冒烟测试：`python thsdk/examples/test_thsdk.py --suite all`

## 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE) 文件。

## 贡献

欢迎提交 Issue 和 Pull Request！

## API 示例数据

README 中保留了常用接口的静态示例响应，便于直接查看各 API 方法的返回结构。

## 常见问题

1. **连接失败**：检查账户信息是否正确，或使用临时游客账户测试
2. **数据为空**：确认证券代码格式与接口要求一致。国内固定编码接口使用 `4位市场代码 + 6位数字代码`，通用市场接口可使用 `4位市场代码 + 可变长度证券缩写`
3. **性能问题**：对于大量数据查询，考虑调整 `buffer_size` 参数
4. **时区问题**：所有时间数据自动转换为亚洲/上海时区
5. **权限不足 / 返回错误码**：请确认当前账户已开通相应市场和数据权限；若为临时游客账户，可能不支持部分专业数据或实时数据
6. **请求频率受限**：ths侧可能对频繁、大量拉取数据进行限流，建议在批量任务中增加 `sleep` 间隔或分批次拉取
7. **在 Web/异步框架中使用**：`THS` 为同步阻塞调用，如在 `FastAPI` / `asyncio` 中使用，建议放入线程池执行，避免阻塞事件循环

## 版本历史

- v1.0.0：初始版本，支持基础行情数据查询
- v1.5.0：补充多市场支持（港股、美股等），增加部分列表类接口
- v1.7.0：增加示例响应数据及自动生成脚本，优化 `Response.df` 转换逻辑
- v1.7.14：补充期权、IPO 等接口，改进文档与 Apple Silicon 支持
- v1.7.16：cc 重构代码结构
