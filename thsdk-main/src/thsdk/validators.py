# encoding: utf-8

from ._constants import BLOCK_MARKETS, MARKETS

VALID_MARKETS = frozenset(MARKETS)
VALID_BLOCK_MARKETS = frozenset(BLOCK_MARKETS)
FIXED_LENGTH_SECURITY_MARKETS = frozenset(
    {
        "USHI",
        "USHA",
        "USHB",
        "USHD",
        "USHJ",
        "USHP",
        "USHT",
        "USZI",
        "USZA",
        "USZB",
        "USZD",
        "USZJ",
        "USZP",
        "USTM",
    }
)
CN_STOCK_MARKETS = frozenset({"USHA", "USZA", "USTM"})

__all__ = [
    "VALID_MARKETS",
    "VALID_BLOCK_MARKETS",
    "FIXED_LENGTH_SECURITY_MARKETS",
    "CN_STOCK_MARKETS",
]
