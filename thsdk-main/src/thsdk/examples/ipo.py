from thsdk import THS


def print_response_df(title: str, response):
    print(f"\n=== {title} ===")
    if not response:
        print(f"查询失败: {response.error}")
        return

    df = response.df
    if df.empty:
        print("没有数据")
    else:
        print(df)


def main():
    with THS() as ths:
        print_response_df("今日IPO", ths.ipo_today())
        print_response_df("IPO等待列表", ths.ipo_wait())


if __name__ == "__main__":
    main()
