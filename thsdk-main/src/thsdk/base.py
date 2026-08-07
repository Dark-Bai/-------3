# encoding: utf-8
import ctypes as c
import json
import logging
import os
import platform
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from zoneinfo import ZoneInfo

from ._constants import rand_account, string_to_mac
from .response import Response
from .validators import (
    FIXED_LENGTH_SECURITY_MARKETS,
    VALID_MARKETS,
)

tz = ZoneInfo("Asia/Shanghai")

if sys.version_info < (3, 9):
    raise RuntimeError(
        "此程序需要 Python 3.9 或更高版本，当前版本为 {}.{}.{}".format(
            sys.version_info.major, sys.version_info.minor, sys.version_info.micro
        )
    )

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s]: %(message)s")
logger = logging.getLogger(__name__)


class THSBase:
    def __init__(self, ops: Optional[Dict[str, Any]] = None):
        ops = ops or {}
        has_user_credentials = "username" in ops and "password" in ops

        if not has_user_credentials:
            env_username = os.getenv("THS_USERNAME")
            env_password = os.getenv("THS_PASSWORD")
            env_mac = os.getenv("THS_MAC")

            if env_username and env_password:
                ops.setdefault("username", env_username)
                ops.setdefault("password", env_password)
                ops.setdefault("mac", env_mac)
                logger.info("✅ 已从环境变量读取账户配置")
            else:
                account = rand_account()
                ops.setdefault("username", account[0])
                ops.setdefault("password", account[1])
                ops.setdefault("mac", account[2])

        if "mac" not in ops:
            ops.setdefault("mac", string_to_mac(ops.get("username")))

        self.ops = ops
        self._initialized = False
        self._lib = self._load_library()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.disconnect()

    @staticmethod
    def _load_library():
        dll_path = ""
        system = platform.system()
        arch = platform.machine()
        base_dir = os.path.dirname(__file__)
        if system == "Linux":
            if arch in ["x86_64", "amd64", "AMD64"]:
                dll_path = os.path.join(base_dir, "libs", "linux", "amd64", "hq.so")
            elif arch in ["aarch64", "arm64"]:
                dll_path = os.path.join(base_dir, "libs", "linux", "arm64", "hq.so")
            else:
                raise Exception(f"暂不支持的 Linux 架构: {arch}")
        elif system == "Darwin":
            if arch in ["aarch64", "arm64"]:
                dll_path = os.path.join(base_dir, "libs", "darwin", "arm64", "hq.dylib")
            else:
                dll_path = os.path.join(base_dir, "libs", "darwin", "amd64", "hq.dylib")
        elif system == "Windows":
            dll_path = os.path.join(base_dir, "libs", "windows", "hq.dll")
        if not dll_path:
            raise Exception(f"不支持的操作系统: {system}")

        try:
            lib = c.CDLL(dll_path)
            lib.Call.argtypes = [c.c_char_p, c.c_char_p, c.c_int]
            lib.Call.restype = c.c_int
            return lib
        except OSError as e:
            raise Exception(f"加载动态链接库 {dll_path} 失败: {e}")

    @staticmethod
    def _normalize_code_list(
        codes: Union[str, List[str]],
        *,
        field_name: str,
        invalid_type_message: str,
        invalid_code_message: str,
        valid_markets: frozenset[str],
        min_length: int = 4,
        exact_length: Optional[int] = None,
    ) -> Union[List[str], Response]:
        if isinstance(codes, str):
            normalized_codes = [codes.upper()]
        elif isinstance(codes, list) and all(isinstance(code, str) for code in codes):
            normalized_codes = [code.upper() for code in codes]
        else:
            return THSBase._error_response(invalid_type_message or f"{field_name} 必须是字符串或者字符串列表")

        for code in normalized_codes:
            if exact_length is not None and len(code) != exact_length:
                return THSBase._error_response(invalid_code_message)
            if len(code) < min_length or code[:4] not in valid_markets:
                return THSBase._error_response(invalid_code_message)

        return normalized_codes

    @classmethod
    def _normalize_fixed_length_codes(
        cls,
        codes: Union[str, List[str]],
        *,
        invalid_type_message: str,
        invalid_code_message: str,
        valid_markets: frozenset[str] = FIXED_LENGTH_SECURITY_MARKETS,
    ) -> Union[List[str], Response]:
        return cls._normalize_code_list(
            codes,
            field_name="ths_code",
            invalid_type_message=invalid_type_message,
            invalid_code_message=invalid_code_message,
            valid_markets=valid_markets,
            exact_length=10,
        )

    @classmethod
    def _normalize_variable_length_codes(
        cls,
        codes: Union[str, List[str]],
        *,
        invalid_type_message: str,
        invalid_code_message: str,
        valid_markets: frozenset[str] = VALID_MARKETS,
    ) -> Union[List[str], Response]:
        return cls._normalize_code_list(
            codes,
            field_name="ths_code",
            invalid_type_message=invalid_type_message,
            invalid_code_message=invalid_code_message,
            valid_markets=valid_markets,
        )

    def _build_market_query(
        self,
        codes: Union[str, List[str]],
        *,
        query_key: str,
        query_config: Dict[str, Dict[str, Union[int, str]]],
        service: str,
        field_name: str,
        invalid_type_message: str,
        invalid_code_message: str,
        mixed_market_message: str,
        valid_markets: frozenset[str],
        min_length: int = 4,
        exact_length: Optional[int] = None,
    ) -> Response:
        if query_key not in query_config:
            return self._error_response(f"无效的查询键。必须为 {list(query_config.keys())} 之一")

        normalized_codes = self._normalize_code_list(
            codes,
            field_name=field_name,
            invalid_type_message=invalid_type_message,
            invalid_code_message=invalid_code_message,
            valid_markets=valid_markets,
            min_length=min_length,
            exact_length=exact_length,
        )
        if isinstance(normalized_codes, Response):
            return normalized_codes

        markets = {code[:4] for code in normalized_codes}
        if len(markets) > 1:
            return self._error_response(mixed_market_message)

        config = query_config[query_key]
        params = {
            "id": config["id"],
            "codelist": ",".join(code[4:] for code in normalized_codes),
            "market": markets.pop(),
            "datatype": config["data_type"],
            "service": service,
        }
        return self.query_data(params)

    def _transform_time_field(self, response: Response, converter) -> Response:
        if response.error or not isinstance(response.data, list):
            return response

        for entry in response.data:
            if isinstance(entry, dict) and "时间" in entry:
                entry["时间"] = converter(entry["时间"])
        return response

    @staticmethod
    def get_err_info_by_code(code: int) -> str:
        return {
            0: "成功",
            -1: "输出缓冲区太小",
            -2: "输入参数无效",
            -3: "内部错误",
            -4: "查询失败",
            -5: "未连接到服务器",
            -6: "请求超时",
        }.get(code, f"未知错误码: {code}")

    @staticmethod
    def _error_response(err_info: str) -> Response:
        return Response(json.dumps({"err_info": err_info, "payload": {}}))

    @staticmethod
    def _int2time(scr: int) -> datetime:
        try:
            year = 2000 + ((scr & 133169152) >> 20) % 100
            month = (scr & 983040) >> 16
            day = (scr & 63488) >> 11
            hour = (scr & 1984) >> 6
            minute = scr & 63
            return datetime(year, month, day, hour, minute, tzinfo=tz)
        except ValueError as e:
            raise ValueError(f"无效的时间整数: {scr}, 错误: {e}")

    def lib_call(
        self, method: str, params: Optional[Union[str, dict, list]] = "", buffer_size: int = 1024 * 1024
    ) -> tuple[int, str]:
        input_json = {"method": method, "params": params}

        try:
            input_json_bytes = json.dumps(input_json).encode("utf-8")
        except (TypeError, ValueError) as e:
            raise Exception(f"JSON 序列化失败: {e}")

        output_buffer = c.create_string_buffer(buffer_size)
        status = self._lib.Call(input_json_bytes, output_buffer, c.c_int(buffer_size))
        try:
            result = output_buffer.value.decode("utf-8") if output_buffer.value else ""
        except UnicodeDecodeError:
            raise Exception("[thsdk] 输出缓冲区解码失败，可能包含非 UTF-8 数据")
        return status, result

    def call(self, method: str, params: Optional[Union[str, dict, list]] = "", buffer_size: int = 1024 * 1024) -> Response:
        if not self._initialized:
            return self._error_response("未登录")

        result_code, result = self.lib_call(method=method, params=params, buffer_size=buffer_size)

        if result_code == 0:
            response = Response(result)
            if not response:
                logger.warning(f"call错误信息: {response.error}")
            return response
        if result_code == -1:
            current_size_mb = buffer_size / (1024 * 1024)
            return self._error_response(
                f"缓冲区大小不足,当前大小: {current_size_mb:.2f} MB,需要调整扩大 buffer_size 接收返回数据"
            )
        if result_code == -6:
            response = Response(result)
            if not response:
                logger.warning(f"请求超时: {response.error}")
            return response
        return self._error_response(
            f"错误代码: {result_code},{self.get_err_info_by_code(result_code)}, 未找到方法: {method}, 参数:{params}"
        )

    def connect(self, max_retries: int = 5) -> Response:
        if not isinstance(max_retries, int) or max_retries <= 0:
            max_retries = 5
        username = self.ops.get("username", "")

        if self._initialized:
            logger.warning("❌ 已处于登录状态，请先调用 disconnect() 断开连接后再重新连接。")
            return self._error_response("❌ 已处于登录状态，请先断开连接（disconnect）后再重新连接。")

        for attempt in range(max_retries):
            try:
                result_code, result = self.lib_call(method="connect", params=self.ops, buffer_size=1024 * 10)
                if result_code != 0:
                    logger.error(
                        f"❌ 错误代码: {result_code},{self.get_err_info_by_code(result_code)}, 连接失败 account:{self.ops.get('username', '')}"
                    )
                    return self._error_response(
                        f"错误代码: {result_code},{self.get_err_info_by_code(result_code)}, 连接失败 account:{self.ops.get('username', '')}"
                    )
                response = Response(result)
                if response.error == "":
                    self._initialized = True
                    mac = self.ops.get("mac", "")
                    logger.info(f"✅ TCP成功连接到服务器 account:{username} mac:{mac}")
                    if str(username).startswith("thsguest_"):
                        logger.warning("=" * 80)
                        logger.warning("⚠️  当前使用临时游客账户（仅供测试）")
                        logger.warning("⚠️  临时账户可能随时失效，不适合生产环境使用")
                        logger.warning("⚠️  建议使用您自己的账户以确保服务稳定性")
                        logger.warning(
                            "⚠️  配置方式：THS({'username': 'your_username', 'password': 'your_password', 'mac': 'your_mac_address'})"
                        )
                        logger.warning("=" * 80)
                    return response
                logger.warning(f"❌ 第 {attempt + 1} 次连接尝试失败: {response.error} account:{username}")
            except Exception as e:
                logger.error(f"❌ 连接报错: {e}")
            time.sleep(2**attempt)
        logger.error(f"❌ 尝试 {max_retries} 次后连接失败")
        return self._error_response(f"尝试 {max_retries} 次后连接失败")

    def disconnect(self):
        if self._initialized:
            self._initialized = False
            self.lib_call("disconnect")
            logger.info(f"✅ 已成功断开与行情服务器的连接 account:{self.ops.get('username', '')}")
        else:
            logger.info(f"✅ 已经断开连接 account:{self.ops.get('username', '')}")

    def query_data(self, params: dict, buffer_size: int = 1024 * 1024 * 2, max_attempts=5) -> Response:
        if not self._initialized:
            return self._error_response("未登录")

        attempt = 0
        while attempt < max_attempts:
            result_code, result = self.lib_call(method="query_data", params=params, buffer_size=buffer_size)
            if result_code == 0:
                response = Response(result)
                if not response:
                    logger.warning(f"查询数据错误信息: {response.error}")
                return response
            if result_code == -1:
                current_size_mb = buffer_size / (1024 * 1024)
                new_size_mb = (buffer_size * 2) / (1024 * 1024)
                logger.warning(f"缓冲区大小不足。当前大小: {current_size_mb:.2f} MB, 新的大小: {new_size_mb:.2f} MB")
                time.sleep(0.1)
                buffer_size *= 2
                attempt += 1
                if attempt == max_attempts:
                    return self._error_response(
                        f"达到最大尝试次数，错误代码: {result_code},{self.get_err_info_by_code(result_code)} 请求: {params}, 最终缓冲区大小: {buffer_size}"
                    )
            else:
                return self._error_response(
                    f"错误代码: {result_code},{self.get_err_info_by_code(result_code)}, 未找到请求数据: {params}"
                )

        return self._error_response(f"意外错误: 达到最大尝试次数，请求: {params}")
