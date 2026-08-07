import pandas as pd

from thsdk import THS


STOCK_CODE = "USZA300033"
SIGNED_DIRECTION = {1: 1, 2: 1, -1: -1, -2: -1}


def main():
    with THS() as ths:
        print(f"正在查询 {STOCK_CODE} 的大单数据...\n")
        response = ths.big_order_flow(STOCK_CODE)
        if not response or response.df is None or response.df.empty:
            print("获取数据失败或数据为空")
            if response and response.error:
                print(f"错误信息: {response.error}")
            return

        df = response.df.copy()
        df["时间"] = pd.to_datetime(df["时间"], unit="s", utc=True, errors="coerce")
        df = df.dropna(subset=["时间"])
        df["时间"] = df["时间"].dt.tz_convert("Asia/Shanghai")
        df["分钟"] = df["时间"].dt.floor("min")
        df["净额_元"] = df["总金额"] * df["成交方向"].map(SIGNED_DIRECTION).fillna(0)

        print("前5行原始数据:")
        print(df.head())
        print("-" * 60)

        total_buy_active = df[df["成交方向"] == 1]["总金额"].sum() / 10000
        total_sell_active = df[df["成交方向"] == -1]["总金额"].sum() / 10000
        total_buy_passive = df[df["成交方向"] == 2]["总金额"].sum() / 10000
        total_sell_passive = df[df["成交方向"] == -2]["总金额"].sum() / 10000

        print("\n【整体大单统计】")
        print(f"主动买入 : {total_buy_active:12,.2f} 万")
        print(f"主动卖出 : {total_sell_active:12,.2f} 万")
        print(f"被动买入 : {total_buy_passive:12,.2f} 万")
        print(f"被动卖出 : {total_sell_passive:12,.2f} 万")
        print("-" * 40)
        print(f"净额(主被动) : {(total_buy_active + total_buy_passive - total_sell_active - total_sell_passive):12,.2f} 万")
        print(f"净额(仅主动): {(total_buy_active - total_sell_active):12,.2f} 万")
        print("=" * 60)

        minute_stats = df.groupby("分钟").agg(
            主被动流入_万元=("净额_元", lambda x: x[x > 0].sum() / 10000),
            主被动流出_万元=("净额_元", lambda x: x[x < 0].sum() / 10000),
            净额_万元=("净额_元", lambda x: x.sum() / 10000),
            总笔数=("总金额", "count"),
            总金额_万元=("总金额", lambda x: x.sum() / 10000),
        ).reset_index()
        minute_stats = minute_stats.round(2)
        minute_stats["累计净额_万元"] = minute_stats["净额_万元"].cumsum().round(2)
        minute_stats = minute_stats[
            ["分钟", "净额_万元", "累计净额_万元", "主被动流入_万元", "主被动流出_万元", "总笔数", "总金额_万元"]
        ].sort_values("分钟")

        print("\n【按分钟统计 - 主被动净额】（正数=资金净流入）")
        print(minute_stats.to_string(index=False))
        print("=" * 60)


if __name__ == "__main__":
    main()
