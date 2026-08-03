"""
新闻分析师插件主类
统一接口：Plugin.run() 执行完整分析
"""
import logging
from datetime import datetime
from typing import Dict, List, Optional

from .data_fetcher import NewsFlowDataFetcher
from .sentiment_analyzer import SentimentAnalyzer
from .display import format_full_report, get_summary

logger = logging.getLogger(__name__)


class Plugin:
    """
    新闻分析师插件
    
    功能：
    1. 多平台新闻数据获取（22个平台）
    2. 流量得分计算
    3. 热门话题提取
    4. 股票相关新闻提取
    5. 情绪指数计算
    6. 流量阶段判断
    7. 情绪动量分析
    8. 综合风险评估
    
    使用示例：
        plugin = Plugin()
        result = plugin.run()  # 执行完整分析
        print(result['text_report'])  # 文本报告
        print(result['summary'])      # 结构化摘要
    """

    def __init__(self, platforms: List[str] = None, category: str = None):
        """
        初始化新闻分析师插件
        
        Args:
            platforms: 平台列表，None表示全部平台
            category: 平台类别筛选（'social','news','finance','tech'）
        """
        self.platforms = platforms
        self.category = category
        self.fetcher = NewsFlowDataFetcher()
        self.analyzer = SentimentAnalyzer()
        self._name = "新闻分析师"
        logger.info("✅ 新闻分析师插件初始化完成")

    @property
    def name(self) -> str:
        """插件名称"""
        return self._name

    def run(self, platforms: List[str] = None, category: str = None) -> Dict:
        """
        运行完整的新闻分析流程
        
        Returns:
            {
                'success': bool,
                'plugin_name': str,
                'text_report': str,       # 格式化文本报告
                'summary': Dict,           # 结构化摘要
                'flow_data': Dict,         # 流量得分数据
                'sentiment_data': Dict,    # 情绪分析数据
                'hot_topics': List,        # 热门话题
                'stock_news': List,        # 股票相关新闻
                'platforms_data': List,    # 平台原始数据
                'fetch_time': str,
                'error': str (if failed)
            }
        """
        try:
            platforms = platforms or self.platforms
            category = category or self.category

            logger.info("🚀 新闻分析师插件开始分析...")

            # 1. 获取多平台新闻数据
            multi_result = self.fetcher.get_multi_platform_news(platforms=platforms, category=category)
            if not multi_result['success']:
                return {
                    'success': False, 'plugin_name': self._name, 'error': '获取新闻数据失败',
                    'text_report': '新闻分析失败：获取新闻数据失败，请检查网络连接。',
                    'summary': {'success': False},
                }

            platforms_data = multi_result['platforms_data']
            success_count = multi_result['success_count']

            # 2. 提取股票相关新闻
            stock_news = self.fetcher.extract_stock_related_news(platforms_data)

            # 3. 获取热门话题
            hot_topics = self.fetcher.get_hot_topics(platforms_data, top_n=20)

            # 4. 计算流量得分
            flow_data = self.fetcher.calculate_flow_score(platforms_data)

            # 5. 情绪分析
            history_scores = []
            sentiment_data = self.analyzer.run_full_sentiment_analysis(
                platforms_data, stock_news, history_scores, flow_data['total_score']
            )

            fetch_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

            # 6. 组装结果
            result = {
                'success': True,
                'plugin_name': self._name,
                'flow_data': flow_data,
                'sentiment_data': sentiment_data,
                'hot_topics': hot_topics,
                'stock_news': stock_news,
                'platforms_data': platforms_data,
                'success_count': success_count,
                'total_platforms': multi_result['total_platforms'],
                'fetch_time': fetch_time,
            }

            # 7. 生成文本报告和摘要
            result['text_report'] = format_full_report(result)
            result['summary'] = get_summary(result)

            logger.info("✅ 新闻分析师插件分析完成")
            return result

        except Exception as e:
            logger.error(f"❌ 新闻分析师插件分析失败: {e}")
            return {
                'success': False, 'plugin_name': self._name, 'error': str(e),
                'text_report': f'新闻分析异常：{e}',
                'summary': {'success': False},
            }

    def get_platform_list(self) -> List[Dict]:
        """获取支持的平台列表"""
        return self.fetcher.get_platform_list()