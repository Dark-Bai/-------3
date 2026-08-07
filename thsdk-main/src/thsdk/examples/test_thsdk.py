# encoding: utf-8
import argparse
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Optional

from thsdk import THS, Response


@dataclass
class APICase:
    name: str
    func_name: str
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)


@dataclass
class APIRunResult:
    api_name: str
    success: bool
    error: str = ""
    execution_time: float = 0.0
    data_count: int = 0


class APITestResult:
    def __init__(self, name: str):
        self.name = name
        self.results: list[APIRunResult] = []
        self.start_time: Optional[datetime] = None
        self.end_time: Optional[datetime] = None

    @property
    def total_tests(self) -> int:
        return len(self.results)

    @property
    def success_tests(self) -> int:
        return sum(1 for item in self.results if item.success)

    @property
    def failed_tests(self) -> int:
        return self.total_tests - self.success_tests

    def add(self, result: APIRunResult):
        self.results.append(result)

    def print_summary(self):
        total_time = 0.0
        if self.start_time and self.end_time:
            total_time = (self.end_time - self.start_time).total_seconds()

        print("\n" + "=" * 70)
        print(f"{self.name} 测试统计报告")
        print("=" * 70)
        print(f"总测试数: {self.total_tests}")
        print(f"成功: {self.success_tests} ({self.success_tests / self.total_tests * 100:.1f}%)" if self.total_tests else "成功: 0")
        print(f"失败: {self.failed_tests} ({self.failed_tests / self.total_tests * 100:.1f}%)" if self.total_tests else "失败: 0")
        print(f"总耗时: {total_time:.2f} 秒")
        if self.total_tests:
            print(f"平均耗时: {total_time / self.total_tests:.3f} 秒/次")

        failed = [item for item in self.results if not item.success]
        if failed:
            print("\n失败的API调用:")
            for item in failed:
                print(f"  - {item.api_name}: {item.error}")

        print("\n全部调用详情:")
        for item in self.results:
            status = "✓" if item.success else "✗"
            suffix = f", 数据量: {item.data_count}" if item.data_count else ""
            detail = f"耗时 {item.execution_time:.3f}秒{suffix}" if item.success else item.error
            print(f"  {status} {item.api_name}: {detail}")
        print("=" * 70)


BASIC_CASES = [
    APICase("block(沪深A股)", "block", (0xE,)),
    APICase("ths_industry", "ths_industry"),
    APICase("ths_concept", "ths_concept"),
    APICase("index_list", "index_list"),
    APICase("stock_cn_lists", "stock_cn_lists"),
    APICase("depth(单只)", "depth", ("USZA300033",)),
    APICase("klines(日线)", "klines", ("USZA300033",), {"count": 10}),
    APICase("market_data_cn", "market_data_cn", ("USZA300033",)),
    APICase("call_auction", "call_auction", ("USZA300033",)),
    APICase("intraday_data", "intraday_data", ("USZA300033",)),
    APICase("tick_level1", "tick_level1", ("USZA300033",)),
    APICase("wencai_nlp", "wencai_nlp", ("涨停",)),
    APICase("min_snapshot", "min_snapshot", ("USZA300033", "20251225")),
    APICase("normalize_symbol", "complete_ths_code", ("300033",)),
]

ADVANCED_CASES = [
    APICase("stock_us_lists", "stock_us_lists"),
    APICase("stock_hk_lists", "stock_hk_lists"),
    APICase("stock_uk_lists", "stock_uk_lists"),
    APICase("market_data_us", "market_data_us", ("UNQQTSLA",)),
    APICase("market_data_hk", "market_data_hk", ("UEUACPIC",)),
    APICase("fund_etf_lists", "fund_etf_lists"),
    APICase("market_data_fund", "market_data_fund", ("USZJ159629",)),
    APICase("bond_lists", "bond_lists"),
    APICase("market_data_bond", "market_data_bond", ("USHD113037",)),
    APICase("futures_lists", "futures_lists"),
    APICase("forex_list", "forex_list"),
    APICase("market_data_forex", "market_data_forex", ("UFXBUSDCNY",)),
    APICase("market_data_index", "market_data_index", ("USHI1B0935",)),
    APICase("klines(1分钟)", "klines", ("USZA300033",), {"count": 10, "interval": "1m"}),
    APICase("klines(5分钟)", "klines", ("USZA300033",), {"count": 10, "interval": "5m"}),
    APICase("klines(前复权)", "klines", ("USZA300033",), {"count": 10, "adjust": "forward"}),
]


def count_response_data(response: Optional[Response]) -> int:
    if not response or not response.data:
        return 0
    if isinstance(response.data, list):
        return len(response.data)
    if isinstance(response.data, dict):
        return 1
    if isinstance(response.data, str):
        return len(response.data)
    return 0


def run_case(test_result: APITestResult, func: Callable[..., Response], case: APICase) -> bool:
    start = time.perf_counter()
    try:
        response = func(*case.args, **case.kwargs)
        elapsed = time.perf_counter() - start
        success = bool(response) and response.success
        test_result.add(
            APIRunResult(
                api_name=case.name,
                success=success,
                error="" if success else response.error,
                execution_time=elapsed,
                data_count=count_response_data(response),
            )
        )
        return success
    except Exception as exc:
        elapsed = time.perf_counter() - start
        test_result.add(APIRunResult(api_name=case.name, success=False, error=str(exc), execution_time=elapsed))
        return False


def ensure_connected(ths: THS) -> tuple[bool, Response]:
    response = ths.connect()
    return bool(response) and response.success, response


def run_cases(ths: THS, name: str, cases: list[APICase], require_connection: bool) -> APITestResult:
    result = APITestResult(name)
    result.start_time = datetime.now()

    if require_connection and not ths._initialized:
        ok, response = ensure_connected(ths)
        result.add(
            APIRunResult(
                api_name="connect",
                success=ok,
                error="" if ok else response.error,
            )
        )
        if not ok:
            result.end_time = datetime.now()
            return result

    for case in cases:
        run_case(result, getattr(ths, case.func_name), case)

    result.end_time = datetime.now()
    return result


def print_overall_summary(results: list[APITestResult]):
    total_tests = sum(item.total_tests for item in results)
    total_success = sum(item.success_tests for item in results)
    total_failed = sum(item.failed_tests for item in results)
    total_time = 0.0
    if results and results[0].start_time and results[-1].end_time:
        total_time = (results[-1].end_time - results[0].start_time).total_seconds()

    print("\n" + "=" * 70)
    print("总体测试统计")
    print("=" * 70)
    print(f"总测试数: {total_tests}")
    print(f"成功: {total_success} ({total_success / total_tests * 100:.1f}%)" if total_tests else "成功: 0")
    print(f"失败: {total_failed} ({total_failed / total_tests * 100:.1f}%)" if total_tests else "失败: 0")
    print(f"总耗时: {total_time:.2f} 秒")
    print("=" * 70)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="THS SDK API 测试工具")
    parser.add_argument("--suite", choices=("basic", "advanced", "all"), default="all")
    return parser.parse_args()


def main():
    args = parse_args()
    print("=" * 70)
    print("THS SDK API 测试工具")
    print("=" * 70)

    selected: list[tuple[str, list[APICase]]] = []
    if args.suite in ("basic", "all"):
        selected.append(("基础", BASIC_CASES))
    if args.suite in ("advanced", "all"):
        selected.append(("高级", ADVANCED_CASES))

    with THS() as ths:
        results = []
        for name, cases in selected:
            result = run_cases(ths, name, cases, require_connection=True)
            result.print_summary()
            results.append(result)

    print_overall_summary(results)


if __name__ == "__main__":
    main()
