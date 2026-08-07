from thsdk import THS

from thsdk.examples._helpers import print_response_df

with THS() as ths:
    print_response_df("概念:", ths.ths_concept())
