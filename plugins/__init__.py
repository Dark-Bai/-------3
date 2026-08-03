"""
插件系统入口
提供统一的插件加载和管理接口
"""

from typing import Dict, Any, Optional
import importlib


def get_plugin(name: str, **kwargs) -> Any:
    """
    获取指定名称的插件实例
    
    Args:
        name: 插件名称，可选 'news_analyst' / 'market_sentiment'
        **kwargs: 传递给插件构造函数的参数
    
    Returns:
        插件实例对象
    
    Raises:
        ValueError: 插件名称不支持
    """
    plugin_map = {
        'news_analyst': 'plugins.news_analyst.plugin',
        'market_sentiment': 'plugins.market_sentiment.plugin',
    }
    
    if name not in plugin_map:
        raise ValueError(f"不支持的插件: {name}，可选: {list(plugin_map.keys())}")
    
    module_path = plugin_map[name]
    module = importlib.import_module(module_path)
    plugin_class = getattr(module, 'Plugin')
    return plugin_class(**kwargs)


def list_plugins() -> Dict[str, str]:
    """列出所有可用的插件"""
    return {
        'news_analyst': '新闻分析师 - 基于多平台新闻流量数据的市场情绪分析',
        'market_sentiment': '市场情绪分析师 - 基于ARBR/换手率/涨跌停等指标的市场情绪分析',
    }