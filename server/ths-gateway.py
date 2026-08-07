# -*- coding: utf-8 -*-
"""
THS 数据网关 — 为 Node.js 服务提供同花顺 thsdk 数据接口。

数据源: 同花顺 THS 底层协议(Python SDK thsdk), 账号从 server/ths-account.json
       或环境变量 THS_USERNAME / THS_PASSWORD / THS_MAC 读取。
作用: 替代已失效的开盘啦(KPL)部分接口, 提供个股实时行情 / 分时 / K线 /
      行业/概念板块列表 / 板块成分股 / 资讯 等底层行情数据。
说明: 涨停/连板/市场情绪/风口等题材聚合数据不在此网关, 由 Node 侧改用东方财富网页接口。
限速: 网关内置令牌桶(默认 20 QPS / 突发 5, 可经 THS_RATE / THS_BURST 覆盖), 超限返回 HTTP 429
      + extra.rateLimited=true, 供 Node 侧退避重试; 账号管理端点不受限速。

启动: python server/ths-gateway.py [--port 9877]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from datetime import date, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlparse

try:
    from thsdk import THS
except Exception as e:  # pragma: no cover
    print(f"[ths-gateway] thsdk 导入失败: {e}", file=sys.stderr)
    sys.exit(1)

ACCOUNT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ths-account.json")


class RateLimited(RuntimeError):
    """令牌桶取令牌超时 → 网关返回 HTTP 429, 由调用方退避重试。"""


class TokenBucket:
    """进程级令牌桶(线程安全): 以恒定 rate 个/秒补桶, 突发上限 burst。

    用于对 ths 服务端做请求频率保护——thsdk 本身无任何限速逻辑,
    官方文档(README FAQ-6)明确建议批量任务自行 sleep/分批;
    网关层统一兜底, 避免高频/突发请求触发 ths 服务端限流。
    """

    def __init__(self, rate: float = 20.0, burst: float = 5.0):
        self.rate = max(0.1, float(rate))       # 每秒补充令牌数
        self.burst = max(1.0, float(burst))     # 桶容量(突发上限)
        self._tokens = float(self.burst)        # 初始满桶, 允许启动即突发
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self, n: float = 1.0, timeout: float = 3.0) -> bool:
        """尝试获取 n 个令牌; 在 timeout 秒内未获满则返回 False(不无限阻塞)。"""
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(self.burst, self._tokens + (now - self._last) * self.rate)
                self._last = now
                if self._tokens >= n:
                    self._tokens -= n
                    return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.01)  # 10ms 轮询, 避免忙等

    def snapshot(self) -> dict:
        """当前状态(监控/调试用): 桶内令牌数与补速参数。"""
        with self._lock:
            now = time.monotonic()
            tokens = min(self.burst, self._tokens + (now - self._last) * self.rate)
            return {"rate": self.rate, "burst": self.burst, "tokens": round(tokens, 2)}


# 网关级令牌桶: 默认 20 QPS / 突发 5(可经 THS_RATE / THS_BURST 环境变量覆盖)。
# 仅对 conn.query 的行情查询生效; 账号读写等管理端点不限速。
RATE_LIMITER = TokenBucket(
    rate=float(os.environ.get("THS_RATE", "20")),
    burst=float(os.environ.get("THS_BURST", "5")),
)


def load_account() -> dict:
    """读取账号: 环境变量优先, 其次本地配置文件。"""
    u = os.environ.get("THS_USERNAME") or ""
    p = os.environ.get("THS_PASSWORD") or ""
    if u and p:
        return {"username": u, "password": p, "mac": os.environ.get("THS_MAC") or ""}
    if os.path.exists(ACCOUNT_FILE):
        try:
            with open(ACCOUNT_FILE, "r", encoding="utf-8") as f:
                acc = json.load(f)
            if acc.get("username") and acc.get("password"):
                return acc
        except Exception as e:
            print(f"[ths-gateway] 读取账号配置失败: {e}", file=sys.stderr)
    return {}


class THSConn:
    """THS 单例连接(带锁, 断线自动重连一次)。"""

    def __init__(self, account: dict):
        self._account = account
        self._ths: Optional[THS] = None
        self._lock = threading.RLock()

    def ensure(self) -> THS:
        with self._lock:
            if self._ths is None:
                if not self._account.get("username"):
                    raise RuntimeError("未配置 THS 账号(server/ths-account.json 或环境变量)")
                self._ths = THS(dict(self._account))
                r = self._ths.connect()
                if not r.success:
                    self._ths = None
                    raise RuntimeError(f"THS 连接失败: {r.error}")
            return self._ths

    def query(self, fn: Callable[[THS], Any], rate: bool = True) -> Any:
        """加锁执行一次查询; 失败时断开并重连一次再试。

        每次查询前先经令牌桶限速(rate=True 时): 令牌不足抛 RateLimited(429)。
        限流判断在连接锁之外——多线程同时到达时, 先由令牌桶全局把关,
        通过的请求再进入 RLock 串行访问 THS 单连接, 兼顾频率保护与线程安全。
        """
        if rate and not RATE_LIMITER.acquire():
            raise RateLimited("ths 限流: 请求频率超过阈值(令牌不足), 请稍后重试")
        with self._lock:
            ths = self.ensure()
            try:
                return fn(ths)
            except Exception:
                try:
                    ths.disconnect()
                except Exception:
                    pass
                self._ths = None
                ths = self.ensure()
                return fn(ths)

    def close(self) -> None:
        with self._lock:
            if self._ths is not None:
                try:
                    self._ths.disconnect()
                except Exception:
                    pass
                self._ths = None

    def get_account(self) -> dict:
        with self._lock:
            return dict(self._account)

    def update_account(self, account: dict) -> None:
        """更新账号并断开现有连接, 下次查询自动用新账号重连。"""
        with self._lock:
            self._account = dict(account)
            self.close()


def _serialize(value: Any) -> Any:
    """datetime/date → isoformat, 便于 JSON 传输。"""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize(v) for v in value]
    return value


def _response(success: bool, data: Any, error: str = "", extra: dict | None = None) -> dict:
    return {"success": success, "error": error, "data": _serialize(data), "extra": extra or {}}


def _rows(resp: Any) -> list:
    if resp is None:
        return []
    data = getattr(resp, "data", None)
    if isinstance(data, list):
        return [r for r in data if isinstance(r, dict)]
    if isinstance(data, dict):
        return [data]
    return []


def make_handlers(conn: THSConn) -> dict:
    def h_quote(qs, body=None):
        code = (qs.get("code") or [""])[0].strip().upper()
        if not code:
            return _response(False, [], "缺少 code 参数")
        r = conn.query(lambda t: t.market_data_cn(code, query_key="基础数据"))
        if not getattr(r, "success", False):
            return _response(False, [], getattr(r, "error", "查询失败"))
        return _response(True, _rows(r))

    def h_minute(qs, body=None):
        code = (qs.get("code") or [""])[0].strip().upper()
        if not code:
            return _response(False, [], "缺少 code 参数")
        r = conn.query(lambda t: t.intraday_data(code))
        if not getattr(r, "success", False):
            return _response(False, [], getattr(r, "error", "查询失败"))
        return _response(True, _rows(r))

    def h_industry(qs, body=None):
        r = conn.query(lambda t: t.ths_industry())
        return _response(True, _rows(r)) if getattr(r, "success", False) else _response(False, [], getattr(r, "error", "查询失败"))

    def h_concept(qs, body=None):
        r = conn.query(lambda t: t.ths_concept())
        return _response(True, _rows(r)) if getattr(r, "success", False) else _response(False, [], getattr(r, "error", "查询失败"))

    def h_constituents(qs, body=None):
        code = (qs.get("code") or [""])[0].strip().upper()
        if not code:
            return _response(False, [], "缺少 code 参数")
        r = conn.query(lambda t: t.block_constituents(code))
        return _response(True, _rows(r)) if getattr(r, "success", False) else _response(False, [], getattr(r, "error", "查询失败"))

    def h_news(qs, body=None):
        r = conn.query(lambda t: t.news())
        return _response(True, _rows(r)) if getattr(r, "success", False) else _response(False, [], getattr(r, "error", "查询失败"))

    def h_search(qs, body=None):
        q = (qs.get("q") or [""])[0].strip()
        need = (qs.get("needmarket") or [""])[0].strip()
        r = conn.query(lambda t: t.search_symbols(q, need) if need else t.search_symbols(q))
        return _response(True, _rows(r)) if getattr(r, "success", False) else _response(False, [], getattr(r, "error", "查询失败"))

    def h_bulk_quote(qs, body=None):
        """批量 A股行情: 同市场分组, 每批 ≤50 只, 批间 sleep 0.1s(ths 限流保护)。

        fields=basic → 基础数据(价格/量额/开高低/昨收); full → 基础+汇总(换手/振幅/量比/PE/PB/市值)。
        market_data_cn 要求同批同市场(USHA/USZA/USTM), 跨市场自动拆批。
        """
        codes = [c.strip().upper() for c in (qs.get("codes") or [""])[0].split(",") if c.strip()]
        if not codes:
            return _response(False, [], "缺少 codes 参数")
        fields = (qs.get("fields") or ["basic"])[0].strip()
        full = fields == "full"
        batch_size = max(1, min(50, int((qs.get("batch") or ["50"])[0])))
        interval = max(0.0, float((qs.get("interval") or ["0.1"])[0]))

        # 按 4 位市场前缀分组; 仅接受 A股三个市场(迁移范围)
        grouped: dict[str, list[str]] = {}
        for c in codes:
            mkt = c[:4]
            if mkt in ("USHA", "USZA", "USTM"):
                grouped.setdefault(mkt, []).append(c)
        if not grouped:
            return _response(False, [], "仅支持 A股代码(USHA/USZA/USTM)")

        out = []
        for market, group in grouped.items():
            for i in range(0, len(group), batch_size):
                batch = group[i:i + batch_size]
                try:
                    r0 = conn.query(lambda t, b=batch: t.market_data_cn(b, query_key="基础数据"))
                    rows0 = _rows(r0) if getattr(r0, "success", False) else []
                    merged = {str(x.get("代码", "")).upper(): x for x in rows0}
                    if full:
                        r1 = conn.query(lambda t, b=batch: t.market_data_cn(b, query_key="汇总"))
                        for x in _rows(r1) if getattr(r1, "success", False) else []:
                            merged.setdefault(str(x.get("代码", "")).upper(), {}).update(x)
                    out.extend(merged.values())
                except Exception as e:
                    return _response(False, [], f"批量行情查询失败: {e}")
                if interval > 0 and i + batch_size < len(group):
                    time.sleep(interval)
        return _response(True, out)

    def h_main_forces(qs, body=None):
        """个股主力资金: 基础数据(总金额/价格) + 扩展1(主力净流入592890/主力净量592888) 合并。"""
        code = (qs.get("code") or [""])[0].strip().upper()
        if not code:
            return _response(False, [], "缺少 code 参数")
        r0 = conn.query(lambda t: t.market_data_cn(code, query_key="基础数据"))
        r1 = conn.query(lambda t: t.market_data_cn(code, query_key="扩展1"))
        if not getattr(r0, "success", False) and not getattr(r1, "success", False):
            return _response(False, [], "查询失败")
        merged: dict = {}
        for x in _rows(r0) if getattr(r0, "success", False) else []:
            merged.update(x)
        for x in _rows(r1) if getattr(r1, "success", False) else []:
            merged.update(x)
        return _response(True, [merged] if merged else [])

    def h_account(qs, body=None):
        """GET: 读取当前账号(不含明文密码); POST: 更新账号并热重连。"""
        if body is None:
            acc = conn.get_account()
            return _response(True, {
                "configured": bool(acc.get("username") and acc.get("password")),
                "username": acc.get("username", ""),
                "mac": acc.get("mac", ""),
            })
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "").strip()
        mac = str(body.get("mac") or "").strip()
        if not username or not password:
            return _response(False, [], "账号与密码不能为空")
        conn.update_account({"username": username, "password": password, "mac": mac})
        return _response(True, {"configured": True, "username": username, "mac": mac})

    return {
        "/api/ths/quote": h_quote,
        "/api/ths/minute": h_minute,
        "/api/ths/industry": h_industry,
        "/api/ths/concept": h_concept,
        "/api/ths/constituents": h_constituents,
        "/api/ths/news": h_news,
        "/api/ths/search": h_search,
        "/api/ths/bulk-quote": h_bulk_quote,
        "/api/ths/main-forces": h_main_forces,
        "/api/ths/account": h_account,
    }


class GatewayHandler(BaseHTTPRequestHandler):
    server_version = "THSGateway/1.0"
    conn: THSConn = None
    handlers: dict = {}

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        handler = self.handlers.get(parsed.path)
        if handler is None:
            self._send_json(_response(False, [], "Not Found"), HTTPStatus.NOT_FOUND)
            return
        self._dispatch(handler, parse_qs(parsed.query), None)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        handler = self.handlers.get(parsed.path)
        if handler is None:
            self._send_json(_response(False, [], "Not Found"), HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        payload = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        self._dispatch(handler, parse_qs(parsed.query), payload)

    def _dispatch(self, handler, qs, body) -> None:
        """统一执行 handler 并序列化响应; 令牌桶限流(429)与通用异常在此兜底。"""
        try:
            t0 = time.perf_counter()
            payload = handler(qs, body)
            ms = round((time.perf_counter() - t0) * 1000, 2)
            payload.setdefault("extra", {})
            payload["extra"]["duration_ms"] = ms
            self._send_json(payload)
        except RateLimited as e:
            # 429 + rateLimited 标记: Node 侧 thsFetch 可据此识别并退避重试
            self._send_json(
                _response(False, [], str(e), {"rateLimited": True}),
                HTTPStatus.TOO_MANY_REQUESTS,
            )
        except Exception as e:
            self._send_json(_response(False, [], f"网关异常: {e}"))

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def run_server(port: int = 9877) -> int:
    account = load_account()
    if not account.get("username"):
        print("[ths-gateway] 警告: 未配置 THS 账号, 请设置 server/ths-account.json 或环境变量", file=sys.stderr)
    conn = THSConn(account)
    GatewayHandler.conn = conn
    GatewayHandler.handlers = make_handlers(conn)
    server = ThreadingHTTPServer(("127.0.0.1", port), GatewayHandler)
    print(f"[ths-gateway] THS 数据网关已启动: http://127.0.0.1:{port} "
          f"(限速 {RATE_LIMITER.rate:.1f} QPS / 突发 {RATE_LIMITER.burst:.0f})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        conn.close()
        server.server_close()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="THS 数据网关")
    parser.add_argument("--port", type=int, default=9877)
    args = parser.parse_args()
    raise SystemExit(run_server(args.port))
