# 本示例展示如何使用 THSDK 获取 DDE（大单资金流向）相关数据。
from thsdk import THS

from thsdk.examples._helpers import print_response_df


DETAIL_PARAMS = {
    "id": 200,
    "codelist": "600821,600089,600386,601618,600642,601011,601678,603181,600482,600118,600308,600863,600273,600988,601918",
    "market": "USHA",
    "datatype": "6,7,8,9,10,13,19,223,224,225,226,227,228,229,230",
    "service": "zhu",
}

SUMMARY_PARAMS = {
    "id": 200,
    "codelist": "600821,600089,600386,601618,600642,601011,601678,603181,600482,600118,600308,600863,600273,600988,601918",
    "market": "USHA",
    "datatype": "6,7,8,9,10,13,19,592888,592890",
    "service": "zhu",
}


def iter_block_market_codes(block_codes: list[str]) -> dict[str, list[str]]:
    market_codelist_map: dict[str, list[str]] = {}
    for code in block_codes:
        if len(code) != 10:
            continue
        market = code[:4]
        codelist_code = code[4:]
        market_codelist_map.setdefault(market, []).append(codelist_code)
    return market_codelist_map


def main():
    with THS() as ths:
        print_response_df("dde详细数据", ths.query_data(DETAIL_PARAMS))
        print_response_df("个股dde统计数据", ths.query_data(SUMMARY_PARAMS))

        block_response = ths.block(0xCE5E)
        if not block_response:
            print(f"\n概念板块获取失败: {block_response.error}")
            return

        block_codes = block_response.df["代码"].astype(str).tolist()
        for market, codelist in iter_block_market_codes(block_codes).items():
            response = ths.query_data(
                {
                    "id": 202,
                    "codelist": ",".join(codelist),
                    "market": market,
                    "datatype": "6,7,8,9,10,13,19,331073,68285",
                    "service": "fu",
                }
            )
            print_response_df(f"板块dde统计数据 (market={market})", response)


if __name__ == "__main__":
    main()
