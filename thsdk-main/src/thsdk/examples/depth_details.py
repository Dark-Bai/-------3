from thsdk import THS


def print_depth(title: str, response):
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
    ths_code = "USZA300033"
    with THS() as ths:
        print_depth("市场深度卖方", ths.order_book_ask(ths_code))
        print_depth("市场深度买方", ths.order_book_bid(ths_code))


if __name__ == "__main__":
    main()
