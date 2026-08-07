from thsdk import THS

from thsdk.examples._helpers import print_response_df

with THS() as ths:
    markets = [
        ("USHA", "沪市场"),
        ("USZA", "深市场"),
        ("USTM", "京市场"),
        ("UNQS", "美股纳斯达克"),
        ("UFXB", "汇率市场"),
        ("USHI", "沪指数"),
        ("UIFB", "期权"),
        ("UEUA", "英国"),
    ]

    for code, name in markets:
        print(f"\n{name}({code}):")
        print_response_df("列表数据:", ths.market_block(code))
