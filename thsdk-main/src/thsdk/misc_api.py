# encoding: utf-8
from typing import Any, Union

from .response import Response
from ._constants import CALL_AUCTION_ANOMALY_MAP
from .validators import VALID_MARKETS


class MiscAPIMixin:
    def call_auction_anomaly(self, market: str = "USHA") -> Response:
        market = market.upper()
        if len(market) != 4 or market not in VALID_MARKETS:
            return self._error_response("市场代码必须为4个字符，并且属于有效市场代码")

        response = self.call(method="call_auction_anomaly", params={"market": market})
        if response.data and isinstance(response.data, list):
            ydkey = "异动类型1"
            for entry in response.data:
                if isinstance(entry, dict) and ydkey in entry:
                    entry[ydkey] = CALL_AUCTION_ANOMALY_MAP.get(entry[ydkey], entry[ydkey])
        return response

    def wencai_base(self, condition: str) -> Response:
        return self.call("wencai_base", condition)

    def wencai_nlp(self, condition: str) -> Response:
        return self.call("wencai_nlp", condition, buffer_size=1024 * 1024 * 8)

    def order_book_ask(self, ths_code: str) -> Response:
        return self.call("order_book_ask", ths_code, buffer_size=1024 * 1024 * 8)

    def order_book_bid(self, ths_code: str) -> Response:
        return self.call("order_book_bid", ths_code, buffer_size=1024 * 1024 * 8)

    def query_securities(self, pattern: str, needmarket: str = "") -> Response:
        return self.search_symbols(pattern, needmarket)

    def search_symbols(self, pattern: str, needmarket: str = "") -> Response:
        response = self.call(method="query_securities", params={"pattern": pattern, "needmarket": needmarket})
        if isinstance(response.data, list):
            for entry in response.data:
                if isinstance(entry, dict) and "MarketStr" in entry and "Code" in entry:
                    entry["THSCODE"] = f"{entry.get('MarketStr', '')}{entry.get('Code', '')}"
        return response

    def news(self, text_id: int = 0x3814, code: str = "1A0001", market: str = "USHI") -> Response:
        return self.call(method="info_list_by_text_id", params={"textid": text_id, "code": code, "market": market})

    def option_data(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        raise NotImplementedError("option_data 尚未实现：等待后端数据字典与服务定义")

    def ipo_today(self) -> Response:
        return self.call("ipo_today")

    def ipo_wait(self) -> Response:
        return self.call("ipo_wait")

    def complete_ths_code(self, ths_code: Union[str, list]) -> Response:
        params = {"codes" if isinstance(ths_code, list) else "code": ths_code}
        return self.call(method="complete_code", params=params)

    def help(self, req: str = "") -> str:
        result_code, result = self.lib_call("help", req)
        response = Response(result)
        if isinstance(response.data, str):
            return response.data
        if isinstance(response.data, dict):
            help_value = response.data.get("help", "")
            return help_value if isinstance(help_value, str) else ""
        return ""
