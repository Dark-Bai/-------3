"""
新闻流量数据获取模块（插件版）
从新闻流量数据获取器提取的核心功能，无外部依赖（除requests）
"""
import requests
import logging
from datetime import datetime
from typing import Dict, List, Optional
import time
from collections import Counter

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class NewsFlowDataFetcher:
    """新闻流量数据获取器（插件独立版）"""

    def __init__(self):
        self.base_url = "https://orz.ai/api/v1/dailynews/"
        self.timeout = 10

        # 支持的平台配置 - 22个平台
        self.platforms = {
            'weibo': {'name': '微博热搜', 'category': 'social', 'weight': 10, 'influence': 'high'},
            'douyin': {'name': '抖音热点', 'category': 'social', 'weight': 9, 'influence': 'high'},
            'zhihu': {'name': '知乎热榜', 'category': 'social', 'weight': 7, 'influence': 'medium'},
            'bilibili': {'name': '哔哩哔哩', 'category': 'social', 'weight': 6, 'influence': 'medium'},
            'xiaohongshu': {'name': '小红书', 'category': 'social', 'weight': 7, 'influence': 'medium'},
            'kuaishou': {'name': '快手', 'category': 'social', 'weight': 6, 'influence': 'medium'},
            'tieba': {'name': '百度贴吧', 'category': 'social', 'weight': 5, 'influence': 'low'},
            'weixin': {'name': '微信热点', 'category': 'social', 'weight': 8, 'influence': 'high'},
            'baidu': {'name': '百度热搜', 'category': 'news', 'weight': 8, 'influence': 'high'},
            'jinritoutiao': {'name': '今日头条', 'category': 'news', 'weight': 7, 'influence': 'high'},
            'tenxunwang': {'name': '腾讯网', 'category': 'news', 'weight': 6, 'influence': 'medium'},
            'netease': {'name': '网易新闻', 'category': 'news', 'weight': 6, 'influence': 'medium'},
            'ifeng': {'name': '凤凰网', 'category': 'news', 'weight': 5, 'influence': 'medium'},
            'sina': {'name': '新浪新闻', 'category': 'news', 'weight': 6, 'influence': 'medium'},
            'sina_finance': {'name': '新浪财经', 'category': 'finance', 'weight': 9, 'influence': 'high'},
            'eastmoney': {'name': '东方财富', 'category': 'finance', 'weight': 9, 'influence': 'high'},
            'xueqiu': {'name': '雪球', 'category': 'finance', 'weight': 8, 'influence': 'high'},
            'cls': {'name': '财联社', 'category': 'finance', 'weight': 8, 'influence': 'high'},
            'wallstreetcn': {'name': '华尔街见闻', 'category': 'finance', 'weight': 7, 'influence': 'medium'},
            'tskr': {'name': '36氪', 'category': 'tech', 'weight': 6, 'influence': 'medium'},
            'sspai': {'name': '少数派', 'category': 'tech', 'weight': 5, 'influence': 'low'},
            'juejin': {'name': '掘金', 'category': 'tech', 'weight': 5, 'influence': 'low'},
        }

        self.category_weights = {
            'finance': 1.5,
            'social': 1.2,
            'news': 1.0,
            'tech': 0.8,
        }

        self.stop_words = {
            '的', '是', '在', '了', '和', '与', '等', '为', '将', '被',
            '有', '一', '个', '上', '下', '中', '大', '新', '年', '月', '日',
            '这', '那', '其', '之', '也', '要', '就', '不', '我', '你', '他',
            '来', '去', '到', '说', '会', '能', '都', '对', '着', '让',
            '从', '以', '及', '或', '如', '还', '没', '很', '更', '最',
        }

    def get_platform_news(self, platform: str) -> Dict:
        """获取单个平台的新闻数据"""
        try:
            url = f"{self.base_url}?platform={platform}"
            logger.info(f"正在获取 {platform} 平台数据...")
            response = requests.get(url, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()

            if data.get('status') == '200':
                news_list = data.get('data', [])
                platform_info = self.platforms.get(platform, {})
                for i, news in enumerate(news_list):
                    news['rank'] = i + 1
                    news['platform'] = platform

                return {
                    'success': True,
                    'platform': platform,
                    'platform_name': platform_info.get('name', platform),
                    'category': platform_info.get('category', 'other'),
                    'weight': platform_info.get('weight', 5),
                    'influence': platform_info.get('influence', 'medium'),
                    'data': news_list,
                    'count': len(news_list),
                    'fetch_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                }
            else:
                return {'success': False, 'platform': platform, 'error': f"API返回错误: {data.get('msg', '未知错误')}"}

        except requests.exceptions.Timeout:
            return {'success': False, 'platform': platform, 'error': f"请求超时（{self.timeout}秒）"}
        except requests.exceptions.ConnectionError:
            return {'success': False, 'platform': platform, 'error': "网络连接失败"}
        except Exception as e:
            return {'success': False, 'platform': platform, 'error': f"获取数据失败: {str(e)}"}

    def get_multi_platform_news(self, platforms: List[str] = None, category: str = None) -> Dict:
        """获取多个平台的新闻数据"""
        if platforms is None:
            if category:
                target_platforms = [p for p, info in self.platforms.items() if info.get('category') == category]
            else:
                target_platforms = list(self.platforms.keys())
        else:
            target_platforms = platforms

        results = []
        success_count = 0
        failed_count = 0

        for platform in target_platforms:
            result = self.get_platform_news(platform)
            results.append(result)
            if result['success']:
                success_count += 1
            else:
                failed_count += 1
            time.sleep(0.3)

        return {
            'success': success_count > 0,
            'total_platforms': len(target_platforms),
            'success_count': success_count,
            'failed_count': failed_count,
            'platforms_data': results,
            'fetch_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        }

    def extract_stock_related_news(self, platforms_data: List[Dict], keywords: List[str] = None) -> List[Dict]:
        """从新闻数据中提取股票相关的新闻"""
        if keywords is None:
            keywords = [
                '股', '股市', '股票', 'A股', '港股', '美股', '创业板', '科创板', '北交所',
                '涨停', '跌停', '大涨', '暴涨', '飙升', '暴跌', '涨幅', '跌幅', '翻倍',
                '概念股', '龙头股', '妖股', '题材股', '白马股', '蓝筹股', '成长股',
                '上市', 'IPO', '重组', '并购', '收购', '增发', '回购', '减持', '增持',
                '业绩', '财报', '利好', '利空', '预增', '预减', '盈利', '亏损',
                '牛市', '熊市', '反弹', '回调', '震荡', '突破', '新高',
                '主力', '游资', '北向资金', '外资', '机构', '资金流入', '资金流出',
                '板块', '行业', '赛道', '题材', '轮动', '热点',
                '芯片', '半导体', '新能源', '锂电', '光伏', '储能', 'AI', '人工智能',
                '机器人', '医药', '消费', '军工', '汽车', '地产', '金融', '政策',
            ]

        stock_related = []
        for platform_data in platforms_data:
            if not platform_data.get('success'):
                continue
            platform = platform_data['platform']
            platform_name = platform_data['platform_name']
            category = platform_data['category']
            weight = platform_data['weight']
            influence = platform_data.get('influence', 'medium')

            for news in platform_data.get('data', []):
                title = news.get('title') or ''
                content = news.get('content') or ''
                rank = news.get('rank', 99)
                text = f"{title} {content}"
                matched_keywords = [kw for kw in keywords if kw in text]

                if matched_keywords:
                    rank_score = max(0, 100 - rank * 2)
                    weight_score = weight * 10
                    keyword_score = len(matched_keywords) * 5
                    total_score = rank_score + weight_score + keyword_score

                    stock_related.append({
                        'platform': platform,
                        'platform_name': platform_name,
                        'category': category,
                        'weight': weight,
                        'influence': influence,
                        'rank': rank,
                        'title': title,
                        'content': content,
                        'url': news.get('url') or '',
                        'source': news.get('source') or platform_name,
                        'publish_time': news.get('publish_time') or '',
                        'matched_keywords': matched_keywords,
                        'keyword_count': len(matched_keywords),
                        'score': total_score,
                    })

        stock_related.sort(key=lambda x: x['score'], reverse=True)
        return stock_related

    def calculate_flow_score(self, platforms_data: List[Dict]) -> Dict:
        """计算流量得分"""
        scores = {'social': 0, 'news': 0, 'finance': 0, 'tech': 0}
        platform_details = []

        for platform_data in platforms_data:
            if not platform_data.get('success'):
                continue
            category = platform_data['category']
            weight = platform_data['weight']
            count = platform_data['count']
            platform_name = platform_data['platform_name']
            score = weight * count
            scores[category] = scores.get(category, 0) + score
            platform_details.append({
                'platform': platform_data['platform'],
                'platform_name': platform_name,
                'category': category,
                'count': count,
                'score': score,
            })

        total_score = sum(scores.values())
        normalized_score = min(int(total_score / 50), 1000) if total_score > 0 else 0

        if normalized_score >= 800:
            level = "极高"
            analysis = "流量爆发！市场情绪极度活跃，大量新闻热点，存在热点题材炒作机会。建议：密切关注龙头股，注意追高风险。"
        elif normalized_score >= 500:
            level = "高"
            analysis = "流量较高。市场有明确热点，资金活跃度较好。建议：关注热点板块，注意节奏把握。"
        elif normalized_score >= 200:
            level = "中"
            analysis = "流量正常。市场处于常态，有一定热点但不突出。建议：观望为主，等待明确信号。"
        else:
            level = "低"
            analysis = "流量较低。市场情绪低迷，缺乏热点。建议：控制仓位，等待市场转暖。"

        return {
            'total_score': normalized_score,
            'social_score': scores.get('social', 0),
            'news_score': scores.get('news', 0),
            'finance_score': scores.get('finance', 0),
            'tech_score': scores.get('tech', 0),
            'level': level,
            'analysis': analysis,
            'platform_details': platform_details,
        }

    def get_hot_topics(self, platforms_data: List[Dict], top_n: int = 20) -> List[Dict]:
        """获取热门话题（基于标题词频分析）"""
        import jieba

        all_titles = []
        title_sources = {}

        for platform_data in platforms_data:
            if platform_data.get('success'):
                platform_name = platform_data['platform_name']
                for news in platform_data.get('data', []):
                    title = news.get('title') or ''
                    if title:
                        all_titles.append(title)
                        if title not in title_sources:
                            title_sources[title] = []
                        title_sources[title].append(platform_name)

        word_counter = Counter()
        word_sources = {}

        for title in all_titles:
            if title:
                words = jieba.cut(title)
                for word in words:
                    if len(word) >= 2 and word not in self.stop_words:
                        word_counter[word] += 1
                        if word not in word_sources:
                            word_sources[word] = set()
                        for source in title_sources.get(title, []):
                            word_sources[word].add(source)

        hot_topics = []
        total_titles = len(all_titles) if all_titles else 1

        for word, count in word_counter.most_common(top_n):
            sources = list(word_sources.get(word, []))
            cross_platform = len(sources)
            heat = min(int(count / total_titles * 1000), 100)
            if cross_platform >= 5:
                heat = min(heat + 20, 100)
            elif cross_platform >= 3:
                heat = min(heat + 10, 100)

            hot_topics.append({
                'topic': word,
                'count': count,
                'heat': heat,
                'cross_platform': cross_platform,
                'sources': sources[:5],
            })

        return hot_topics

    def get_platform_list(self) -> List[Dict]:
        """获取所有支持的平台列表"""
        result = []
        for code, info in self.platforms.items():
            result.append({
                'code': code,
                'name': info['name'],
                'category': info['category'],
                'weight': info['weight'],
                'influence': info.get('influence', 'medium'),
            })
        result.sort(key=lambda x: x['weight'], reverse=True)
        return result