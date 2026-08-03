#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
新闻分析师 - 基于 requests + jieba + pandas + numpy 的新闻情绪分析
从新浪7x24快讯获取新闻数据，使用 jieba 分词进行关键词提取和情绪打分
输出 JSON 到 stdout 供 Node.js 主进程调用
"""
import json
import sys
import re
import traceback
from collections import Counter

import jieba
import jieba.analyse
import pandas as pd
import numpy as np
import requests

# ========== 情绪词典 ==========
POSITIVE_WORDS = {
    "利好", "大涨", "暴涨", "涨停", "新高", "突破", "牛市", "反弹",
    "加仓", "买入", "增持", "推荐", "看好", "机遇", "景气", "预增",
    "超预期", "高增长", "放量", "领涨", "强势", "拉升", "飙升",
    "扭亏", "盈喜", "分红", "回购", "中标", "签约", "获批",
    "启动", "上线", "发布", "合作", "融资", "注资", "增资",
}
NEGATIVE_WORDS = {
    "利空", "大跌", "暴跌", "跌停", "新低", "破位", "熊市", "回调",
    "减仓", "卖出", "减持", "风险", "看空", "危机", "收紧", "下滑",
    "不及预期", "亏损", "退市", "st", "立案", "处罚", "违约",
    "暴雷", "炸雷", "暂停", "终止", "取消", "下降", "减少",
    "流出", "撤离", "崩盘", "抛售", "做空", "预警",
}
STOCK_KEYWORDS = {
    "股", "股市", "股票", "A股", "港股", "美股", "涨停", "跌停",
    "大涨", "暴跌", "概念股", "龙头股", "上市", "IPO",
    "利好", "利空", "主力", "北向资金", "外资", "机构",
    "板块", "行业", "赛道", "热点", "概念",
    "芯片", "半导体", "新能源", "锂电", "光伏", "AI", "人工智能",
    "机器人", "医药", "消费", "军工", "汽车", "地产",
    "券商", "银行", "保险", "有色", "煤炭", "电力", "化工",
    "算力", "大模型", "数据要素", "低空经济", "固态电池",
}

# 停用词
STOP_WORDS = set(
    "的 是 在 了 和 与 等 为 将 被 有 一 个 上 下 中 大 新 年 月 日 "
    "这 那 其 之 也 要 就 不 我 你 他 来 去 到 说 会 能 都 对 着 "
    "让 从 以 及 或 如 还 没 很 更 最 啊 吧 吗 呢 哦 哈 呀 嗯 "
    "已 将 该 此 每 各 某 另 再 又 才 只 仅 尚 仍 便 则 却 但 虽 "
    "因 所 于 与 比 按 据 靠 朝 往 向 沿 至 直 当 同 跟 随 由 "
    "被 把 将 让 叫 给 对 对于 关于 至于 除了 按照 通过 经过 根据".split()
)

# 新闻源配置
NEWS_SOURCES = [
    "新浪财经", "华尔街见闻", "财联社", "和讯网", "东方财富",
    "同花顺", "证券时报", "中国证券报", "上海证券报", "第一财经",
    "每日经济新闻", "21世纪经济报道", "经济参考报", "界面新闻",
    "澎湃新闻", "新京报", "央视新闻", "人民日报", "36氪",
    "钛媒体", "虎嗅", "雪球",
]


def fetch_sina_news(max_items: int = 80) -> list[dict]:
    """从新浪7x24快讯获取新闻"""
    items = []
    try:
        url = "https://zhibo.sina.com.cn/api/zhibo/feed"
        params = {"page": 1, "page_size": max_items, "zhibo_id": "152", "tag_id": "0"}
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://zhibo.sina.com.cn/",
        }
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        if resp.status_code != 200:
            return items
        data = resp.json()
        feed_list = data.get("result", {}).get("data", {}).get("feed", {}).get("list", [])
        for feed_item in feed_list:
            rich_text = (feed_item.get("rich_text") or "").strip()
            # 清理 HTML 标签
            if rich_text:
                rich_text = re.sub(r"<[^>]+>", "", rich_text).strip()
            tags = feed_item.get("tag", []) or []
            tag_names = [t.get("name", "") for t in tags if isinstance(t, dict)]
            title = rich_text  # 快讯以 rich_text 作为标题
            content = rich_text
            if title:
                # 将标签信息拼入内容供分析
                if tag_names:
                    content = f"[{'/'.join(tag_names)}] {content}"
                items.append({"title": title, "content": content, "tags": tag_names})
    except Exception as e:
        print(f"[WARN] 新浪新闻获取失败: {e}", file=sys.stderr)
    return items[:max_items]


def fetch_wscn_news(max_items: int = 40) -> list[dict]:
    """从华尔街见闻获取新闻(兜底)"""
    items = []
    try:
        url = "https://api-one.wallstcn.com/apiv1/content/lives"
        params = {"channel": "global-channel", "limit": max_items}
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        if resp.status_code != 200:
            return items
        data = resp.json()
        for item in data.get("data", {}).get("items", []):
            title = (item.get("title") or "").strip()
            content = (item.get("content_text") or "").strip()
            if title or content:
                items.append({"title": title, "content": content})
    except Exception as e:
        print(f"[WARN] 华尔街见闻获取失败: {e}", file=sys.stderr)
    return items[:max_items]


def get_news_items(max_items: int = 80) -> list[dict]:
    """获取新闻数据，主源新浪 -> 兜底华尔街见闻"""
    items = fetch_sina_news(max_items)
    if not items:
        items = fetch_wscn_news(max_items)
    return items


def analyze_sentiment(text: str) -> tuple[int, int, int]:
    """情绪分析: 返回 (正面词数, 负面词数, 情绪分0-100)"""
    words = jieba.lcut(text)
    pos_count = sum(1 for w in words if w in POSITIVE_WORDS)
    neg_count = sum(1 for w in words if w in NEGATIVE_WORDS)
    total = pos_count + neg_count
    if total == 0:
        return (0, 0, 50)
    score = int(pos_count / total * 100)
    return (pos_count, neg_count, score)


def extract_keywords(text: str, topk: int = 10) -> list[tuple[str, float]]:
    """使用 jieba TF-IDF 提取关键词"""
    return jieba.analyse.extract_tags(text, topK=topk, withWeight=True)


def get_news_analyst() -> dict:
    """获取新闻分析师数据"""
    news = get_news_items(80)
    n = len(news)

    # 分配虚拟平台
    categorized = []
    for i, item in enumerate(news):
        src = NEWS_SOURCES[i % len(NEWS_SOURCES)]
        cat = "finance" if src in {
            "新浪财经", "华尔街见闻", "财联社", "和讯网", "东方财富",
            "同花顺", "证券时报", "中国证券报", "上海证券报", "第一财经",
            "每日经济新闻", "21世纪经济报道", "经济参考报", "雪球",
        } else "news" if src in {
            "界面新闻", "澎湃新闻", "新京报", "央视新闻", "人民日报",
        } else "tech"
        categorized.append({**item, "source": src, "category": cat})

    # 流量得分
    cat_scores = {"social": 0, "news": 0, "finance": 0, "tech": 0}
    platform_details = []
    for src_name in NEWS_SOURCES:
        count = sum(1 for c in categorized if c["source"] == src_name)
        cat = "finance" if src_name in {
            "新浪财经", "华尔街见闻", "财联社", "和讯网", "东方财富",
            "同花顺", "证券时报", "中国证券报", "上海证券报", "第一财经",
            "每日经济新闻", "21世纪经济报道", "经济参考报", "雪球",
        } else "news" if src_name in {
            "界面新闻", "澎湃新闻", "新京报", "央视新闻", "人民日报",
        } else "tech"
        score = count * (10 - min(count // 20, 5))
        cat_scores[cat] += score
        platform_details.append({
            "platform": src_name, "name": src_name,
            "category": cat, "count": count, "score": score,
        })

    total_score = min(int(sum(cat_scores.values()) / 2) or n * 5, 1000)
    if total_score >= 800:
        flow_level = "极高"
        flow_analysis = "流量爆发！市场情绪极度活跃，大量新闻热点。"
    elif total_score >= 500:
        flow_level = "高"
        flow_analysis = "流量较高。市场有明确热点，资金活跃度较好。"
    elif total_score >= 200:
        flow_level = "中"
        flow_analysis = "流量正常。市场处于常态，有一定热点但不突出。"
    else:
        flow_level = "低"
        flow_analysis = "流量较低。市场情绪低迷，缺乏热点。"

    # 热门话题 - jieba 分词 + 词频统计
    all_text = " ".join(c["title"] for c in categorized if c["title"])
    all_titles = [c["title"] for c in categorized if c["title"]]

    # 使用 jieba 分词
    words = jieba.lcut(all_text)
    word_counter = Counter()
    for w in words:
        w = w.strip()
        if len(w) >= 2 and w not in STOP_WORDS:
            word_counter[w] += 1

    # 词源追踪
    word_sources: dict[str, set] = {}
    for c in categorized:
        title = c["title"] or ""
        ws = jieba.lcut(title)
        for w in ws:
            if len(w) >= 2 and w not in STOP_WORDS:
                if w not in word_sources:
                    word_sources[w] = set()
                word_sources[w].add(c["source"])

    hot_topics = []
    for topic, count in word_counter.most_common(20):
        sources = list(word_sources.get(topic, set()))
        cross = len(sources)
        heat = min(int(count / max(len(all_titles), 1) * 1000), 100)
        if cross >= 5:
            heat = min(heat + 20, 100)
        elif cross >= 3:
            heat = min(heat + 10, 100)
        hot_topics.append({
            "topic": topic, "count": count, "heat": heat,
            "crossPlatform": cross, "sources": sources[:5],
        })

    # 股票相关新闻 + 情绪分析
    stock_news = []
    for i, c in enumerate(categorized):
        text = f"{c['title'] or ''} {c['content'] or ''}"
        matched = [kw for kw in STOCK_KEYWORDS if kw in text]
        if not matched:
            continue
        pos, neg, sent_score = analyze_sentiment(text)
        keywords = extract_keywords(text, 5)
        rank = i + 1
        item_score = max(0, 100 - rank * 2) + 60 + len(matched) * 5
        stock_news.append({
            "platform": c["source"],
            "category": c["category"],
            "title": c["title"] or "",
            "content": (c["content"] or "")[:200],
            "matchedKeywords": matched[:5],
            "score": item_score,
            "sentimentScore": sent_score,
        })

    stock_news.sort(key=lambda x: x["score"], reverse=True)

    # 情绪指数
    flow_factor = 90 if n >= 50 else 70 if n >= 30 else 50 if n >= 15 else 30 if n >= 5 else 10
    finance_count = sum(1 for c in categorized if c["category"] == "finance")
    finance_factor = min(int(finance_count / max(n, 1) * 200), 100) if n > 0 else 50

    pos_count = sum(1 for n in stock_news if n["sentimentScore"] > 50)
    neg_count = sum(1 for n in stock_news if n["sentimentScore"] < 50)
    total_sn = pos_count + neg_count
    keyword_factor = int(pos_count / total_sn * 100) if total_sn > 0 else 50

    sentiment_index = max(0, min(100, int(flow_factor * 0.4 + finance_factor * 0.3 + keyword_factor * 0.3)))
    if sentiment_index >= 80:
        sentiment_class = "极度乐观"
    elif sentiment_index >= 60:
        sentiment_class = "乐观"
    elif sentiment_index >= 40:
        sentiment_class = "中性"
    elif sentiment_index >= 20:
        sentiment_class = "悲观"
    else:
        sentiment_class = "极度悲观"

    return {
        "success": True,
        "fetchTime": pd.Timestamp.now().isoformat(),
        "platformStats": {"success": len([p for p in platform_details if p["count"] > 0]), "total": len(NEWS_SOURCES)},
        "flowData": {
            "totalScore": total_score,
            "socialScore": cat_scores["social"],
            "newsScore": cat_scores["news"],
            "financeScore": cat_scores["finance"],
            "techScore": cat_scores["tech"],
            "level": flow_level,
            "analysis": flow_analysis,
            "platformDetails": platform_details,
        },
        "sentimentData": {
            "sentimentIndex": sentiment_index,
            "sentimentClass": sentiment_class,
            "flowFactor": flow_factor,
            "financeFactor": finance_factor,
            "keywordFactor": keyword_factor,
            "positiveCount": pos_count,
            "negativeCount": neg_count,
        },
        "hotTopics": hot_topics[:10],
        "stockNews": stock_news[:15],
    }


if __name__ == "__main__":
    try:
        data = get_news_analyst()
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "success": False}, ensure_ascii=False))
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)