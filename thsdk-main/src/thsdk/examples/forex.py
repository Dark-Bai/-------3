from thsdk import THS


with THS() as ths:
    response = ths.forex_list()
    print("基本汇率:")
    if not response:
        print(f"错误信息: {response.error}")
    else:
        print(response.df)
