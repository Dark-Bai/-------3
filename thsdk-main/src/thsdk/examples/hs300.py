from thsdk import THS

with THS() as ths:
    response = ths.index_list()
    if not response:
        print(f"获取指数列表失败: {response.error}")
        raise SystemExit(1)

    df = response.df
    hs300_code = df.loc[df['名称'] == '沪深300', '代码']
    print("沪深300指数:")
    print(hs300_code)

    for code in hs300_code:
        klines_response = ths.klines(code, count=100)
        if klines_response:
            klines_df = klines_response.df
            print(f"K-line data for {code}:")
            print(klines_df)
        else:
            print(f"Failed to fetch K-line data for {code}: {klines_response.error}")

    response = ths.wencai_nlp("沪深300 成份股")
    if not response:
        print(f"问财查询失败: {response.error}")
    else:
        df = response.df
        print(df)
