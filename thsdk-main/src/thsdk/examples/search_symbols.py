from thsdk import THS


def print_section(title):
    """打印章节标题"""
    print(f"\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}\n")


def print_result(title, response, market_info=""):
    """优雅地打印查询结果"""
    print(f"📊 {title}")
    if market_info:
        print(f"   市场范围: {market_info}")

    if not response:
        print("   查询状态: ❌ 失败")
        print(f"   错误信息: {response.error}\n")
        return

    print("   查询状态: ✅ 成功")
    if response.success:
        df = response.df
        if len(df) > 0:
            print(f"   返回结果: {len(df)} 条")
            print(f"   数据列: {', '.join(df.columns.tolist())}")
            print("\n   数据预览:")
            print(f"\n{df}\n")
        else:
            print("   ⚠️  未找到匹配的结果\n")
    else:
        print(f"   错误信息: {response.error}\n")


def main():
    with THS() as ths:
        print_section("THSDK - 证券模糊查询示例")

        print_section("示例1: 按名称查询（全市场）")
        print_result("查询关键词: '同花顺'", ths.search_symbols("同花顺"))

        print_section("示例2: 按名称查询（限制市场）")
        print_result("查询关键词: '同花顺'", ths.search_symbols("同花顺", "SH,SZ"), "沪深A股 (SH,SZ)")

        print_section("示例3: 查询国际股票")
        print_result("查询关键词: '特斯拉'", ths.search_symbols("特斯拉"), "全市场")

        print_section("示例4: 美股查询（纳斯达克）")
        print_result("查询关键词: '特斯拉'", ths.search_symbols("特斯拉", "NQ"), "纳斯达克 (NQ)")

        print_section("示例5: 查询指数")
        print_result("查询关键词: '上证指数'", ths.search_symbols("上证指数"))

        print_section("示例6: 按代码查询")
        print_result("查询代码: '600000'", ths.search_symbols("600000"))

        print_section("示例7: 按行业概念查询")
        print_result("查询行业概念: '软件开发'", ths.search_symbols("软件开发", "RF"))


if __name__ == "__main__":
    main()
