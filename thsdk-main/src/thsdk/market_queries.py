# encoding: utf-8
from typing import Any

from .query_configs import (
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
from .response import Response
from .validators import FIXED_LENGTH_SECURITY_MARKETS, VALID_BLOCK_MARKETS, VALID_MARKETS


class MarketQueryAPIMixin:
    def market_data_block(self, block_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            block_code,
            query_key=query_key,
            query_config=MARKET_DATA_BLOCK_QUERY_CONFIG,
            service="fu",
            field_name="block_code",
            invalid_type_message="block_code 必须是字符串或者字符串列表",
            invalid_code_message="板块代码必须为4位市场代码 + 6位数字代码",
            mixed_market_message="一次性查询多支股票必须市场代码相同",
            valid_markets=VALID_BLOCK_MARKETS,
            exact_length=10,
        )

    def market_data_cn(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_CN_QUERY_CONFIG,
            service="zhu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="中国市场证券代码必须为4位市场代码 + 6位数字代码",
            mixed_market_message="一次性查询多支股票必须市场代码相同",
            valid_markets=FIXED_LENGTH_SECURITY_MARKETS,
            exact_length=10,
        )

    def market_data_us(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_US_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或者字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="一次性查询多支股票必须市场代码相同",
            valid_markets=VALID_MARKETS,
        )

    def market_data_hk(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_HK_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )

    def market_data_uk(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_UK_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )

    def market_data_bond(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_BOND_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )

    def market_data_fund(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_FUND_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )

    def market_data_future(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_FUTURE_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )

    def market_data_forex(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_FOREX_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )

    def market_data_index(self, ths_code: Any, query_key: str = "基础数据") -> Response:
        return self._build_market_query(
            ths_code,
            query_key=query_key,
            query_config=MARKET_DATA_INDEX_QUERY_CONFIG,
            service="fu",
            field_name="ths_code",
            invalid_type_message="ths_code 必须是字符串或字符串列表",
            invalid_code_message="证券代码必须至少4个字符，且以有效市场代码开头",
            mixed_market_message="所有股票代码必须属于同一市场",
            valid_markets=VALID_MARKETS,
        )
