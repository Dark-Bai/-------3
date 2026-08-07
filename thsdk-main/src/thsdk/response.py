# encoding: utf-8
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from ._constants import FieldNameMap

__all__ = ["Payload", "Response"]


@dataclass
class Payload:
    """API 响应数据类，用于存储和处理返回的数据。"""

    result: Optional[Union[Dict[str, Any], List[Any], str]] = None
    dict_extra: Optional[Dict[str, Any]] = field(default_factory=dict)

    def __repr__(self) -> str:
        if isinstance(self.result, list):
            data_preview = self.result[:2] if len(self.result) > 2 else self.result
            result_str = f"{data_preview!r}... ({len(self.result)} items)"
        else:
            result_str = f"{self.result!r}"
        return f"Payload(result={result_str}, dict_extra={self.dict_extra!r})"


@dataclass
class Response:
    success: bool = field(init=False)
    error: str = field(default="", init=False)
    data: Optional[Union[Dict[str, Any], List[Dict], str]] = field(default=None, init=False)
    extra: Dict[str, Any] = field(default_factory=dict, init=False)
    _raw_json: str = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        data_dict: Dict[str, Any] = {}
        try:
            try:
                import orjson

                data_dict = orjson.loads(self._raw_json.encode("utf-8"))
            except ImportError:
                import json

                data_dict = json.loads(self._raw_json)
        except Exception as e:
            self.success = False
            self.error = f"无效的 JSON: {e}"
            return

        err_info = data_dict.get("err_info", "")
        payload_data = data_dict.get("payload", {})
        if not isinstance(payload_data, dict):
            payload_data = {}

        result = payload_data.get("result")
        dict_extra = payload_data.get("dict_extra", {})

        if isinstance(result, list):
            result = self._convert_list(result) if result else []
            for entry in result:
                if isinstance(entry, dict) and "MarketDisplay" in entry and "Code" in entry:
                    entry["THSCODE"] = f"{entry.get('MarketDisplay', '')}{entry.get('Code', '')}"
        elif isinstance(result, dict):
            result = self._convert_item(result)
            if "MarketDisplay" in result and "Code" in result:
                result["THSCODE"] = f"{result.get('MarketDisplay', '')}{result.get('Code', '')}"

        if isinstance(dict_extra, dict):
            dict_extra = self._convert_dict(dict_extra)
        else:
            dict_extra = {}

        self.success = not bool(err_info)
        self.error = err_info
        self.data = result
        self.extra = dict_extra

    @staticmethod
    def _convert_list(data: List[Dict]) -> List[Dict]:
        return [Response._convert_item(item) for item in data]

    @staticmethod
    def _convert_dict(data: Dict) -> Dict:
        return {Response._convert_key(k): v for k, v in data.items()}

    @staticmethod
    def _convert_item(item: Dict) -> Dict:
        converted = {}
        for k, v in item.items():
            key = int(k) if k.isdigit() else k
            converted[FieldNameMap.get(key, k)] = v
        return converted

    @staticmethod
    def _convert_key(key: Any) -> Any:
        key_int = int(key) if str(key).isdigit() else key
        return FieldNameMap.get(key_int, key)

    def __bool__(self) -> bool:
        return self.success

    def __repr__(self) -> str:
        if isinstance(self.data, list):
            data_str = f"[{self.data[0]!r}, ...] ({len(self.data)} items)" if len(self.data) > 1 else f"{self.data!r}"
        else:
            data_str = f"{self.data!r}"
        return f"Response(success={self.success}, error={self.error!r}, data={data_str}, extra={self.extra!r})"

    @property
    def df(self):
        try:
            import pandas as pd
        except ImportError as e:
            raise ImportError("使用 .df 需要安装 pandas") from e

        if self.data is None:
            return pd.DataFrame()
        if isinstance(self.data, list):
            return pd.DataFrame(self.data)
        if isinstance(self.data, dict):
            return pd.DataFrame([self.data])
        raise TypeError(f"无法将 {type(self.data)} 转为 DataFrame")

    def to_dict(self) -> Dict[str, Any]:
        def _serialize(obj):
            if isinstance(obj, datetime):
                return obj.isoformat()
            if isinstance(obj, dict):
                return {k: _serialize(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [_serialize(item) for item in obj]
            return obj

        return {
            "success": self.success,
            "error": self.error,
            "data": _serialize(self.data),
            "extra": _serialize(self.extra),
        }

    @classmethod
    def from_json(cls, json_str: str) -> "Response":
        return cls(_raw_json=json_str)
