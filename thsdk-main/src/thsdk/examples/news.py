from thsdk import THS


def print_news_section(title: str, response):
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
        print_news_section("7X24快讯最新新闻", ths.news())
        print_news_section("7X24快讯重要新闻", ths.news(text_id=0x2001))
        print_news_section("个股社区", ths.news(text_id=0x3808, code="300033", market="USZA"))
        print_news_section("个股公告", ths.news(text_id=0x3805, code="300033", market="USZA"))
        print_news_section("个股研报", ths.news(text_id=0x3806, code="300033", market="USZA"))


if __name__ == "__main__":
    main()
