from thsdk import THS
import pandas as pd


def show_tick_super_level1(ths: THS, title: str, code: str, date: str = ""):
    print(title)
    response = ths.tick_super_level1(code, date) if date else ths.tick_super_level1(code)
    if not response:
        print(f"错误信息: {response.error}")
        return

    df = response.df
    df["时间"] = pd.to_datetime(df["时间"], unit="s", utc=True).dt.tz_convert("Asia/Shanghai")
    print(df)


with THS() as ths:
    show_tick_super_level1(ths, "当日 超级盘口带买卖5档位盘口:", "USZA002632")
    show_tick_super_level1(ths, "历史 超级盘口带买卖5档位盘口:", "USZA300033", "20250701")
