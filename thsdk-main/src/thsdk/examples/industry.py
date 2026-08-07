from thsdk import THS

from thsdk.examples._helpers import print_response_df

with THS() as ths:
    print_response_df("行业:", ths.ths_industry())
