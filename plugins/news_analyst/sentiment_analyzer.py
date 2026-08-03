"""
新闻流量情绪分析模块（插件版）
实现情绪指数、情绪分类、流量阶段判断、情绪动量计算
"""
import logging
from datetime import datetime
from typing import Dict, List, Optional, Tuple
import statistics

logger = logging.getLogger(__name__)


class SentimentAnalyzer:
    """情绪分析器"""

    def __init__(self):
        self.sentiment_thresholds = {
            'extremely_pessimistic': 20,
            'pessimistic': 40,
            'neutral': 60,
            'optimistic': 80,
            'extremely_optimistic': 100,
        }

        self.flow_stages = {
            'startup': '启动',
            'acceleration': '加速',
            'divergence': '分歧',
            'consensus': '一致',
            'decline': '退潮',
        }

        self.stage_thresholds = {
            'startup_growth': 0.20,
            'acceleration_growth': 0.20,
            'divergence_volatility': 0.30,
            'consensus_k': 1.5,
            'decline_growth': -0.20,
        }

        self.positive_keywords = [
            '利好', '大涨', '暴涨', '涨停', '新高', '突破', '牛市',
            '反弹', '加仓', '买入', '增持', '推荐', '看好', '机遇',
            '政策支持', '业绩预增', '超预期', '景气度', '高增长',
        ]

        self.negative_keywords = [
            '利空', '大跌', '暴跌', '跌停', '新低', '破位', '熊市',
            '回调', '减仓', '卖出', '减持', '风险', '看空', '危机',
            '政策收紧', '业绩下滑', '不及预期', '亏损', '退市',
        ]

    def calculate_sentiment_index(self, platforms_data: List[Dict], stock_news: List[Dict] = None) -> Dict:
        """
        计算情绪指数（0-100）
        
        基于：流量规模(40%) + 财经平台活跃度(30%) + 正负面关键词比例(30%)
        """
        total_news = 0
        finance_news = 0

        for platform_data in platforms_data:
            if not platform_data.get('success'):
                continue
            count = platform_data.get('count', 0)
            total_news += count
            if platform_data.get('category') == 'finance':
                finance_news += count

        if total_news >= 500:
            flow_factor = 90
        elif total_news >= 300:
            flow_factor = 70
        elif total_news >= 150:
            flow_factor = 50
        elif total_news >= 50:
            flow_factor = 30
        else:
            flow_factor = 10

        if total_news > 0:
            finance_ratio = finance_news / total_news
            finance_factor = min(int(finance_ratio * 200), 100)
        else:
            finance_factor = 50

        positive_count = 0
        negative_count = 0
        if stock_news:
            for news in stock_news:
                title = news.get('title', '')
                content = news.get('content', '')
                text = f"{title} {content}"
                for kw in self.positive_keywords:
                    if kw in text:
                        positive_count += 1
                        break
                for kw in self.negative_keywords:
                    if kw in text:
                        negative_count += 1
                        break

        total_sentiment_news = positive_count + negative_count
        if total_sentiment_news > 0:
            positive_ratio = positive_count / total_sentiment_news
            keyword_factor = int(positive_ratio * 100)
        else:
            keyword_factor = 50

        sentiment_index = int(flow_factor * 0.4 + finance_factor * 0.3 + keyword_factor * 0.3)
        sentiment_index = max(0, min(100, sentiment_index))
        sentiment_class = self.classify_sentiment(sentiment_index)
        analysis = self._generate_sentiment_analysis(sentiment_index, sentiment_class, flow_factor, finance_factor, keyword_factor)

        return {
            'sentiment_index': sentiment_index,
            'flow_factor': flow_factor,
            'finance_factor': finance_factor,
            'keyword_factor': keyword_factor,
            'positive_count': positive_count,
            'negative_count': negative_count,
            'sentiment_class': sentiment_class,
            'analysis': analysis,
        }

    def classify_sentiment(self, index: int) -> str:
        """情绪分类"""
        if index < 20:
            return "极度悲观"
        elif index < 40:
            return "悲观"
        elif index < 60:
            return "中性"
        elif index < 80:
            return "乐观"
        else:
            return "极度乐观"

    def _generate_sentiment_analysis(self, index: int, sentiment_class: str, flow: int, finance: int, keyword: int) -> str:
        """生成情绪分析文本"""
        if sentiment_class == "极度乐观":
            return f"情绪指数{index}，市场极度乐观！流量爆发({flow})，财经活跃({finance})。警告：可能是情绪顶部，注意获利了结。"
        elif sentiment_class == "乐观":
            return f"情绪指数{index}，市场情绪乐观。题材正在发酵，可关注龙头机会，但需注意节奏。"
        elif sentiment_class == "中性":
            return f"情绪指数{index}，市场情绪中性。缺乏明确方向，建议观望为主。"
        elif sentiment_class == "悲观":
            return f"情绪指数{index}，市场情绪偏悲观。负面因素较多，控制仓位，等待转机。"
        else:
            return f"情绪指数{index}，市场极度悲观！恐慌情绪蔓延。可能是超跌机会，但需谨慎左侧布局。"

    def determine_flow_stage(self, history_scores: List[int], current_score: int, current_k: float = None) -> Dict:
        """判断流量阶段"""
        if len(history_scores) < 3:
            return {
                'stage': 'unknown', 'stage_name': '未知', 'confidence': 0,
                'signal': '观察', 'analysis': '历史数据不足，继续观察积累数据',
            }

        all_scores = history_scores + [current_score]
        growth_rates = []
        for i in range(1, len(all_scores)):
            if all_scores[i - 1] > 0:
                rate = (all_scores[i] - all_scores[i - 1]) / all_scores[i - 1]
                growth_rates.append(rate)

        recent_growth_rates = growth_rates[-3:] if len(growth_rates) >= 3 else growth_rates
        avg_growth = sum(recent_growth_rates) / len(recent_growth_rates) if recent_growth_rates else 0

        if len(recent_growth_rates) >= 2:
            volatility = statistics.stdev(recent_growth_rates)
        else:
            volatility = 0

        if current_k is None and len(all_scores) >= 2:
            previous_score = all_scores[-2]
            current_k = current_score / previous_score if previous_score > 0 else 1.0
        elif current_k is None:
            current_k = 1.0

        positive_count = sum(1 for r in recent_growth_rates if r > 0)
        negative_count = sum(1 for r in recent_growth_rates if r < 0)

        stage = 'unknown'
        stage_name = '未知'
        confidence = 50
        signal = '观察'
        analysis = ''

        if current_k >= 1.5 and avg_growth > 0.3:
            stage = 'consensus'
            stage_name = '一致'
            confidence = 90
            signal = '危险'
            analysis = f"流量高潮！K值={current_k:.2f}，增速{avg_growth*100:.1f}%。市场一致看多，这往往是顶部信号。立即减仓或清仓！"
        elif negative_count >= 2 and avg_growth < -0.15:
            stage = 'decline'
            stage_name = '退潮'
            confidence = 85
            signal = '离场'
            analysis = f"流量退潮！连续下降，增速{avg_growth*100:.1f}%。题材热度消退，及时止盈止损，不要恋战。"
        elif volatility > 0.25 and positive_count > 0 and negative_count > 0:
            stage = 'divergence'
            stage_name = '分歧'
            confidence = 75
            signal = '谨慎'
            analysis = f"多空分歧！波动率{volatility*100:.1f}%，市场观点不一。高抛低吸，控制仓位，设好止损。"
        elif avg_growth > 0.2 and current_k > 1.1 and positive_count >= 2:
            stage = 'acceleration'
            stage_name = '加速'
            confidence = 80
            signal = '参与'
            analysis = f"流量加速！增速{avg_growth*100:.1f}%，K值{current_k:.2f}。题材正在快速发酵，可参与龙头，但注意仓位。"
        elif avg_growth > 0.05 and positive_count >= 2:
            stage = 'startup'
            stage_name = '启动'
            confidence = 70
            signal = '关注'
            analysis = f"流量启动！增速{avg_growth*100:.1f}%，题材刚开始发酵。可以关注，等待确认后介入。"
        else:
            stage = 'stable'
            stage_name = '平稳'
            confidence = 60
            signal = '观察'
            analysis = f"流量平稳。增速{avg_growth*100:.1f}%，无明显趋势。保持观望，等待方向明确。"

        return {
            'stage': stage, 'stage_name': stage_name, 'confidence': confidence,
            'signal': signal, 'analysis': analysis,
            'avg_growth': round(avg_growth * 100, 1),
            'volatility': round(volatility * 100, 1),
            'current_k': round(current_k, 2),
        }

    def calculate_momentum(self, history_data: List[Dict]) -> Dict:
        """计算情绪动量"""
        if len(history_data) < 3:
            return {'momentum': 1.0, 'momentum_level': '正常', 'trend': '数据不足', 'analysis': '历史数据不足，无法计算动量'}

        sentiment_values = [d.get('sentiment_index', 50) for d in history_data]
        changes = []
        for i in range(1, len(sentiment_values)):
            change = sentiment_values[i] - sentiment_values[i - 1]
            changes.append(abs(change))

        avg_change = sum(changes) / len(changes) if changes else 1
        current_change = abs(changes[-1]) if changes else 0
        momentum = round(current_change / avg_change, 2) if avg_change > 0 else 1.0

        if momentum >= 2.0:
            momentum_level = '极高'
            trend = '急剧变化'
            analysis = f"情绪动量{momentum}，情绪正在急剧变化！市场可能出现转折点，密切关注。"
        elif momentum >= 1.5:
            momentum_level = '高'
            trend = '加速变化'
            analysis = f"情绪动量{momentum}，情绪变化正在加速。趋势可能强化或反转。"
        elif momentum >= 0.8:
            momentum_level = '正常'
            trend = '稳定'
            analysis = f"情绪动量{momentum}，情绪变化平稳，市场处于正常状态。"
        elif momentum >= 0.3:
            momentum_level = '低'
            trend = '减速'
            analysis = f"情绪动量{momentum}，情绪变化正在减速，可能进入盘整期。"
        else:
            momentum_level = '极低'
            trend = '停滞'
            analysis = f"情绪动量{momentum}，情绪几乎没有变化，市场陷入僵局。"

        if len(sentiment_values) >= 2:
            direction = sentiment_values[-1] - sentiment_values[-2]
            if direction > 0:
                trend += "（向上）"
            elif direction < 0:
                trend += "（向下）"

        return {
            'momentum': momentum, 'momentum_level': momentum_level, 'trend': trend,
            'current_change': current_change, 'avg_change': round(avg_change, 1), 'analysis': analysis,
        }

    def run_full_sentiment_analysis(self, platforms_data: List[Dict], stock_news: List[Dict],
                                    history_scores: List[int], current_score: int,
                                    history_sentiments: List[Dict] = None) -> Dict:
        """运行完整的情绪分析"""
        sentiment = self.calculate_sentiment_index(platforms_data, stock_news)
        flow_stage = self.determine_flow_stage(history_scores, current_score)

        if history_sentiments and len(history_sentiments) >= 3:
            momentum = self.calculate_momentum(history_sentiments)
        else:
            momentum = {'momentum': 1.0, 'momentum_level': '正常', 'trend': '数据不足', 'analysis': '历史情绪数据不足'}

        risk_level, advice = self._assess_risk(sentiment, flow_stage, momentum)
        summary = self._generate_summary(sentiment, flow_stage, momentum, risk_level)

        return {
            'sentiment': sentiment, 'flow_stage': flow_stage, 'momentum': momentum,
            'summary': summary, 'risk_level': risk_level, 'advice': advice,
            'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        }

    def _assess_risk(self, sentiment: Dict, flow_stage: Dict, momentum: Dict) -> Tuple[str, str]:
        """综合风险评估"""
        risk_score = 0
        sentiment_index = sentiment['sentiment_index']
        if sentiment_index > 85:
            risk_score += 3
        elif sentiment_index < 25:
            risk_score += 2

        stage = flow_stage['stage']
        if stage == 'consensus':
            risk_score += 4
        elif stage == 'decline':
            risk_score += 3
        elif stage == 'divergence':
            risk_score += 2

        if momentum['momentum'] > 2.0:
            risk_score += 2

        if risk_score >= 7:
            return "极高", "立即减仓或清仓！市场处于极端状态，控制风险为第一要务。"
        elif risk_score >= 5:
            return "高", "谨慎操作，建议减仓。不追高，设置严格止损。"
        elif risk_score >= 3:
            return "中等", "正常操作，注意仓位控制。逢高减仓，逢低观察。"
        elif risk_score >= 1:
            return "低", "可适度参与，关注龙头机会。"
        else:
            return "极低", "风险较低，可积极参与，但仍需设置止损。"

    def _generate_summary(self, sentiment: Dict, flow_stage: Dict, momentum: Dict, risk_level: str) -> str:
        """生成综合总结"""
        lines = [
            f"【情绪】{sentiment['sentiment_class']}（{sentiment['sentiment_index']}分）",
            f"【阶段】{flow_stage['stage_name']}期，信号：{flow_stage['signal']}",
            f"【动量】{momentum['momentum_level']}，趋势{momentum['trend']}",
            f"【风险】{risk_level}",
        ]
        return '\n'.join(lines)