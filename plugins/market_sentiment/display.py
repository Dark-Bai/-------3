"""
市场情绪分析师插件 - 指标显示格式化模块
"""

from typing import Dict


def format_arbr_data(arbr_data: Dict) -> str:
    """格式化ARBR指标数据"""
    if not arbr_data:
        return "ARBR数据不可用"

    lines = [
        "--- ARBR情绪指标 ---",
        f"计算周期: {arbr_data.get('period', 26)}日",
        f"AR值（人气指标）: {arbr_data.get('latest_ar', 'N/A'):.2f}",
        f"BR值（意愿指标）: {arbr_data.get('latest_br', 'N/A'):.2f}",
        f"综合信号: {arbr_data.get('signals', {}).get('overall_signal', 'N/A')}",
        f"信号强度: {arbr_data.get('signals', {}).get('signal_strength', 'N/A')}",
        "",
        "解读:",
    ]
    for item in arbr_data.get('interpretation', []):
        lines.append(f"  • {item}")

    stats = arbr_data.get('statistics', {})
    if stats:
        lines.extend([
            "",
            f"AR历史均值: {stats.get('ar_mean', 0):.2f} (标准差: {stats.get('ar_std', 0):.2f})",
            f"BR历史均值: {stats.get('br_mean', 0):.2f} (标准差: {stats.get('br_std', 0):.2f})",
        ])

    sig_stats = arbr_data.get('signal_statistics', {})
    if sig_stats:
        lines.extend([
            "",
            f"历史买入信号比例: {sig_stats.get('buy_ratio', 'N/A')}",
            f"历史卖出信号比例: {sig_stats.get('sell_ratio', 'N/A')}",
        ])

    return '\n'.join(lines)


def format_turnover_rate(turnover_data: Dict) -> str:
    """格式化换手率数据"""
    if not turnover_data:
        return "换手率数据不可用"
    return (
        f"--- 换手率 ---\n"
        f"当前换手率: {turnover_data.get('current_turnover_rate', 'N/A')}%\n"
        f"解读: {turnover_data.get('interpretation', 'N/A')}"
    )


def format_market_index(market_data: Dict) -> str:
    """格式化大盘指数情绪"""
    if not market_data:
        return "大盘指数数据不可用"

    lines = [
        "--- 大盘市场情绪 ---",
        f"指数: {market_data.get('index_name', 'N/A')}",
        f"涨跌幅: {market_data.get('change_percent', 'N/A')}%",
    ]
    if market_data.get('sentiment_score'):
        lines.extend([
            f"涨家数: {market_data.get('up_count', 'N/A')}只",
            f"跌家数: {market_data.get('down_count', 'N/A')}只",
            f"平家数: {market_data.get('flat_count', 'N/A')}只",
            f"市场情绪得分: {market_data.get('sentiment_score', 'N/A')}",
            f"市场情绪: {market_data.get('sentiment_interpretation', 'N/A')}",
        ])
    return '\n'.join(lines)


def format_limit_up_down(limit_data: Dict) -> str:
    """格式化涨跌停数据"""
    if not limit_data:
        return "涨跌停数据不可用"
    return (
        f"--- 涨跌停统计 ---\n"
        f"涨停股: {limit_data.get('limit_up_count', 0)}只\n"
        f"跌停股: {limit_data.get('limit_down_count', 0)}只\n"
        f"涨停占比: {limit_data.get('limit_ratio', 'N/A')}\n"
        f"解读: {limit_data.get('interpretation', 'N/A')}"
    )


def format_margin_trading(margin_data: Dict) -> str:
    """格式化融资融券数据"""
    if not margin_data:
        return "融资融券数据不可用"
    lines = [
        "--- 融资融券 ---",
        f"融资余额: {margin_data.get('margin_balance', 'N/A')}",
        f"融券余额: {margin_data.get('short_balance', 'N/A')}",
    ]
    if margin_data.get('interpretation'):
        lines.append(f"解读: {'; '.join(margin_data['interpretation'])}")
    return '\n'.join(lines)


def format_fear_greed(fg_data: Dict) -> str:
    """格式化恐慌贪婪指数"""
    if not fg_data:
        return "恐慌贪婪指数不可用"
    lines = [
        "--- 市场恐慌贪婪指数 ---",
        f"指数得分: {fg_data.get('score', 'N/A')}/100",
        f"情绪等级: {fg_data.get('level', 'N/A')}",
        f"解读: {fg_data.get('interpretation', 'N/A')}",
    ]
    if fg_data.get('factors'):
        lines.append(f"参考因子: {', '.join(fg_data['factors'])}")
    return '\n'.join(lines)


def format_full_report(symbol: str, sentiment_data: Dict) -> str:
    """生成完整的市场情绪分析师报告"""
    if not sentiment_data.get('data_success'):
        return f"市场情绪分析失败: {sentiment_data.get('error', '未知错误')}"

    lines = [
        "\n" + "=" * 60,
        f"📈 市场情绪分析师 - 完整报告",
        "=" * 60,
        f"股票代码: {symbol}",
        f"分析日期: {sentiment_data.get('arbr_data', {}).get('calculation_date', 'N/A')}",
        "",
    ]

    # ARBR指标
    if sentiment_data.get('arbr_data'):
        lines.append(format_arbr_data(sentiment_data['arbr_data']))
        lines.append("")

    # 换手率
    if sentiment_data.get('turnover_rate'):
        lines.append(format_turnover_rate(sentiment_data['turnover_rate']))
        lines.append("")

    # 大盘情绪
    if sentiment_data.get('market_index'):
        lines.append(format_market_index(sentiment_data['market_index']))
        lines.append("")

    # 涨跌停
    if sentiment_data.get('limit_up_down'):
        lines.append(format_limit_up_down(sentiment_data['limit_up_down']))
        lines.append("")

    # 融资融券
    if sentiment_data.get('margin_trading'):
        lines.append(format_margin_trading(sentiment_data['margin_trading']))
        lines.append("")

    # 恐慌贪婪指数
    if sentiment_data.get('fear_greed_index'):
        lines.append(format_fear_greed(sentiment_data['fear_greed_index']))
        lines.append("")

    lines.append("=" * 60)
    lines.append("📈 市场情绪分析师报告结束")
    lines.append("=" * 60)

    return '\n'.join(lines)


def get_summary(symbol: str, sentiment_data: Dict) -> Dict:
    """获取摘要信息（结构化数据，便于程序调用）"""
    if not sentiment_data.get('data_success'):
        return {'success': False, 'symbol': symbol, 'error': sentiment_data.get('error', '未知错误')}

    arbr = sentiment_data.get('arbr_data', {})
    turnover = sentiment_data.get('turnover_rate', {})
    market = sentiment_data.get('market_index', {})
    limit = sentiment_data.get('limit_up_down', {})
    fg = sentiment_data.get('fear_greed_index', {})

    return {
        'success': True,
        'symbol': symbol,
        'arbr_ar': arbr.get('latest_ar'),
        'arbr_br': arbr.get('latest_br'),
        'arbr_signal': arbr.get('signals', {}).get('overall_signal', 'N/A'),
        'turnover_rate': turnover.get('current_turnover_rate', 'N/A'),
        'market_change': market.get('change_percent', 'N/A'),
        'market_sentiment': market.get('sentiment_interpretation', 'N/A'),
        'limit_up_count': limit.get('limit_up_count', 0),
        'limit_down_count': limit.get('limit_down_count', 0),
        'fear_greed_score': fg.get('score', 'N/A'),
        'fear_greed_level': fg.get('level', 'N/A'),
        'data_success': True,
    }