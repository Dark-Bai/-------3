import pandas as pd
import time
from thsdk import THS

with THS() as ths:
    start_time = time.perf_counter()
    response = ths.call_auction("USZA300033")
    end_time = time.perf_counter()
    execution_time = end_time - start_time
    print("集合竞价:")
    if not response:
        print(response.error)
        print(f"运行时间: {execution_time:.5f} 秒\n")
    else:
        print(response.df)
        print(f"运行时间: {execution_time:.5f} 秒\n")

        df = response.df.copy()
        df["匹配量"] = df["当前量"]
        df["未匹配量"] = df["买2量"] - df["卖2量"]
        df["时间"] = pd.to_datetime(df["时间"], unit="s", utc=True).dt.tz_convert("Asia/Shanghai")
        df = df.drop(columns=["当前量", "买2量", "卖2量"])

        print("合并数据后:")
        print(df)
