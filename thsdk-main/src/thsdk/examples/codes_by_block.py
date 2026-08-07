from thsdk import THS

from thsdk.examples._helpers import print_response_df

with THS() as ths:
    block_funcs = [
        (ths.stock_cn_lists, "A股"),
        (ths.stock_us_lists, "美股"),
        (ths.nasdaq_lists, "纳斯达克"),
        (ths.stock_hk_lists, "港股"),
        (ths.stock_b_lists, "B股"),
        (ths.stock_bj_lists, "北交所"),
    ]

    for func, label in block_funcs:
        print(f"\n==== {label} ====")
        print_response_df("列表数据:", func())
