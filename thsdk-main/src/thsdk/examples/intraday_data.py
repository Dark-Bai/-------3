from thsdk import THS


def show_intraday(ths: THS, code: str, title: str):
    response = ths.intraday_data(code)
    print(title)
    if not response:
        print(f"错误信息: {response.error}")
        return
    print(response.df)


with THS() as ths:
    show_intraday(ths, "USZA300033", "股票日内分时数据:")
    show_intraday(ths, "USHI1A0001", "上证指数日内分时数据:")
