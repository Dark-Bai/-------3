# encoding: utf-8

from .response import Response


class CatalogAPIMixin:
    def block(self, block_id: int) -> Response:
        if not block_id:
            return self._error_response("必须提供板块 ID")
        return self.call(method="block_data", params={"block_id": block_id})

    def market_block(self, market: str) -> Response:
        if not market:
            return self._error_response("必须提供market")
        return self.call(method="market_block", params={"market": market})

    def block_constituents(self, link_code: str) -> Response:
        if not link_code:
            return self._error_response("必须提供板块代码")
        return self.call(method="block_constituents", params={"link_code": link_code})

    def ths_industry(self) -> Response:
        return self.block(0xCE5F)

    def ths_concept(self) -> Response:
        return self.block(0xCE5E)

    def forex_list(self) -> Response:
        return self.market_block("UFXB")

    def index_list(self) -> Response:
        return self.block(0xD2)

    def stock_cn_lists(self):
        return self.block(0xE)

    def stock_us_lists(self):
        return self.block(0xDC47)

    def stock_hk_lists(self):
        return self.block(0xB)

    def stock_bj_lists(self):
        return self.block(0xCA8B)

    def stock_uk_lists(self):
        return self.market_block("UEUA")

    def stock_b_lists(self):
        return self.block(0xF)

    def futures_lists(self):
        return self.block(0xCAE0)

    def option_lists(self):
        raise NotImplementedError("option_lists 尚未实现")

    def nasdaq_lists(self):
        return self.block(0xD9A9)

    def bond_lists(self) -> Response:
        return self.block(0xCE14)

    def fund_etf_lists(self) -> Response:
        return self.block(0xCFF3)

    def fund_etf_t0_lists(self) -> Response:
        return self.block(0xD90C)
