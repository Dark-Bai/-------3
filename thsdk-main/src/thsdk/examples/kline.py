import time
from datetime import datetime
from zoneinfo import ZoneInfo

from thsdk import THS


BJ_TZ = ZoneInfo("Asia/Shanghai")


def run_case(ths: THS, title: str, **kwargs):
    start = time.perf_counter()
    response = ths.klines("USZA300033", **kwargs)
    elapsed = time.perf_counter() - start

    print(title)
    if not response:
        print(response.error)
    else:
        print(response.df)
    print(f"运行时间: {elapsed:.5f} 秒\n")


with THS() as ths:
    run_case(ths, "查询历史近100条日K数据:", count=100)
    run_case(
        ths,
        "查询历史 20240101 - 20250101 日K数据:",
        start_time=datetime(2024, 1, 1, tzinfo=BJ_TZ),
        end_time=datetime(2025, 1, 1, tzinfo=BJ_TZ),
    )
    run_case(ths, "查询历史100条日K数据，前复权:", count=100, adjust="forward")
    run_case(ths, "查询历史100条1分钟K数据:", count=100, interval="1m")
