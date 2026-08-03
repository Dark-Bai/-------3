"""
新闻分析师插件 - 指标显示格式化模块
"""

from typing import Dict, List


def format_flow_score(flow_data: Dict) -> str:
    """格式化流量得分"""
    lines = [
        "=" * 50,
        "📊 流量得分分析",
        "=" * 50,
        f"总流量得分: {flow_data.get('total_score', 'N/A')}/1000",
        f"流量等级: {flow_data.get('level', 'N/A')}",
        f"分析: {flow_data.get('analysis', 'N/A')}",
        "",
        "分类得分:",
        f"  社交媒体: {flow_data.get('social_score', 0)}",
        f"  新闻媒体: {flow_data.get('news_score', 0)}",
        f"  财经平台: {flow_data.get('finance_score', 0)}",
        f"  科技平台: {flow_data.get('tech_score', 0)}",
    ]
    return '\n'.join(lines)


def format_sentiment_result(sentiment_data: Dict) -> str:
    """格式化情绪分析结果"""
    if not sentiment_data:
        return "情绪分析数据不可用"

    sentiment = sentiment_data.get('sentiment', {})
    flow_stage = sentiment_data.get('flow_stage', {})
    momentum = sentiment_data.get('momentum', {})

    lines = [
        "=" * 50,
        "💭 市场情绪分析",
        "=" * 50,
        f"情绪指数: {sentiment.get('sentiment_index', 'N/A')}/100",
        f"情绪分类: {sentiment.get('sentiment_class', 'N/A')}",
        f"流量规模因子: {sentiment.get('flow_factor', 'N/A')}",
        f"财经活跃因子: {sentiment.get('finance_factor', 'N/A')}",
        f"关键词情绪因子: {sentiment.get('keyword_factor', 'N/A')}",
        f"正面/负面新闻数: {sentiment.get('positive_count', 0)}/{sentiment.get('negative_count', 0)}",
        f"分析: {sentiment.get('analysis', 'N/A')}",
        "",
        f"--- 流量阶段 ---",
        f"阶段: {flow_stage.get('stage_name', 'N/A')}",
        f"信号: {flow_stage.get('signal', 'N/A')}",
        f"置信度: {flow_stage.get('confidence', 'N/A')}%",
        f"分析: {flow_stage.get('analysis', 'N/A')}",
        "",
        f"--- 情绪动量 ---",
        f"动量值: {momentum.get('momentum', 'N/A')}",
        f"动量级别: {momentum.get('momentum_level', 'N/A')}",
        f"趋势: {momentum.get('trend', 'N/A')}",
        f"分析: {momentum.get('analysis', 'N/A')}",
        "",
        f"--- 综合评估 ---",
        f"风险等级: {sentiment_data.get('risk_level', 'N/A')}",
        f"操作建议: {sentiment_data.get('advice', 'N/A')}",
        "",
        f"===== 总结 =====",
        f"{sentiment_data.get('summary', 'N/A')}",
    ]
    return '\n'.join(lines)


def format_hot_topics(hot_topics: List[Dict], top_n: int = 10) -> str:
    """格式化热门话题"""
    if not hot_topics:
        return "暂无热门话题数据"

    lines = [
        "=" * 50,
        f"🔥 热门话题 TOP{min(top_n, len(hot_topics))}",
        "=" * 50,
    ]
    for i, topic in enumerate(hot_topics[:top_n], 1):
        sources = ','.join(topic.get('sources', [])[:3])
        lines.append(f"{i:2d}. {topic['topic']} (热度:{topic['heat']}, 跨{topic['cross_platform']}平台, 来源:{sources})")

    return '\n'.join(lines)


def format_stock_news(stock_news: List[Dict], top_n: int = 15) -> str:
    """格式化股票相关新闻"""
    if not stock_news:
        return "暂无股票相关新闻"

    lines = [
        "=" * 50,
        f"📰 股票相关新闻 TOP{min(top_n, len(stock_news))}",
        "=" * 50,
    ]
    for i, news in enumerate(stock_news[:top_n], 1):
        lines.append(f"{i:2d}. [{news.get('platform_name', '未知')}] {news.get('title', '')}")
        if news.get('matched_keywords'):
            lines.append(f"     关键词: {', '.join(news['matched_keywords'][:5])}")
        lines.append(f"     得分: {news.get('score', 0)}")

    return '\n'.join(lines)


def format_full_report(result: Dict) -> str:
    """生成完整的新闻分析师报告"""
    if not result.get('success'):
        return f"分析失败: {result.get('error', '未知错误')}"

    lines = [
        "\n" + "=" * 60,
        "📰 新闻分析师 - 完整报告",
        "=" * 60,
        f"分析时间: {result.get('fetch_time', 'N/A')}",
        f"平台统计: 成功 {result.get('success_count', 0)}/{result.get('total_platforms', 0)} 个平台",
        "",
    ]

    # 流量得分
    flow_data = result.get('flow_data', {})
    if flow_data:
        lines.append(format_flow_score(flow_data))
        lines.append("")

    # 热门话题
    hot_topics = result.get('hot_topics', [])
    if hot_topics:
        lines.append(format_hot_topics(hot_topics))
        lines.append("")

    # 股票相关新闻
    stock_news = result.get('stock_news', [])
    if stock_news:
        lines.append(format_stock_news(stock_news))
        lines.append("")

    # 情绪分析
    sentiment_data = result.get('sentiment_data', {})
    if sentiment_data:
        lines.append(format_sentiment_result(sentiment_data))
        lines.append("")

    lines.append("=" * 60)
    lines.append("📰 新闻分析师报告结束")
    lines.append("=" * 60)

    return '\n'.join(lines)


def get_summary(result: Dict) -> Dict:
    """获取摘要信息（结构化数据，便于程序调用）"""
    if not result.get('success'):
        return {'success': False, 'error': result.get('error', '未知错误')}

    flow_data = result.get('flow_data', {})
    sentiment_data = result.get('sentiment_data', {})
    sentiment = sentiment_data.get('sentiment', {}) if sentiment_data else {}
    flow_stage = sentiment_data.get('flow_stage', {}) if sentiment_data else {}

    return {
        'success': True,
        'flow_score': flow_data.get('total_score', 0),
        'flow_level': flow_data.get('level', 'N/A'),
        'sentiment_index': sentiment.get('sentiment_index', 50),
        'sentiment_class': sentiment.get('sentiment_class', '中性'),
        'flow_stage': flow_stage.get('stage_name', '未知'),
        'signal': flow_stage.get('signal', '观察'),
        'risk_level': sentiment_data.get('risk_level', '未知'),
        'advice': sentiment_data.get('advice', 'N/A'),
        'hot_topic_count': len(result.get('hot_topics', [])),
        'stock_news_count': len(result.get('stock_news', [])),
        'platform_success': result.get('success_count', 0),
        'platform_total': result.get('total_platforms', 0),
    }