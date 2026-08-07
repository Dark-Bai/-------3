import argparse
import fnmatch
import py_compile
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


EXCLUDED_FILES = {"__init__.py", "_helpers.py", "run_all_examples.py"}
DEFAULT_LIVE_EXCLUDES = {"test_thsdk.py"}


@dataclass
class ExampleResult:
    name: str
    success: bool
    elapsed: float
    error: str = ""


def examples_dir() -> Path:
    return Path(__file__).resolve().parent


def discover_examples(pattern: str = "*", include_test_script: bool = False) -> list[Path]:
    files = []
    for path in sorted(examples_dir().glob("*.py")):
        if path.name in EXCLUDED_FILES:
            continue
        if not include_test_script and path.name in DEFAULT_LIVE_EXCLUDES:
            continue
        if not fnmatch.fnmatch(path.name, pattern):
            continue
        files.append(path)
    return files


def run_syntax_check(paths: list[Path]) -> list[ExampleResult]:
    results = []
    for path in paths:
        start = time.perf_counter()
        try:
            py_compile.compile(str(path), doraise=True)
            results.append(ExampleResult(path.name, True, time.perf_counter() - start))
        except py_compile.PyCompileError as exc:
            results.append(ExampleResult(path.name, False, time.perf_counter() - start, str(exc)))
    return results


def run_live_examples(paths: list[Path], timeout: int) -> list[ExampleResult]:
    results = []
    project_root = Path(__file__).resolve().parents[2]
    for path in paths:
        start = time.perf_counter()
        try:
            completed = subprocess.run(
                [sys.executable, str(path)],
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            success = completed.returncode == 0
            error = ""
            if not success:
                error = (completed.stderr or completed.stdout).strip()
            results.append(ExampleResult(path.name, success, time.perf_counter() - start, error))
        except subprocess.TimeoutExpired:
            results.append(ExampleResult(path.name, False, time.perf_counter() - start, f"运行超时，超过 {timeout} 秒"))
    return results


def print_summary(results: list[ExampleResult], mode: str):
    success_count = sum(1 for item in results if item.success)
    print(f"\nExamples {mode} Summary")
    print("=" * 60)
    for item in results:
        status = "PASS" if item.success else "FAIL"
        line = f"[{status}] {item.name} ({item.elapsed:.2f}s)"
        if item.error:
            line = f"{line}\n{item.error}"
        print(line)
    print("=" * 60)
    print(f"Total: {len(results)}, Passed: {success_count}, Failed: {len(results) - success_count}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="一键运行 thsdk/examples 测试")
    parser.add_argument(
        "--mode",
        choices=("syntax", "live"),
        default="syntax",
        help="syntax: 仅做语法编译检查；live: 逐个执行示例脚本",
    )
    parser.add_argument("--pattern", default="*", help="按文件名过滤示例，如 'market_data_*.py'")
    parser.add_argument("--timeout", type=int, default=30, help="live 模式下单个示例的超时时间（秒）")
    parser.add_argument("--include-test-script", action="store_true", help="是否包含 test_thsdk.py")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    paths = discover_examples(args.pattern, include_test_script=args.include_test_script)
    if not paths:
        print("未找到匹配的示例文件")
        return 1

    if args.mode == "syntax":
        results = run_syntax_check(paths)
    else:
        results = run_live_examples(paths, timeout=args.timeout)

    print_summary(results, args.mode)
    return 0 if all(item.success for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
