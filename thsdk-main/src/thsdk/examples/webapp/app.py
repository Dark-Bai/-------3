# encoding: utf-8
from __future__ import annotations

import argparse
import json
import re
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional, Union
from urllib.parse import urlparse

from ...query_configs import (
    MARKET_DATA_BLOCK_QUERY_CONFIG,
    MARKET_DATA_BOND_QUERY_CONFIG,
    MARKET_DATA_CN_QUERY_CONFIG,
    MARKET_DATA_FOREX_QUERY_CONFIG,
    MARKET_DATA_FUND_QUERY_CONFIG,
    MARKET_DATA_FUTURE_QUERY_CONFIG,
    MARKET_DATA_HK_QUERY_CONFIG,
    MARKET_DATA_INDEX_QUERY_CONFIG,
    MARKET_DATA_UK_QUERY_CONFIG,
    MARKET_DATA_US_QUERY_CONFIG,
)
from ...response import Response
from ...thsdk import THS

__all__ = [
    "LIST_DATA_PRESETS",
    "METHOD_SPECS",
    "MARKET_DATA_PRESETS",
    "PRESET_QUERIES",
    "build_schema_payload",
    "execute_web_query",
    "main",
    "run_server",
]


FieldOption = tuple[str, str]
Executor = Callable[[Any, dict[str, Any]], Any]
ExecutionResult = tuple[dict[str, Any], dict[str, Any], dict[str, float]]


@dataclass(frozen=True)
class FieldSpec:
    name: str
    label: str
    kind: str = "text"
    required: bool = False
    placeholder: str = ""
    default: Any = ""
    help_text: str = ""
    options: tuple[FieldOption, ...] = ()

    def to_schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "kind": self.kind,
            "required": self.required,
            "placeholder": self.placeholder,
            "default": self.default,
            "help_text": self.help_text,
            "options": [{"value": value, "label": label} for value, label in self.options],
        }


@dataclass(frozen=True)
class MethodSpec:
    label: str
    description: str
    fields: tuple[FieldSpec, ...]
    example: str
    executor: Executor

    def to_schema(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "description": self.description,
            "example": self.example,
            "fields": [field.to_schema() for field in self.fields],
        }


class THSConnectionError(RuntimeError):
    def __init__(self, payload: dict[str, Any]):
        super().__init__(str(payload.get("error", "THS 连接失败")))
        self.payload = payload


class THSSingletonConnection:
    """Serialize web queries through one shared THS client and keep the TCP session alive."""

    def __init__(self, ths_factory: Callable[[], Any] = THS):
        self._ths_factory = ths_factory
        self._ths: Any | None = None
        self._lock = threading.RLock()

    def execute(self, query: Callable[[Any], ExecutionResult]) -> ExecutionResult:
        wait_started_at = time.perf_counter()
        with self._lock:
            lock_wait_ms = round((time.perf_counter() - wait_started_at) * 1000, 2)
            raw_payload, request_view, timing = self._execute_locked(query, allow_retry=True)
            timing = dict(timing)
            timing["lock_wait_ms"] = lock_wait_ms
            return raw_payload, request_view, timing

    def close(self) -> None:
        with self._lock:
            self._reset_locked()

    def _execute_locked(
        self, query: Callable[[Any], ExecutionResult], allow_retry: bool
    ) -> ExecutionResult:
        ths, connect_duration_ms = self._ensure_connected_locked()
        try:
            raw_payload, request_view, timing = query(ths)
        except Exception as exc:
            if allow_retry and _is_connection_error(str(exc)):
                self._reset_locked()
                return self._execute_locked(query, allow_retry=False)
            raise

        if allow_retry and _should_reconnect(raw_payload):
            self._reset_locked()
            return self._execute_locked(query, allow_retry=False)

        if connect_duration_ms > 0:
            timing = dict(timing)
            timing["connect_duration_ms"] = connect_duration_ms
        return raw_payload, request_view, timing

    def _ensure_connected_locked(self) -> tuple[Any, float]:
        connect_duration_ms = 0.0
        if self._ths is None:
            self._ths = self._ths_factory()

        if not getattr(self._ths, "_initialized", False):
            connect_started_at = time.perf_counter()
            connect_response = self._ths.connect()
            connect_duration_ms = round((time.perf_counter() - connect_started_at) * 1000, 2)
            if not connect_response.success:
                payload = connect_response.to_dict()
                self._reset_locked()
                raise THSConnectionError(payload)
        return self._ths, connect_duration_ms

    def _reset_locked(self) -> None:
        ths = self._ths
        self._ths = None
        if ths is None:
            return
        try:
            ths.disconnect()
        except Exception:
            pass


def _select_options(values: list[str], labels: Optional[dict[str, str]] = None) -> tuple[FieldOption, ...]:
    labels = labels or {}
    return tuple((value, labels.get(value, value)) for value in values)


def _call_sdk_method(method_name: str) -> Executor:
    def _executor(ths: Any, values: dict[str, Any]) -> Any:
        return getattr(ths, method_name)(**values)

    return _executor


def _field_has_default(field: FieldSpec) -> bool:
    if field.default != "":
        return True
    return field.kind == "select" and any(option_value == "" for option_value, _ in field.options)


def _required_default_values(spec: MethodSpec) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for field in spec.fields:
        if _field_has_default(field):
            values[field.name] = field.default
        elif field.required:
            raise ValueError(f"{spec.label} 缺少必填字段默认值: {field.name}")
    return values


INTERVAL_OPTIONS = _select_options(
    ["1m", "5m", "15m", "30m", "60m", "120m", "day", "week", "month", "quarter", "year"]
)
ADJUST_OPTIONS = (
    ("", "不复权"),
    ("forward", "前复权"),
    ("backward", "后复权"),
)
MARKET_DATA_METHODS = {
    "market_data_cn": {
        "label": "A股/国内基础行情",
        "query_config": MARKET_DATA_CN_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "USZA300033",
    },
    "market_data_us": {
        "label": "美股行情",
        "query_config": MARKET_DATA_US_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "UNQQTSLA",
    },
    "market_data_hk": {
        "label": "港股行情",
        "query_config": MARKET_DATA_HK_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "UHKM00700",
    },
    "market_data_uk": {
        "label": "英股行情",
        "query_config": MARKET_DATA_UK_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "UEUACPIC",
    },
    "market_data_bond": {
        "label": "债券行情",
        "query_config": MARKET_DATA_BOND_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "USHD113037",
    },
    "market_data_fund": {
        "label": "基金行情",
        "query_config": MARKET_DATA_FUND_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "USZJ159629",
    },
    "market_data_future": {
        "label": "期货行情",
        "query_config": MARKET_DATA_FUTURE_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "UGFFIF00",
    },
    "market_data_forex": {
        "label": "外汇行情",
        "query_config": MARKET_DATA_FOREX_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "UFXBUSDCNY",
    },
    "market_data_index": {
        "label": "指数行情",
        "query_config": MARKET_DATA_INDEX_QUERY_CONFIG,
        "code_field": "ths_code",
        "code_label": "证券代码",
        "default_code": "USHI1B0935",
    },
    "market_data_block": {
        "label": "板块行情",
        "query_config": MARKET_DATA_BLOCK_QUERY_CONFIG,
        "code_field": "block_code",
        "code_label": "板块代码",
        "default_code": "URFI883404",
    },
}
MARKET_DATA_METHOD_ORDER = tuple(MARKET_DATA_METHODS.keys())
MARKET_DATA_AUTO_LOADERS = {
    "market_data_cn": (("stock_cn_lists", {}),),
    "market_data_us": (("stock_us_lists", {}),),
    "market_data_hk": (("stock_hk_lists", {}),),
    "market_data_uk": (("stock_uk_lists", {}),),
    "market_data_bond": (("bond_lists", {}),),
    "market_data_fund": (("fund_etf_lists", {}),),
    "market_data_future": (("futures_lists", {}),),
    "market_data_forex": (("forex_list", {}),),
    "market_data_index": (("index_list", {}),),
    "market_data_block": (("ths_industry", {}), ("ths_concept", {})),
}
LIST_DATA_METHODS = {
    "ths_industry": {
        "label": "行业板块列表",
        "description": "获取同花顺行业板块列表。",
        "fields": (),
        "example": "ths_industry()",
    },
    "ths_concept": {
        "label": "概念板块列表",
        "description": "获取同花顺概念板块列表。",
        "fields": (),
        "example": "ths_concept()",
    },
    "index_list": {
        "label": "指数列表",
        "description": "获取指数代码列表，可配合 market_data_index 使用。",
        "fields": (),
        "example": "index_list()",
    },
    "stock_cn_lists": {
        "label": "A股列表",
        "description": "获取 A 股证券列表，可配合 market_data_cn 使用。",
        "fields": (),
        "example": "stock_cn_lists()",
    },
    "stock_us_lists": {
        "label": "美股列表",
        "description": "获取美股列表，可配合 market_data_us 使用。",
        "fields": (),
        "example": "stock_us_lists()",
    },
    "stock_hk_lists": {
        "label": "港股列表",
        "description": "获取港股列表，可配合 market_data_hk 使用。",
        "fields": (),
        "example": "stock_hk_lists()",
    },
    "stock_bj_lists": {
        "label": "北交所列表",
        "description": "获取北交所证券列表。",
        "fields": (),
        "example": "stock_bj_lists()",
    },
    "stock_uk_lists": {
        "label": "英股列表",
        "description": "获取英股列表，可配合 market_data_uk 使用。",
        "fields": (),
        "example": "stock_uk_lists()",
    },
    "stock_b_lists": {
        "label": "B股列表",
        "description": "获取 B 股证券列表。",
        "fields": (),
        "example": "stock_b_lists()",
    },
    "futures_lists": {
        "label": "期货列表",
        "description": "获取期货列表，可配合 market_data_future 使用。",
        "fields": (),
        "example": "futures_lists()",
    },
    "bond_lists": {
        "label": "债券列表",
        "description": "获取债券列表，可配合 market_data_bond 使用。",
        "fields": (),
        "example": "bond_lists()",
    },
    "fund_etf_lists": {
        "label": "ETF基金列表",
        "description": "获取 ETF 基金列表，可配合 market_data_fund 使用。",
        "fields": (),
        "example": "fund_etf_lists()",
    },
    "fund_etf_t0_lists": {
        "label": "ETF T+0 列表",
        "description": "获取 ETF T+0 基金列表。",
        "fields": (),
        "example": "fund_etf_t0_lists()",
    },
    "forex_list": {
        "label": "外汇列表",
        "description": "获取外汇列表，可配合 market_data_forex 使用。",
        "fields": (),
        "example": "forex_list()",
    },
    "nasdaq_lists": {
        "label": "纳斯达克列表",
        "description": "获取纳斯达克列表，可配合 market_data_us 使用。",
        "fields": (),
        "example": "nasdaq_lists()",
    },
    "market_block": {
        "label": "市场板块列表",
        "description": "按市场代码拉取对应市场的列表数据。",
        "fields": (
            FieldSpec(
                "market",
                "市场代码",
                kind="market",
                required=True,
                default="UFXB",
                help_text="例如 UFXB、UEUA、UNQQ。",
            ),
        ),
        "example": "market_block('UFXB')",
    },
    "block": {
        "label": "板块列表",
        "description": "按 block_id 获取指定板块分组的列表数据。",
        "fields": (
            FieldSpec(
                "block_id",
                "板块 ID",
                kind="int_auto",
                required=True,
                default="0xCE5F",
                help_text="默认 0xCE5F 为行业板块，0xCE5E 为概念板块。",
            ),
        ),
        "example": "block(0xCE5F)",
    },
    "block_constituents": {
        "label": "板块成分股",
        "description": "按板块代码获取成分股列表。",
        "fields": (
            FieldSpec(
                "link_code",
                "板块代码",
                kind="code",
                required=True,
                default="URFI883404",
                help_text="例如 URFI883404。",
            ),
        ),
        "example": "block_constituents('URFI883404')",
    },
}


def _market_data_fields(
    query_config: dict[str, dict[str, str]],
    *,
    code_field: str = "ths_code",
    code_label: str = "证券代码",
    default_code: str = "",
) -> tuple[FieldSpec, ...]:
    return (
        FieldSpec(
            code_field,
            code_label,
            kind="codes",
            required=False,
            default="",
            placeholder="留空则自动拉取该市场全部列表并分批查询，也可输入 USHA600519 / UNQQTSLA / URFI883404",
            help_text="手动输入多个代码时同一次请求内必须属于同一市场；留空会自动走对应列表接口，结果可能较大。",
        ),
        FieldSpec(
            "query_key",
            "查询模板",
            kind="select",
            required=True,
            default=next(iter(query_config.keys())),
            options=_select_options(list(query_config.keys())),
            help_text="映射 SDK 内置的 query_key，决定字段集合。",
        ),
    )


METHOD_SPECS: dict[str, MethodSpec] = {
    "search_symbols": MethodSpec(
        label="证券搜索",
        description="按名称、数字代码或简称模糊搜索证券，并直接返回可用的 THSCODE。",
        fields=(
            FieldSpec(
                "pattern",
                "搜索关键字",
                required=True,
                default="同花顺",
                placeholder="同花顺 / 300033 / TSLA",
                help_text="支持名称、代码和简称模糊匹配。",
            ),
            FieldSpec(
                "needmarket",
                "限定市场",
                kind="market",
                placeholder="可选，例如 USHA / UNQQ",
                help_text="留空表示全市场搜索。",
            ),
        ),
        example="search_symbols('同花顺')",
        executor=_call_sdk_method("search_symbols"),
    ),
    "complete_ths_code": MethodSpec(
        label="补全 THSCODE",
        description="输入裸代码或混合代码列表，返回平台识别后的完整 THSCODE。",
        fields=(
            FieldSpec(
                "ths_code",
                "代码列表",
                kind="codes",
                required=True,
                default="300033",
                placeholder="300033, 600519, UNQQTSLA",
                help_text="单个代码会按字符串传入，多个代码会按列表传入。",
            ),
        ),
        example="complete_ths_code(['300033', '600519'])",
        executor=_call_sdk_method("complete_ths_code"),
    ),
    "klines": MethodSpec(
        label="K 线数据",
        description="获取固定编码证券的历史 K 线。页面默认使用 count 模式，避免时间范围表单过长。",
        fields=(
            FieldSpec(
                "ths_code",
                "证券代码",
                kind="code",
                required=True,
                default="USZA300033",
                placeholder="USZA300033",
                help_text="仅支持 4 位市场 + 6 位数字的固定长度代码。",
            ),
            FieldSpec(
                "count",
                "返回条数",
                kind="int",
                required=True,
                default=30,
                placeholder="30",
                help_text="正整数，表示拉取最近多少条记录。",
            ),
            FieldSpec(
                "interval",
                "周期",
                kind="select",
                required=True,
                default="day",
                options=INTERVAL_OPTIONS,
            ),
            FieldSpec(
                "adjust",
                "复权方式",
                kind="select",
                default="",
                options=ADJUST_OPTIONS,
            ),
        ),
        example="klines('USZA300033', count=30, interval='day')",
        executor=_call_sdk_method("klines"),
    ),
    "intraday_data": MethodSpec(
        label="分时走势",
        description="查询固定编码证券的分时数据。",
        fields=(
            FieldSpec(
                "ths_code",
                "证券代码",
                kind="code",
                required=True,
                default="USZA300033",
                placeholder="USHA600519",
            ),
        ),
        example="intraday_data('USHA600519')",
        executor=_call_sdk_method("intraday_data"),
    ),
    "tick_level1": MethodSpec(
        label="Level1 Tick",
        description="查询逐笔基础行情。",
        fields=(
            FieldSpec(
                "ths_code",
                "证券代码",
                kind="code",
                required=True,
                default="USZA300033",
                placeholder="USZA300033",
            ),
        ),
        example="tick_level1('USZA300033')",
        executor=_call_sdk_method("tick_level1"),
    ),
    "min_snapshot": MethodSpec(
        label="分笔快照",
        description="获取分钟级快照数据，可按 YYYYMMDD 指定历史日期。",
        fields=(
            FieldSpec(
                "ths_code",
                "证券代码",
                kind="code",
                required=True,
                default="USZA300033",
                placeholder="USZA300033",
            ),
            FieldSpec(
                "date",
                "日期",
                kind="date8",
                default="20251225",
                placeholder="可选，格式 YYYYMMDD",
                help_text="不填时查询最新可用日期。",
            ),
        ),
        example="min_snapshot('USZA300033', date='20260331')",
        executor=_call_sdk_method("min_snapshot"),
    ),
    "big_order_flow": MethodSpec(
        label="大单资金流",
        description="查询 A 股大单资金流数据。",
        fields=(
            FieldSpec(
                "ths_code",
                "证券代码",
                kind="code",
                required=True,
                default="USZA300033",
                placeholder="USHA600519",
            ),
        ),
        example="big_order_flow('USHA600519')",
        executor=_call_sdk_method("big_order_flow"),
    ),
    "corporate_action": MethodSpec(
        label="公司行为",
        description="查询分红、送股等公司行为数据。",
        fields=(
            FieldSpec(
                "ths_code",
                "证券代码",
                kind="code",
                required=True,
                default="USZA300033",
                placeholder="USHA600519",
            ),
        ),
        example="corporate_action('USHA600519')",
        executor=_call_sdk_method("corporate_action"),
    ),
    "news": MethodSpec(
        label="资讯列表",
        description="根据 text_id、代码和市场查询资讯列表。",
        fields=(
            FieldSpec(
                "text_id",
                "资讯分类 ID",
                kind="int_auto",
                required=True,
                default="0x3814",
                placeholder="支持十进制或 0x 前缀十六进制",
            ),
            FieldSpec(
                "code",
                "资讯代码",
                kind="code_fragment",
                required=True,
                default="1A0001",
            ),
            FieldSpec(
                "market",
                "市场代码",
                kind="market",
                required=True,
                default="USHI",
            ),
        ),
        example="news(text_id=0x3814, code='1A0001', market='USHI')",
        executor=_call_sdk_method("news"),
    ),
    "wencai_nlp": MethodSpec(
        label="问财自然语言",
        description="直接把自然语言条件发给问财接口，适合做探索式查询。",
        fields=(
            FieldSpec(
                "condition",
                "问财条件",
                kind="textarea",
                required=True,
                default="涨停",
                placeholder="例如：近5日涨停且换手率大于10%的A股",
                help_text="建议输入完整语句，便于直接返回结构化表格。",
            ),
        ),
        example="wencai_nlp('近5日涨停且换手率大于10%的A股')",
        executor=_call_sdk_method("wencai_nlp"),
    ),
    "call_auction_anomaly": MethodSpec(
        label="集合竞价异动",
        description="按市场拉取集合竞价异动列表。",
        fields=(
            FieldSpec(
                "market",
                "市场代码",
                kind="market",
                required=True,
                default="USHA",
            ),
        ),
        example="call_auction_anomaly(market='USHA')",
        executor=_call_sdk_method("call_auction_anomaly"),
    ),
}

for method_name, config in MARKET_DATA_METHODS.items():
    query_config = config["query_config"]
    METHOD_SPECS[method_name] = MethodSpec(
        label=config["label"],
        description="按市场类型查询通用行情字段。Web 页面里留空证券代码时，会自动加载该市场全部列表并分批合并返回。",
        fields=_market_data_fields(
            query_config,
            code_field=config["code_field"],
            code_label=config["code_label"],
            default_code=config["default_code"],
        ),
        example=f"{method_name}('{config['default_code']}', query_key='{next(iter(query_config.keys()))}')",
        executor=_call_sdk_method(method_name),
    )

for method_name, config in LIST_DATA_METHODS.items():
    METHOD_SPECS[method_name] = MethodSpec(
        label=config["label"],
        description=config["description"],
        fields=config["fields"],
        example=config["example"],
        executor=_call_sdk_method(method_name),
    )


def _ordered_method_names() -> tuple[str, ...]:
    ordered: list[str] = []
    seen: set[str] = set()

    priority_methods = (
        "search_symbols",
        "complete_ths_code",
        *MARKET_DATA_METHOD_ORDER,
    )
    for method_name in priority_methods:
        if method_name in METHOD_SPECS and method_name not in seen:
            ordered.append(method_name)
            seen.add(method_name)

    for method_name in METHOD_SPECS:
        if method_name not in seen:
            ordered.append(method_name)
            seen.add(method_name)

    return tuple(ordered)


def _method_groups() -> tuple[dict[str, Any], ...]:
    market_data = [name for name in _ordered_method_names() if name in MARKET_DATA_METHODS]
    list_data = [name for name in _ordered_method_names() if name in LIST_DATA_METHODS]
    misc_data = [name for name in _ordered_method_names() if name not in MARKET_DATA_METHODS and name not in LIST_DATA_METHODS]
    return (
        {"label": "常用查询", "methods": misc_data},
        {"label": "市场数据接口", "methods": market_data},
        {"label": "列表与板块接口", "methods": list_data},
    )


def build_preset_queries() -> tuple[dict[str, Any], ...]:
    return tuple(
        {
            "label": METHOD_SPECS[method_name].label,
            "method": method_name,
            "values": _required_default_values(METHOD_SPECS[method_name]),
        }
        for method_name in _ordered_method_names()
    )


PRESET_QUERIES = build_preset_queries()
LIST_DATA_PRESETS = tuple(
    preset
    for preset in PRESET_QUERIES
    if preset["method"] in LIST_DATA_METHODS
)
MARKET_DATA_PRESETS = tuple(preset for preset in PRESET_QUERIES if preset["method"].startswith("market_data_"))


def _coerce_codes(raw_value: Any) -> Union[str, list[str]]:
    if isinstance(raw_value, list):
        cleaned = [str(item).strip().upper() for item in raw_value if str(item).strip()]
    else:
        cleaned = [part.strip().upper() for part in re.split(r"[\s,，;；]+", str(raw_value)) if part.strip()]

    if not cleaned:
        raise ValueError("请输入至少一个代码")
    return cleaned[0] if len(cleaned) == 1 else cleaned


def _coerce_single_code(raw_value: Any) -> str:
    value = str(raw_value).strip().upper()
    if not value:
        raise ValueError("代码不能为空")
    return value


def _coerce_market(raw_value: Any) -> str:
    value = str(raw_value).strip().upper()
    if not value:
        raise ValueError("市场代码不能为空")
    return value


def _coerce_date8(raw_value: Any) -> str:
    value = str(raw_value).strip()
    if not re.fullmatch(r"\d{8}", value):
        raise ValueError("日期格式必须为 YYYYMMDD")
    return value


def _normalize_field_value(field: FieldSpec, raw_value: Any) -> Any:
    empty = raw_value is None or (isinstance(raw_value, str) and not raw_value.strip())
    if empty:
        if _field_has_default(field):
            raw_value = field.default
        elif field.required:
            raise ValueError(f"{field.label} 不能为空")
        else:
            return None

    if field.kind == "textarea":
        value = str(raw_value).strip()
    elif field.kind == "int":
        value = int(str(raw_value).strip())
    elif field.kind == "int_auto":
        value = int(str(raw_value).strip(), 0)
    elif field.kind == "select":
        value = str(raw_value)
        allowed = {option_value for option_value, _ in field.options}
        if value not in allowed:
            raise ValueError(f"{field.label} 取值无效，必须属于 {sorted(allowed)}")
    elif field.kind == "codes":
        value = _coerce_codes(raw_value)
    elif field.kind == "code":
        value = _coerce_single_code(raw_value)
    elif field.kind == "code_fragment":
        value = str(raw_value).strip().upper()
    elif field.kind == "market":
        value = _coerce_market(raw_value)
    elif field.kind == "date8":
        value = _coerce_date8(raw_value)
    else:
        value = str(raw_value).strip()

    if field.required and value in ("", None, []):
        raise ValueError(f"{field.label} 不能为空")
    return value


def normalize_request_payload(method_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    spec = METHOD_SPECS.get(method_name)
    if spec is None:
        raise ValueError(f"暂不支持的接口: {method_name}")

    values: dict[str, Any] = {}
    for field in spec.fields:
        value = _normalize_field_value(field, payload.get(field.name))
        if value is not None:
            values[field.name] = value
    return values


def _serialize_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _serialize_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_serialize_value(item) for item in value]
    return value


def _normalize_result_block(data: Any) -> dict[str, Any]:
    serialized = _serialize_value(data)
    if serialized is None:
        return {"kind": "empty", "columns": [], "rows": [], "row_count": 0}

    if isinstance(serialized, list):
        if not serialized:
            return {"kind": "table", "columns": [], "rows": [], "row_count": 0}

        if all(isinstance(item, dict) for item in serialized):
            columns: list[str] = []
            for item in serialized:
                for key in item.keys():
                    if key not in columns:
                        columns.append(str(key))
            rows = [{column: item.get(column, "") for column in columns} for item in serialized]
            return {"kind": "table", "columns": columns, "rows": rows, "row_count": len(rows)}

        rows = [{"值": item} for item in serialized]
        return {"kind": "table", "columns": ["值"], "rows": rows, "row_count": len(rows)}

    if isinstance(serialized, dict):
        columns = [str(key) for key in serialized.keys()]
        return {
            "kind": "table",
            "columns": columns,
            "rows": [{column: serialized.get(column, "") for column in columns}],
            "row_count": 1,
        }

    return {"kind": "text", "text": str(serialized), "row_count": 0}


def _response_to_dict(result: Any) -> dict[str, Any]:
    if isinstance(result, Response):
        return result.to_dict()
    if hasattr(result, "to_dict") and callable(result.to_dict):
        return _serialize_value(result.to_dict())
    return {
        "success": True,
        "error": "",
        "data": _serialize_value(result),
        "extra": {},
    }


def _pick_code_key(rows: list[dict[str, Any]]) -> str | None:
    for key in ("代码", "THSCODE", "Code", "code", "link_code", "block_code"):
        if any(key in row for row in rows):
            return key
    return None


def _extract_rows(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        return [data]
    return []


def _load_market_data_codes(ths: Any, method_name: str) -> tuple[list[str], list[str], dict[str, Any], float]:
    loader_specs = MARKET_DATA_AUTO_LOADERS.get(method_name, ())
    all_codes: list[str] = []
    errors: list[str] = []
    loader_summary: list[dict[str, Any]] = []
    seen: set[str] = set()
    sdk_duration_ms = 0.0

    for loader_name, loader_kwargs in loader_specs:
        started_at = time.perf_counter()
        response = getattr(ths, loader_name)(**loader_kwargs)
        sdk_duration_ms += (time.perf_counter() - started_at) * 1000
        if not response:
            errors.append(f"{loader_name}: {response.error}")
            continue

        rows = _extract_rows(response.data)
        code_key = _pick_code_key(rows)
        if not code_key:
            errors.append(f"{loader_name}: 返回中缺少代码列")
            continue

        loader_codes: list[str] = []
        for row in rows:
            value = row.get(code_key)
            if value is None:
                continue
            code = str(value).strip().upper()
            if not code or code in seen:
                continue
            seen.add(code)
            loader_codes.append(code)
            all_codes.append(code)

        loader_summary.append({"loader": loader_name, "count": len(loader_codes)})

    meta = {
        "load_mode": "all_market",
        "loaders": loader_summary,
        "code_count": len(all_codes),
    }
    return all_codes, errors, meta, round(sdk_duration_ms, 2)


def _execute_full_market_query(ths: Any, method_name: str, request_values: dict[str, Any]) -> ExecutionResult:
    config = MARKET_DATA_METHODS[method_name]
    code_field = config["code_field"]
    query_key = request_values.get("query_key", next(iter(config["query_config"].keys())))
    codes, loader_errors, load_meta, sdk_duration_ms = _load_market_data_codes(ths, method_name)
    request_view = dict(request_values)
    request_view.setdefault(code_field, "")
    request_view["load_mode"] = "all_market"

    if not codes:
        error_text = "未能加载该市场的证券代码列表"
        if loader_errors:
            error_text = f"{error_text}: {'; '.join(loader_errors)}"
        return (
            {
                "success": False,
                "error": error_text,
                "data": [],
                "extra": {"load_meta": load_meta, "market_errors": loader_errors},
            },
            request_view,
            {"sdk_duration_ms": sdk_duration_ms},
        )

    grouped_codes: dict[str, list[str]] = {}
    for code in codes:
        if len(code) < 5:
            continue
        grouped_codes.setdefault(code[:4], []).append(code)

    all_rows: list[dict[str, Any]] = []
    all_extra_rows: list[dict[str, Any]] = []
    market_errors = list(loader_errors)
    market_total = 0
    success_markets = 0

    for market, market_codes in grouped_codes.items():
        market_total += 1
        started_at = time.perf_counter()
        response = getattr(ths, method_name)(market_codes, query_key=query_key)
        sdk_duration_ms += (time.perf_counter() - started_at) * 1000
        raw = _response_to_dict(response)
        if not raw.get("success", False):
            market_errors.append(f"{market}: {raw.get('error', '查询失败')}")
            continue

        success_markets += 1
        all_rows.extend(_extract_rows(raw.get("data")))
        extra = raw.get("extra")
        if isinstance(extra, dict) and extra:
            all_extra_rows.append({"market": market, "code_count": len(market_codes), **extra})
        elif extra not in ({}, None, ""):
            all_extra_rows.append({"market": market, "code_count": len(market_codes), "value": extra})

    merged_extra = {
        "load_meta": load_meta,
        "group_count": len(grouped_codes),
        "market_total": market_total,
        "success_markets": success_markets,
    }
    if all_extra_rows:
        merged_extra["market_extra"] = all_extra_rows
    if market_errors:
        merged_extra["market_errors"] = market_errors

    success = success_markets > 0 and not market_errors
    error_text = "; ".join(market_errors)
    return (
        {
            "success": success,
            "error": error_text,
            "data": all_rows,
            "extra": merged_extra,
        },
        request_view,
        {"sdk_duration_ms": round(sdk_duration_ms, 2)},
    )


def _is_connection_error(message: str) -> bool:
    lowered = str(message).strip().lower()
    if not lowered:
        return False
    markers = (
        "未登录",
        "连接",
        "断开",
        "disconnect",
        "socket",
        "tcp",
        "broken pipe",
        "connection reset",
        "reset by peer",
    )
    return any(marker in lowered for marker in markers)


def _should_reconnect(raw_payload: dict[str, Any]) -> bool:
    if raw_payload.get("success", False):
        return False
    return _is_connection_error(str(raw_payload.get("error", "")))


def _execute_query_with_ths(
    ths: Any, spec: MethodSpec, method_name: str, normalized_request: dict[str, Any]
) -> ExecutionResult:
    request_view = dict(normalized_request)
    if method_name in MARKET_DATA_METHODS and MARKET_DATA_METHODS[method_name]["code_field"] not in normalized_request:
        return _execute_full_market_query(ths, method_name, normalized_request)
    started_at = time.perf_counter()
    raw_payload = _response_to_dict(spec.executor(ths, normalized_request))
    sdk_duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
    return raw_payload, request_view, {"sdk_duration_ms": sdk_duration_ms}


def build_schema_payload() -> dict[str, Any]:
    return {
        "title": "THSDK Query Surface",
        "methods": {name: spec.to_schema() for name, spec in METHOD_SPECS.items()},
        "method_groups": _method_groups(),
        "list_data_presets": LIST_DATA_PRESETS,
        "presets": PRESET_QUERIES,
        "market_data_presets": MARKET_DATA_PRESETS,
    }


def execute_web_query(
    payload: dict[str, Any],
    ths_factory: Callable[[], Any] = THS,
    ths_connection: THSSingletonConnection | None = None,
) -> dict[str, Any]:
    method_name = str(payload.get("method", "")).strip()
    if not method_name:
        raise ValueError("缺少 method 参数")

    spec = METHOD_SPECS.get(method_name)
    if spec is None:
        raise ValueError(f"暂不支持的接口: {method_name}")

    normalized_request = normalize_request_payload(method_name, payload)
    request_view = dict(normalized_request)
    started_at = time.perf_counter()
    ths = None
    timing: dict[str, float] = {}

    try:
        if ths_connection is not None:
            raw_payload, request_view, timing = ths_connection.execute(
                lambda connected_ths: _execute_query_with_ths(connected_ths, spec, method_name, normalized_request)
            )
        else:
            ths = ths_factory()
            connect_response = ths.connect()
            if not connect_response.success:
                raw_payload = connect_response.to_dict()
            else:
                raw_payload, request_view, timing = _execute_query_with_ths(ths, spec, method_name, normalized_request)
    except THSConnectionError as exc:
        raw_payload = exc.payload
    except Exception as exc:
        raw_payload = {
            "success": False,
            "error": str(exc),
            "data": None,
            "extra": {},
        }
    finally:
        duration_ms = round((time.perf_counter() - started_at) * 1000, 2)
        timing = dict(timing)
        timing["server_duration_ms"] = duration_ms
        if ths is not None and ths_connection is None:
            try:
                ths.disconnect()
            except Exception:
                pass

    result_block = _normalize_result_block(raw_payload.get("data"))
    extra_block = _normalize_result_block(raw_payload.get("extra"))
    return {
        "success": raw_payload.get("success", False),
        "error": raw_payload.get("error", ""),
        "method": method_name,
        "label": spec.label,
        "request": _serialize_value(request_view),
        "duration_ms": duration_ms,
        "timing": timing,
        "result": result_block,
        "extra": extra_block,
        "raw": raw_payload,
    }


INDEX_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>THSDK Query Surface</title>
  <style>
    :root {
      --bg: #f1ede3;
      --bg-deep: #e5dccd;
      --ink: #1f2a33;
      --muted: #6f766d;
      --line: rgba(31, 42, 51, 0.14);
      --line-strong: rgba(31, 42, 51, 0.28);
      --surface: rgba(255, 251, 243, 0.78);
      --surface-strong: rgba(255, 251, 243, 0.92);
      --accent: #8d5a34;
      --accent-soft: rgba(141, 90, 52, 0.12);
      --danger: #a43a2f;
      --shadow: 0 22px 60px rgba(36, 29, 20, 0.12);
      --mono: "SFMono-Regular", "Cascadia Code", "Fira Code", Consolas, monospace;
      --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      --sans: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      min-height: 100%;
    }

    body {
      font-family: var(--sans);
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(141, 90, 52, 0.18), transparent 33%),
        radial-gradient(circle at right 20%, rgba(89, 115, 132, 0.12), transparent 28%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-deep) 100%);
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      background-image:
        linear-gradient(rgba(31, 42, 51, 0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(31, 42, 51, 0.04) 1px, transparent 1px);
      background-size: 32px 32px;
      pointer-events: none;
      opacity: 0.45;
    }

    .app {
      position: relative;
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
    }

    .sidebar {
      position: relative;
      padding: 28px 24px 24px;
      border-right: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255, 250, 240, 0.86), rgba(244, 237, 227, 0.6));
      backdrop-filter: blur(18px);
      animation: lift 0.7s cubic-bezier(0.2, 1, 0.22, 1) both;
    }

    .workspace {
      padding: 28px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 20px;
      animation: lift 0.8s cubic-bezier(0.2, 1, 0.22, 1) 0.05s both;
    }

    .eyebrow {
      font: 600 11px/1.3 var(--mono);
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .brand {
      margin: 10px 0 12px;
      font: 600 clamp(34px, 6vw, 64px)/0.92 var(--serif);
      letter-spacing: -0.04em;
      max-width: 8ch;
    }

    .lead {
      margin: 0;
      max-width: 28ch;
      font-size: 14px;
      line-height: 1.7;
      color: var(--muted);
    }

    .sidebar-block {
      margin-top: 26px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }

    .sidebar-block h2,
    .result-headline,
    .data-block h3 {
      margin: 0 0 10px;
      font: 600 12px/1.4 var(--mono);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .method-select,
    .field-shell,
    .result-shell,
    .raw-shell {
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }

    .method-select,
    .result-shell,
    .raw-shell {
      overflow: hidden;
    }

    .method-select {
      padding: 16px 18px;
    }

    .field-grid {
      display: grid;
      gap: 12px;
      margin-top: 14px;
    }

    .field-shell {
      padding: 14px 16px;
      transition: transform 180ms ease, border-color 180ms ease, background-color 180ms ease;
    }

    .field-shell:focus-within,
    .field-shell:hover {
      transform: translateY(-2px);
      border-color: var(--line-strong);
      background: rgba(255, 251, 243, 0.92);
    }

    .field-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      font: 600 11px/1.4 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .required {
      color: var(--accent);
    }

    .field-shell input,
    .field-shell select,
    .field-shell textarea {
      width: 100%;
      border: 0;
      outline: none;
      resize: vertical;
      min-height: 22px;
      padding: 0;
      background: transparent;
      color: var(--ink);
      font: 500 14px/1.6 var(--mono);
    }

    .field-shell textarea {
      min-height: 88px;
    }

    .field-help,
    .method-copy,
    .meta-copy,
    .helper-copy {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }

    .method-copy {
      font-size: 13px;
      line-height: 1.7;
    }

    .example-line {
      margin-top: 10px;
      font: 500 12px/1.6 var(--mono);
      color: var(--accent);
      word-break: break-word;
    }

    .preset-list,
    .meta-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .preset-button,
    .submit-button,
    .ghost-button {
      border: 0;
      cursor: pointer;
      transition: transform 180ms ease, opacity 180ms ease, background-color 180ms ease;
    }

    .preset-button {
      padding: 9px 12px;
      background: rgba(255, 251, 243, 0.72);
      border: 1px solid var(--line);
      color: var(--ink);
      font: 600 12px/1 var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .preset-button.is-active {
      background: var(--ink);
      border-color: var(--ink);
      color: #fdf8ef;
    }

    .preset-button:hover,
    .submit-button:hover,
    .ghost-button:hover {
      transform: translateY(-2px);
    }

    .action-row {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }

    .submit-button {
      flex: 1;
      padding: 14px 18px;
      background: var(--ink);
      color: #fdf8ef;
      font: 600 12px/1 var(--mono);
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .submit-button[disabled] {
      opacity: 0.65;
      cursor: wait;
      transform: none;
    }

    .ghost-button {
      padding: 14px 16px;
      background: transparent;
      border: 1px solid var(--line);
      color: var(--ink);
      font: 600 12px/1 var(--mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .note-list {
      margin: 0;
      padding-left: 16px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.8;
    }

    .result-topline {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--line);
    }

    .result-title {
      margin: 6px 0 0;
      font: 600 clamp(28px, 5vw, 50px)/0.96 var(--serif);
      letter-spacing: -0.04em;
    }

    .result-subtitle {
      margin: 0;
      max-width: 34ch;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.7;
    }

    .meta-strip span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 11px;
      background: rgba(255, 251, 243, 0.72);
      border: 1px solid var(--line);
      font: 600 11px/1 var(--mono);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .meta-strip .meta-danger {
      color: var(--danger);
      border-color: rgba(164, 58, 47, 0.24);
      background: rgba(164, 58, 47, 0.08);
    }

    .result-shell,
    .raw-shell {
      background: linear-gradient(180deg, rgba(255, 251, 243, 0.9), rgba(247, 242, 233, 0.86));
    }

    .result-shell.loading::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(120deg, transparent 18%, rgba(141, 90, 52, 0.08) 50%, transparent 82%);
      animation: sweep 1.1s linear infinite;
      pointer-events: none;
    }

    .result-shell {
      position: relative;
      min-height: 340px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .result-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      background: var(--accent-soft);
      color: var(--accent);
      font: 600 11px/1 var(--mono);
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .status-badge.status-error {
      background: rgba(164, 58, 47, 0.08);
      color: var(--danger);
    }

    .result-body,
    .raw-body {
      overflow: auto;
      min-height: 0;
    }

    .empty-state,
    .error-state,
    .data-block {
      padding: 18px;
    }

    .empty-state {
      display: grid;
      align-content: center;
      min-height: 280px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.8;
    }

    .error-state {
      color: var(--danger);
      font: 500 14px/1.8 var(--mono);
      white-space: pre-wrap;
    }

    .data-block {
      border-top: 1px solid var(--line);
    }

    .data-block:first-child {
      border-top: 0;
    }

    .data-block-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }

    .data-block-head h3 {
      margin: 0;
    }

    .block-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .inline-button {
      padding: 8px 10px;
      border: 1px solid var(--line);
      background: rgba(255, 251, 243, 0.72);
      color: var(--ink);
      cursor: pointer;
      font: 600 11px/1 var(--mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .inline-button:hover {
      transform: translateY(-1px);
    }

    .block-note {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 12px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      background: rgba(255, 251, 243, 0.72);
    }

    .table-shell {
      overflow: auto;
      border: 1px solid var(--line);
      background: var(--surface-strong);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font: 500 12px/1.55 var(--mono);
    }

    th,
    td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      word-break: break-word;
      min-width: 96px;
    }

    thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: rgba(250, 245, 237, 0.98);
      color: var(--muted);
      font: 600 11px/1.4 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    tbody tr {
      animation: fadeRow 0.28s ease both;
    }

    tbody tr:hover td {
      background: rgba(141, 90, 52, 0.06);
    }

    .cell-action {
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      text-align: left;
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 0.18em;
    }

    .cell-action:hover {
      color: var(--ink);
    }

    pre {
      margin: 0;
      font: 500 12px/1.7 var(--mono);
      white-space: pre-wrap;
      word-break: break-word;
    }

    details summary {
      cursor: pointer;
      font: 600 11px/1 var(--mono);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }

    details[open] summary {
      margin-bottom: 12px;
    }

    @keyframes lift {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes sweep {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(100%);
      }
    }

    @keyframes fadeRow {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (max-width: 1040px) {
      .app {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .workspace {
        padding-top: 22px;
      }
    }

    @media (max-width: 640px) {
      .sidebar,
      .workspace {
        padding: 18px;
      }

      .result-topline {
        flex-direction: column;
        align-items: flex-start;
      }

      .action-row {
        flex-direction: column;
      }

      .ghost-button {
        width: 100%;
      }

      .block-note,
      .data-block-head {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
      <div class="eyebrow">THSDK / Local Web Console</div>
      <h1 class="brand">Query Surface</h1>
      <p class="lead">把常用 THSDK 接口包成一个本地单页面。选接口、填参数、直接把响应标准化成表格，便于联调和验证数据结构。</p>

      <section class="sidebar-block">
        <h2>快捷预设</h2>
        <p class="helper-copy">每个接口都带一组可直接执行的默认参数，适合第一次打开就先看返回结构。列表结果里的代码列也可以直接点进详情行情。</p>
        <div class="preset-list" id="preset-list"></div>
      </section>

      <section class="sidebar-block method-select">
        <div class="field-label">
          <span>接口</span>
          <span class="required">必选</span>
        </div>
        <select id="method-select" aria-label="接口选择"></select>
        <p class="method-copy" id="method-description"></p>
        <div class="example-line" id="method-example"></div>
        <form id="query-form" novalidate>
          <div class="field-grid" id="dynamic-fields"></div>
          <div class="action-row">
            <button type="submit" class="submit-button" id="submit-button">执行查询</button>
            <button type="button" class="ghost-button" id="reset-button">重置</button>
          </div>
        </form>
      </section>

      <section class="sidebar-block">
        <h2>使用说明</h2>
        <ul class="note-list">
          <li>后端会复用同一个 THS 连接，并在掉线后自动重连一次。</li>
          <li>优先读取 <code>THS_USERNAME</code> / <code>THS_PASSWORD</code> / <code>THS_MAC</code> 环境变量。</li>
          <li>市场类批量查询要求同一请求中的代码属于同一市场。</li>
        </ul>
      </section>
    </aside>

    <section class="workspace">
      <header class="result-topline">
        <div>
          <div class="eyebrow">Result Workspace</div>
          <h2 class="result-title">表格化查看 SDK 返回</h2>
          <p class="result-subtitle">主数据区保持紧凑、低干扰，适合直接观察列结构、行数和错误信息。</p>
        </div>
        <div class="meta-strip" id="meta-strip">
          <span>等待查询</span>
          <span>Rows 0</span>
        </div>
      </header>

      <section class="result-shell" id="result-shell">
        <div class="result-toolbar">
          <div>
            <div class="result-headline">查询结果</div>
            <p class="meta-copy" id="result-summary">结果区域会根据返回类型自动切换为表格或文本。</p>
          </div>
          <div class="status-badge" id="status-badge">Idle</div>
        </div>
        <div class="result-body" id="result-body">
          <div class="empty-state">选一个接口并提交参数，结果会在这里展开。列表和字典会转换成可滚动表格，纯文本会保留原样显示。</div>
        </div>
      </section>

      <section class="raw-shell">
        <div class="result-toolbar">
          <div>
            <div class="result-headline">原始 JSON</div>
            <p class="meta-copy">默认折叠，展开时才生成格式化 JSON，避免大结果阻塞页面。</p>
          </div>
        </div>
        <div class="raw-body" id="raw-body"></div>
      </section>
    </section>
  </main>

  <script>
    const APP_SCHEMA = __APP_SCHEMA__;

    const methodSelect = document.getElementById("method-select");
    const methodDescription = document.getElementById("method-description");
    const methodExample = document.getElementById("method-example");
    const dynamicFields = document.getElementById("dynamic-fields");
    const queryForm = document.getElementById("query-form");
    const submitButton = document.getElementById("submit-button");
    const resetButton = document.getElementById("reset-button");
    const resultShell = document.getElementById("result-shell");
    const resultBody = document.getElementById("result-body");
    const resultSummary = document.getElementById("result-summary");
    const statusBadge = document.getElementById("status-badge");
    const rawBody = document.getElementById("raw-body");
    const presetList = document.getElementById("preset-list");
    const metaStrip = document.getElementById("meta-strip");
    const presetButtons = new Map();
    const presetByMethod = new Map(APP_SCHEMA.presets.map((preset) => [preset.method, preset]));
    const DEFAULT_VISIBLE_ROWS = 20;
    const SOURCE_TO_DETAIL_METHOD = {
      stock_cn_lists: "market_data_cn",
      stock_us_lists: "market_data_us",
      stock_hk_lists: "market_data_hk",
      stock_bj_lists: "market_data_cn",
      stock_uk_lists: "market_data_uk",
      stock_b_lists: "market_data_cn",
      bond_lists: "market_data_bond",
      futures_lists: "market_data_future",
      fund_etf_lists: "market_data_fund",
      fund_etf_t0_lists: "market_data_fund",
      forex_list: "market_data_forex",
      index_list: "market_data_index",
      ths_industry: "market_data_block",
      ths_concept: "market_data_block",
      nasdaq_lists: "market_data_us",
    };
    let currentPayload = null;
    let currentViewState = createDefaultViewState();

    function createDefaultViewState() {
      return {
        expandedBlocks: new Set(),
        expandedSections: new Set(),
        rawExpanded: false,
      };
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function preferredCodeColumn(block) {
      if (!block || !Array.isArray(block.columns)) {
        return "";
      }
      const preferred = ["THSCODE", "代码", "Code", "code"];
      for (const column of preferred) {
        if (block.columns.includes(column)) {
          return column;
        }
      }
      return "";
    }

    function rowCodeValue(row) {
      if (!row || typeof row !== "object") {
        return "";
      }
      const columns = ["THSCODE", "代码", "Code", "code", "link_code", "block_code"];
      for (const column of columns) {
        if (row[column] !== null && row[column] !== undefined && String(row[column]).trim()) {
          return String(row[column]).trim().toUpperCase();
        }
      }
      return "";
    }

    function inferDetailMethodFromCode(code, sourceMethod) {
      const normalizedCode = String(code || "").trim().toUpperCase();
      if (!normalizedCode) {
        return "";
      }

      if (SOURCE_TO_DETAIL_METHOD[sourceMethod]) {
        return SOURCE_TO_DETAIL_METHOD[sourceMethod];
      }

      if (normalizedCode.startsWith("URFI")) {
        return "market_data_block";
      }
      if (normalizedCode.startsWith("UFXB")) {
        return "market_data_forex";
      }
      if (normalizedCode.startsWith("UEUA")) {
        return "market_data_uk";
      }
      if (normalizedCode.startsWith("UNQQ") || normalizedCode.startsWith("UNQS")) {
        return "market_data_us";
      }
      if (normalizedCode.startsWith("UHKM") || normalizedCode.startsWith("UHKG")) {
        return "market_data_hk";
      }
      if (normalizedCode.startsWith("USHI") || normalizedCode.startsWith("USZI")) {
        return "market_data_index";
      }
      if (normalizedCode.startsWith("USHD") || normalizedCode.startsWith("USZD")) {
        return "market_data_bond";
      }
      if (normalizedCode.startsWith("USHJ") || normalizedCode.startsWith("USZJ")) {
        return "market_data_fund";
      }
      if (
        normalizedCode.startsWith("UGFF") ||
        normalizedCode.startsWith("UCFD") ||
        normalizedCode.startsWith("UCFS") ||
        normalizedCode.startsWith("UCFZ")
      ) {
        return "market_data_future";
      }
      if (
        normalizedCode.startsWith("USHA") ||
        normalizedCode.startsWith("USZA") ||
        normalizedCode.startsWith("USTM") ||
        normalizedCode.startsWith("USHB") ||
        normalizedCode.startsWith("USZB") ||
        normalizedCode.startsWith("USHT") ||
        normalizedCode.startsWith("USHP") ||
        normalizedCode.startsWith("USZP")
      ) {
        return "market_data_cn";
      }
      return "";
    }

    function createInput(field, value) {
      const wrapper = document.createElement("label");
      wrapper.className = "field-shell";

      const label = document.createElement("div");
      label.className = "field-label";
      label.innerHTML = "<span>" + escapeHtml(field.label) + "</span>" + (field.required ? '<span class="required">必填</span>' : "");
      wrapper.appendChild(label);

      let input;
      if (field.kind === "select") {
        input = document.createElement("select");
        field.options.forEach((option) => {
          const element = document.createElement("option");
          element.value = option.value;
          element.textContent = option.label;
          if (String(value) === String(option.value)) {
            element.selected = true;
          }
          input.appendChild(element);
        });
      } else if (field.kind === "textarea") {
        input = document.createElement("textarea");
        input.value = value || "";
      } else {
        input = document.createElement("input");
        input.type = field.kind === "int" ? "number" : "text";
        input.value = value || "";
        if (field.kind === "int") {
          input.step = "1";
        }
      }

      input.name = field.name;
      input.placeholder = field.placeholder || "";
      input.autocomplete = "off";
      wrapper.appendChild(input);

      if (field.help_text) {
        const help = document.createElement("p");
        help.className = "field-help";
        help.textContent = field.help_text;
        wrapper.appendChild(help);
      }

      return wrapper;
    }

    function renderMethodOptions() {
      const groups = Array.isArray(APP_SCHEMA.method_groups) ? APP_SCHEMA.method_groups : [];
      if (groups.length > 0) {
        groups.forEach((group) => {
          const optgroup = document.createElement("optgroup");
          optgroup.label = group.label;
          group.methods.forEach((name) => {
            const method = APP_SCHEMA.methods[name];
            if (!method) {
              return;
            }
            const option = document.createElement("option");
            option.value = name;
            option.textContent = method.label;
            optgroup.appendChild(option);
          });
          if (optgroup.children.length > 0) {
            methodSelect.appendChild(optgroup);
          }
        });
        return;
      }

      Object.entries(APP_SCHEMA.methods).forEach(([name, method]) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = method.label;
        methodSelect.appendChild(option);
      });
    }

    function renderPresets() {
      APP_SCHEMA.presets.forEach((preset) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "preset-button";
        button.textContent = preset.label;
        button.title = preset.method;
        button.addEventListener("click", () => applyPreset(preset));
        presetList.appendChild(button);
        presetButtons.set(preset.method, button);
      });
    }

    function syncPresetState() {
      presetButtons.forEach((button, method) => {
        button.classList.toggle("is-active", method === methodSelect.value);
      });
    }

    function applyMethodValues(method, values = {}) {
      methodSelect.value = method;
      renderFields(values);
      syncPresetState();
      const inputs = queryForm.querySelectorAll("[name]");
      inputs.forEach((input) => {
        if (Object.prototype.hasOwnProperty.call(values, input.name)) {
          input.value = values[input.name];
        }
      });
    }

    function applyPreset(preset) {
      applyMethodValues(preset.method, preset.values);
    }

    function currentMethodSchema() {
      return APP_SCHEMA.methods[methodSelect.value];
    }

    function renderFields(initialValues = {}) {
      const method = currentMethodSchema();
      methodDescription.textContent = method.description;
      methodExample.textContent = method.example || "";
      dynamicFields.innerHTML = "";
      method.fields.forEach((field) => {
        const value = Object.prototype.hasOwnProperty.call(initialValues, field.name)
          ? initialValues[field.name]
          : field.default;
        dynamicFields.appendChild(createInput(field, value));
      });
    }

    function readFormPayload() {
      const data = { method: methodSelect.value };
      const formData = new FormData(queryForm);
      formData.forEach((value, key) => {
        data[key] = value;
      });
      return data;
    }

    function roundMs(value) {
      if (!Number.isFinite(value)) {
        return 0;
      }
      return Math.round(value * 100) / 100;
    }

    function renderMeta(payload) {
      const rowCount = payload.result && typeof payload.result.row_count === "number" ? payload.result.row_count : 0;
      const timing = payload.timing || {};
      const clientTiming = payload.client_timing || {};
      const chips = [
        payload.label || payload.method,
        "Rows " + rowCount,
      ];
      if (typeof timing.sdk_duration_ms === "number") {
        chips.push("SDK " + timing.sdk_duration_ms + " ms");
      }
      if (typeof timing.server_duration_ms === "number") {
        chips.push("Server " + timing.server_duration_ms + " ms");
      } else if (typeof payload.duration_ms === "number") {
        chips.push(payload.duration_ms + " ms");
      }
      if (typeof timing.lock_wait_ms === "number" && timing.lock_wait_ms >= 1) {
        chips.push("Queue " + timing.lock_wait_ms + " ms");
      }
      if (typeof clientTiming.fetch_duration_ms === "number") {
        chips.push("Fetch " + clientTiming.fetch_duration_ms + " ms");
      }
      if (typeof clientTiming.render_duration_ms === "number") {
        chips.push("Render " + clientTiming.render_duration_ms + " ms");
      }
      if (!payload.success) {
        chips.push("Error");
      }
      metaStrip.innerHTML = chips.map((chip) => "<span>" + escapeHtml(chip) + "</span>").join("");
    }

    function buildDetailPayload(payload, row) {
      const code = rowCodeValue(row);
      if (!code) {
        return null;
      }

      const method = inferDetailMethodFromCode(code, payload.method);
      if (!method) {
        return null;
      }

      const preset = presetByMethod.get(method);
      if (!preset) {
        return null;
      }

      const values = { ...preset.values };
      if (method === "market_data_block") {
        values.block_code = code;
      } else {
        values.ths_code = code;
      }

      return { method, values };
    }

    function renderSectionButton(action, target, label) {
      return (
        '<button type="button" class="inline-button" data-action="' +
        escapeHtml(action) +
        '" data-target="' +
        escapeHtml(target) +
        '">' +
        escapeHtml(label) +
        "</button>"
      );
    }

    function renderTable(block, sourcePayload = null, options = {}) {
      if (!block.columns || block.columns.length === 0) {
        return '<div class="helper-copy">接口返回为空，没有可展示的列。</div>';
      }

      const blockKey = options.blockKey || "result";
      const expanded = Boolean(options.expanded);
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const totalRows = typeof block.row_count === "number" ? block.row_count : rows.length;
      const visibleRows = expanded ? rows : rows.slice(0, DEFAULT_VISIBLE_ROWS);
      const codeColumn = sourcePayload ? preferredCodeColumn(block) : "";
      const head = block.columns.map((column) => "<th>" + escapeHtml(column) + "</th>").join("");
      const body = visibleRows.map((row, rowIndex) => {
        const detailPayload = sourcePayload ? buildDetailPayload(sourcePayload, row) : null;
        const cells = block.columns.map((column) => {
          const cellValue = row[column];
          const text = cellValue === null || cellValue === undefined ? "" : String(cellValue);
          if (detailPayload && column === codeColumn) {
            return (
              '<td><button type="button" class="cell-action" data-row-index="' +
              rowIndex +
              '" title="点击查询详情行情">' +
              escapeHtml(text) +
              "</button></td>"
            );
          }
          return "<td>" + escapeHtml(text) + "</td>";
        }).join("");
        return "<tr>" + cells + "</tr>";
      }).join("");

      let note = "";
      if (totalRows > DEFAULT_VISIBLE_ROWS) {
        const button = expanded
          ? renderSectionButton("collapse-block", blockKey, "仅看前 20 行")
          : renderSectionButton("expand-block", blockKey, "显示全部");
        note =
          '<div class="block-note"><p class="helper-copy">当前仅渲染 ' +
          escapeHtml(String(visibleRows.length)) +
          " / " +
          escapeHtml(String(totalRows)) +
          ' 行，减少大表格阻塞。</p><div class="block-actions">' +
          button +
          "</div></div>";
      }

      return note + '<div class="table-shell"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }

    function renderBlock(title, block, sourcePayload = null, options = {}) {
      if (!block || block.kind === "empty") {
        return "";
      }

      const sectionKey = options.sectionKey || "result";
      const sectionExpanded = options.collapsible ? currentViewState.expandedSections.has(sectionKey) : true;
      const actions = [];
      if (options.collapsible) {
        actions.push(
          sectionExpanded
            ? renderSectionButton("collapse-section", sectionKey, "收起")
            : renderSectionButton("expand-section", sectionKey, "展开")
        );
      }

      let blockContent = '<p class="helper-copy">当前已折叠，展开后再渲染内容。</p>';
      if (sectionExpanded) {
        if (block.kind === "text") {
          blockContent = "<pre>" + escapeHtml(block.text || "") + "</pre>";
        } else {
          blockContent = renderTable(block, sourcePayload, {
            blockKey: sectionKey,
            expanded: currentViewState.expandedBlocks.has(sectionKey),
          });
        }
      }

      return (
        '<section class="data-block"><div class="data-block-head"><h3>' +
        escapeHtml(title) +
        '</h3><div class="block-actions">' +
        actions.join("") +
        "</div></div>" +
        blockContent +
        "</section>"
      );
    }

    function renderRawPanel(payload) {
      if (!currentViewState.rawExpanded) {
        rawBody.innerHTML =
          '<div class="data-block"><div class="data-block-head"><h3>原始 JSON</h3><div class="block-actions">' +
          renderSectionButton("expand-raw", "raw", "展开") +
          '</div></div><p class="helper-copy">默认不格式化大 JSON，点击展开后再生成内容。</p></div>';
        return;
      }

      rawBody.innerHTML =
        '<div class="data-block"><div class="data-block-head"><h3>原始 JSON</h3><div class="block-actions">' +
        renderSectionButton("collapse-raw", "raw", "收起") +
        "</div></div><pre>" +
        escapeHtml(JSON.stringify(payload.raw, null, 2)) +
        "</pre></div>";
    }

    function renderResult(payload, clientTiming = null, preserveViewState = false) {
      const renderStartedAt = performance.now();
      if (!preserveViewState) {
        currentViewState = createDefaultViewState();
      }
      currentPayload = payload;
      payload.client_timing = clientTiming || payload.client_timing || {};
      statusBadge.textContent = payload.success ? "Success" : "Error";
      statusBadge.className = payload.success ? "status-badge" : "status-badge status-error";
      resultSummary.textContent = payload.error
        ? payload.error
        : "请求参数: " + JSON.stringify(payload.request, null, 0);

      if (!payload.success && payload.error) {
        resultBody.innerHTML =
          '<div class="error-state">' +
          escapeHtml(payload.error) +
          "</div>" +
          renderBlock("返回数据", payload.result, payload, { sectionKey: "result" }) +
          renderBlock("扩展字段", payload.extra, null, { sectionKey: "extra", collapsible: true });
      } else {
        const body =
          renderBlock("返回数据", payload.result, payload, { sectionKey: "result" }) +
          renderBlock("扩展字段", payload.extra, null, { sectionKey: "extra", collapsible: true });
        resultBody.innerHTML = body || '<div class="empty-state">请求成功，但当前接口没有返回可展示的数据。</div>';
      }

      renderRawPanel(payload);
      payload.client_timing.render_duration_ms = roundMs(performance.now() - renderStartedAt);
      renderMeta(payload);
    }

    function rerenderCurrentPayload() {
      if (!currentPayload) {
        return;
      }
      renderResult(currentPayload, currentPayload.client_timing || {}, true);
    }

    function toggleBlockExpansion(blockKey, expanded) {
      if (expanded) {
        currentViewState.expandedBlocks.add(blockKey);
      } else {
        currentViewState.expandedBlocks.delete(blockKey);
      }
      rerenderCurrentPayload();
    }

    function toggleSection(sectionKey, expanded) {
      if (expanded) {
        currentViewState.expandedSections.add(sectionKey);
      } else {
        currentViewState.expandedSections.delete(sectionKey);
      }
      rerenderCurrentPayload();
    }

    function toggleRaw(expanded) {
      currentViewState.rawExpanded = expanded;
      rerenderCurrentPayload();
    }

    function handleResultAction(action, target) {
      if (action === "expand-block") {
        toggleBlockExpansion(target, true);
        return true;
      }
      if (action === "collapse-block") {
        toggleBlockExpansion(target, false);
        return true;
      }
      if (action === "expand-section") {
        toggleSection(target, true);
        return true;
      }
      if (action === "collapse-section") {
        toggleSection(target, false);
        return true;
      }
      return false;
    }

    function handleRawAction(action) {
      if (action === "expand-raw") {
        toggleRaw(true);
        return true;
      }
      if (action === "collapse-raw") {
        toggleRaw(false);
        return true;
      }
      return false;
    }

    async function submitQuery(forcedPayload = null) {
      const payload = forcedPayload || readFormPayload();
      submitButton.disabled = true;
      resultShell.classList.add("loading");
      statusBadge.textContent = "Running";
      statusBadge.className = "status-badge";
      resultSummary.textContent = "正在执行查询...";

      try {
        const requestStartedAt = performance.now();
        const response = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const responseReceivedAt = performance.now();
        const result = await response.json();
        const payloadReadyAt = performance.now();
        renderResult(result, {
          fetch_duration_ms: roundMs(payloadReadyAt - requestStartedAt),
          response_wait_ms: roundMs(responseReceivedAt - requestStartedAt),
          json_parse_duration_ms: roundMs(payloadReadyAt - responseReceivedAt),
        });
      } catch (error) {
        renderResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          method: payload.method,
          label: currentMethodSchema().label,
          request: payload,
          duration_ms: 0,
          timing: { server_duration_ms: 0 },
          result: { kind: "empty", columns: [], rows: [], row_count: 0 },
          extra: { kind: "empty", columns: [], rows: [], row_count: 0 },
          raw: {},
        });
      } finally {
        resultShell.classList.remove("loading");
        submitButton.disabled = false;
      }
    }

    methodSelect.addEventListener("change", () => {
      renderFields();
      syncPresetState();
    });
    queryForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitQuery();
    });
    resetButton.addEventListener("click", () => renderFields());
    resultBody.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const handled = handleResultAction(actionButton.dataset.action || "", actionButton.dataset.target || "");
        if (handled) {
          return;
        }
      }

      const action = event.target.closest(".cell-action");
      if (!action || !currentPayload || !currentPayload.result || !Array.isArray(currentPayload.result.rows)) {
        return;
      }

      const rowIndex = Number(action.dataset.rowIndex);
      const row = currentPayload.result.rows[rowIndex];
      const detailPayload = buildDetailPayload(currentPayload, row);
      if (!detailPayload) {
        return;
      }

      applyMethodValues(detailPayload.method, detailPayload.values);
      submitQuery({ method: detailPayload.method, ...detailPayload.values });
    });
    rawBody.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) {
        return;
      }
      handleRawAction(actionButton.dataset.action || "");
    });

    renderMethodOptions();
    renderPresets();
    methodSelect.value = "search_symbols";
    renderFields(APP_SCHEMA.presets[0] ? APP_SCHEMA.presets[0].values : {});
    syncPresetState();
    renderRawPanel({ raw: {} });
  </script>
</body>
</html>
"""


def render_index_page() -> bytes:
    schema_json = json.dumps(build_schema_payload(), ensure_ascii=False)
    return INDEX_HTML.replace("__APP_SCHEMA__", schema_json).encode("utf-8")


class THSWebQueryServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], ths_factory: Callable[[], Any] = THS):
        super().__init__(server_address, THSWebHandler)
        self.ths_factory = ths_factory
        self.ths_connection = THSSingletonConnection(ths_factory)

    def server_close(self) -> None:
        self.ths_connection.close()
        super().server_close()


class THSWebHandler(BaseHTTPRequestHandler):
    server_version = "THSDKWeb/1.0"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/index.html"}:
            self._send_bytes(render_index_page(), content_type="text/html; charset=utf-8")
            return
        if path == "/api/schema":
            self._send_json(build_schema_payload())
            return
        self._send_json({"success": False, "error": "Not Found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/api/query":
            self._send_json({"success": False, "error": "Not Found"}, status=HTTPStatus.NOT_FOUND)
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        raw_body = self.rfile.read(content_length).decode("utf-8") if content_length else "{}"

        try:
            payload = json.loads(raw_body or "{}")
        except json.JSONDecodeError as exc:
            self._send_json(
                {"success": False, "error": f"请求体不是有效 JSON: {exc}"},
                status=HTTPStatus.BAD_REQUEST,
            )
            return

        try:
            result = execute_web_query(
                payload,
                ths_factory=self.server.ths_factory,
                ths_connection=self.server.ths_connection,
            )
        except ValueError as exc:
            self._send_json(
                {
                    "success": False,
                    "error": str(exc),
                    "method": str(payload.get("method", "")).strip(),
                    "result": {"kind": "empty", "columns": [], "rows": [], "row_count": 0},
                    "extra": {"kind": "empty", "columns": [], "rows": [], "row_count": 0},
                    "raw": {},
                },
                status=HTTPStatus.BAD_REQUEST,
            )
            return

        self._log_query_result(result)
        self._send_json(result)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _log_query_result(self, payload: dict[str, Any]) -> None:
        timing = payload.get("timing", {})
        row_count = payload.get("result", {}).get("row_count", 0)
        parts = [
            f"time={datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"method={payload.get('method', '')}",
            f"success={payload.get('success', False)}",
            f"rows={row_count}",
            f"sdk_ms={timing.get('sdk_duration_ms', 0)}",
            f"server_ms={timing.get('server_duration_ms', payload.get('duration_ms', 0))}",
        ]
        lock_wait_ms = timing.get("lock_wait_ms")
        if lock_wait_ms is not None:
            parts.append(f"queue_ms={lock_wait_ms}")
        error = str(payload.get("error", "")).strip()
        if error:
            parts.append(f"error={error}")
        print("[THSDK web] " + " ".join(parts), flush=True)

    def _send_bytes(self, body: bytes, *, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, content_type="application/json; charset=utf-8", status=status)


def run_server(host: str = "127.0.0.1", port: int = 8765, ths_factory: Callable[[], Any] = THS) -> int:
    server = THSWebQueryServer((host, port), ths_factory=ths_factory)
    print(f"THSDK web 查询页已启动: http://{host}:{port}")
    print("按 Ctrl+C 停止服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动 THSDK 本地单页面查询工具")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return run_server(host=args.host, port=args.port)


if __name__ == "__main__":
    raise SystemExit(main())
