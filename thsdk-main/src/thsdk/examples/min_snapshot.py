import pandas as pd
from thsdk import THS

with THS() as ths:
    code = "USZA300033"
    date = "20251225"
    response = ths.min_snapshot(code, date)

    print(f"查询历史分时快照: 代码={code}, 日期={date}")
    if not response:
        print(f"查询失败: {response.error}")
    elif not response.data:
        print("未获取到分时快照数据。")
    else:
        df = response.df
        if "时间" in df.columns:
            df["时间"] = pd.to_datetime(df["时间"], unit="s", utc=True, errors="coerce").dt.tz_convert("Asia/Shanghai")
        print(df)
        print(f"\n共 {len(df)} 条分时数据。")
        print(f"包含字段: {list(df.columns)}")
