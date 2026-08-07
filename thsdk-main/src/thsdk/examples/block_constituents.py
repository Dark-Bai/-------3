from thsdk import THS

from thsdk.examples._helpers import print_response_df

with THS() as ths:
    print_response_df("板块成份股数据:", ths.block_constituents("URFI886037"))
