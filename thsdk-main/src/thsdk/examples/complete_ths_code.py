from thsdk import THS

with THS() as ths:
    response = ths.complete_ths_code("300033")
    print("补齐单个:")
    if not response:
        print(f"错误信息: {response.error}")
    else:
        print(response.df)

    codes = ["300033", "600519", "TSLA", "AAPL", "159316", "1A0001"]
    response = ths.complete_ths_code(codes)
    print("补齐多个:")
    if not response:
        print(f"错误信息: {response.error}")
    else:
        print(response.df)
        if len(codes) < len(response.data):
            print("可能获取到多市场数据，检查代码")
        if len(codes) > len(response.data):
            print("补齐结果与原数据数量不匹配")
