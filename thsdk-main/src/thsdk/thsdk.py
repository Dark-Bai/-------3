# encoding: utf-8
from typing import Any, Optional

from .base import THSBase
from .catalog import CatalogAPIMixin
from .domestic import DomesticAPIMixin
from .market_queries import MarketQueryAPIMixin
from .misc_api import MiscAPIMixin
from .response import Response

__all__ = ["THS", "Response"]


class THS(
    DomesticAPIMixin,
    CatalogAPIMixin,
    MarketQueryAPIMixin,
    MiscAPIMixin,
    THSBase,
):
    """THS 数据访问客户端。"""

    def __init__(self, ops: Optional[dict[str, Any]] = None):
        super().__init__(ops)
