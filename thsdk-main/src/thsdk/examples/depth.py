from thsdk import THS

from thsdk.examples._helpers import print_response_df


with THS() as ths:
    print_response_df("单只五档:", ths.depth("USZA300033"))
    print_response_df("多支五档:", ths.depth(["USZA300033", "USZA300750"]))
