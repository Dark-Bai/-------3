# encoding: utf-8
from datetime import datetime
from typing import Optional, Union

from .base import tz
from .response import Response
from .validators import CN_STOCK_MARKETS


class DomesticAPIMixin:
    def intraday_data(self, ths_code: str) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes

        response = self.call(method="intraday_data", params={"code": normalized_codes[0], "date": "0"})
        return self._transform_time_field(response, lambda value: self._int2time(int(value)))

    def tick_level1(self, ths_code: str) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        return self.call(method="tick.level1", params={"code": normalized_codes[0]})

    def tick_super_level1(
        self, ths_code: str, date: Optional[str] = None, buffer_size: int = 1024 * 1024 * 2
    ) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        if date:
            try:
                datetime.strptime(date, "%Y%m%d")
            except ValueError:
                return self._error_response("日期格式无效，必须为 'YYYYMMDD'")

        return self.call(
            method="tick.super_level1",
            params={"code": normalized_codes[0], "date": date},
            buffer_size=buffer_size,
        )

    def min_snapshot(self, ths_code: str, date: Optional[str] = None, buffer_size: int = 1024 * 1024 * 2) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        if date:
            try:
                datetime.strptime(date, "%Y%m%d")
            except ValueError:
                return self._error_response("日期格式无效，必须为 'YYYYMMDD'")

        response = self.call(
            method="min_snapshot",
            params={"code": normalized_codes[0], "date": date},
            buffer_size=buffer_size,
        )
        if response.error == "":
            filtered_data = []
            for entry in response.data:
                if "成交量" in entry and entry["成交量"] == 4294967295:
                    continue
                if "时间" in entry:
                    entry["时间"] = int(self._int2time(int(entry["时间"])).timestamp())
                filtered_data.append(entry)
            response.data = filtered_data
        return response

    def depth(self, ths_code: Union[str, list]) -> Response:
        params = {"codes" if isinstance(ths_code, list) else "code": ths_code}
        return self.call(method="depth", params=params)

    def call_auction(self, ths_code: str) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        return self.call(method="call_auction", params={"code": normalized_codes[0]})

    def big_order_flow(self, ths_code: str) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为A股市场代码 + 6位数字代码",
            valid_markets=CN_STOCK_MARKETS,
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        return self.call(method="big_order_flow", params={"code": normalized_codes[0]})

    def corporate_action(self, ths_code: str) -> Response:
        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        return self.call(method="corporate_action", params={"code": normalized_codes[0]})

    def klines(
        self,
        ths_code: str,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        adjust: str = "",
        interval: str = "day",
        count: int = -1,
    ) -> Response:
        if count != -1 and (start_time is not None or end_time is not None):
            raise ValueError("'count' 参数不能与 'start_time' 或 'end_time' 同时使用。")
        if count == -1 and start_time is None and end_time is None:
            raise ValueError("必须提供 'count' 或同时提供 'start_time' 和 'end_time'。")
        if (start_time is not None and end_time is None) or (start_time is None and end_time is not None):
            raise ValueError("'start_time' 和 'end_time' 必须同时提供或都不提供。")

        normalized_codes = self._normalize_fixed_length_codes(
            ths_code,
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须为4位市场代码 + 6位数字代码",
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes
        if adjust not in ["forward", "backward", ""]:
            return self._error_response(f"无效的复权类型: {adjust}")
        if interval not in ["1m", "5m", "15m", "30m", "60m", "120m", "day", "week", "month", "quarter", "year"]:
            return self._error_response(f"无效的周期类型: {interval}")

        params = {"code": normalized_codes[0], "adjust": adjust, "interval": interval}
        if count > 0:
            params["count"] = count
        else:
            if start_time is not None:
                if start_time.tzinfo is None:
                    start_time = start_time.replace(tzinfo=tz)
                params["start_time"] = start_time.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")
            if end_time is not None:
                if end_time.tzinfo is None:
                    end_time = end_time.replace(tzinfo=tz)
                params["end_time"] = end_time.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")

        response = self.call(method="klines", params=params)
        if interval in ["1m", "5m", "15m", "30m", "60m", "120m"]:
            return self._transform_time_field(response, lambda value: self._int2time(int(value)))
        return self._transform_time_field(response, lambda value: datetime.strptime(str(value), "%Y%m%d"))
