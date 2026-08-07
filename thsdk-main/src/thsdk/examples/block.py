from thsdk import THS

from thsdk.examples._helpers import print_response_df

with THS() as ths:
    cases = [
        (0xCE5E, "板块数据:"),
        (0x15, "沪市A股:"),
        (0x1B, "深市A股:"),
        (0xCA8B, "北交所:"),
        (0xCFE4, "创业板:"),
        (0xCBE5, "科创板:"),
        (0xCE5E, "概念:"),
        (0xCE5F, "行业:"),
    ]

    for block_id, title in cases:
        print_response_df(title, ths.block(block_id))
