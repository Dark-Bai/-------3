"""
市场情绪分析师插件主类
统一接口：Plugin.run() 执行完整分析
"""
import logging
import pandas as pd
from typing import Dict, Optional

from .data_fetcher import MarketSentimentDataFetcher
from .display import format_full_report, get_summary

logger = logging.getLogger(__name__)


class Plugin:
    """
    市场情绪分析师插件
    
    功能：
    1. ARBR情绪指标计算（人气指标AR + 意愿指标BR）
    2. 换手率数据分析
    3. 大盘指数情绪判断
    4. 涨跌停统计
    5. 融资融券数据分析
    6. 市场恐慌贪婪指数计算
    
    使用示例：
        plugin = Plugin()
        result = plugin.run("000001")  # 分析平安银行
        print(result['text_report'])  # 文本报告
        print(result['summary'])      # 结构化摘要
        print(result['ai_text'])      # AI可读的文本数据
    """

    def __init__(self):
        """初始化市场情绪分析师插件"""
        self.fetcher = MarketSentimentDataFetcher()
        self._name = "市场情绪分析师"
        logger.info("✅ 市场情绪分析师插件初始化完成")

    @property
    def name(self) -> str:
        """插件名称"""
        return self._name

    def run(self, symbol: str, stock_data: Optional[pd.DataFrame] = None) -> Dict:
        """
        运行完整的市场情绪分析
        
        Args:
            symbol: 股票代码（6位数字，如 '000001'）
            stock_data: 可选的股票历史DataFrame，用于ARBR计算
            
        Returns:
            {
                'success': bool,
                'plugin_name': str,
                'symbol': str,
                'sentiment_data': Dict,    # 原始市场情绪数据
                'text_report': str,        # 格式化文本报告
                'ai_text': str,            # AI可读的格式化数据
                'summary': Dict,           # 结构化摘要
                'error': str (if failed)
            }
        """
        try:
            logger.info(f"🚀 市场情绪分析师插件开始分析: {symbol}")

            # 1. 获取市场情绪数据
            sentiment_data = self.fetcher.get_market_sentiment_data(symbol, stock_data)

            if not sentiment_data.get('data_success'):
                return {
                    'success': False, 'plugin_name': self._name,
                    'symbol': symbol, 'sentiment_data': sentiment_data,
                    'text_report': f"市场情绪分析失败: {sentiment_data.get('error', '获取数据失败')}",
                    'ai_text': '', 'summary': {'success': False, 'symbol': symbol},
                    'error': sentiment_data.get('error', '获取数据失败')
                }

            # 2. 生成文本报告
            text_report = format_full_report(symbol, sentiment_data)

            # 3. 生成AI可读文本
            ai_text = self.fetcher.format_sentiment_data_for_ai(sentiment_data)

            # 4. 生成结构化摘要
            summary = get_summary(symbol, sentiment_data)

            logger.info("✅ 市场情绪分析师插件分析完成")

            return {
                'success': True,
                'plugin_name': self._name,
                'symbol': symbol,
                'sentiment_data': sentiment_data,
                'text_report': text_report,
                'ai_text': ai_text,
                'summary': summary,
            }

        except Exception as e:
            logger.error(f"❌ 市场情绪分析师插件分析失败: {e}")
            return {
                'success': False, 'plugin_name': self._name, 'symbol': symbol,
                'text_report': f"市场情绪分析异常: {e}", 'ai_text': '',
                'summary': {'success': False, 'symbol': symbol}, 'error': str(e)
            }