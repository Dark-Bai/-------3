"""
市场情绪数据获取和计算模块（插件版）
使用akshare获取市场情绪相关指标，包括ARBR、恐慌指数、市场资金情绪等
不依赖主项目的自定义模块，可独立使用
"""
import pandas as pd
import numpy as np
import akshare as ak
from datetime import datetime, timedelta
import warnings
from typing import Dict, Optional, List

warnings.filterwarnings('ignore')


class MarketSentimentDataFetcher:
    """市场情绪数据获取和计算类（插件独立版）"""

    def __init__(self):
        self.arbr_period = 26  # ARBR计算周期

    def get_market_sentiment_data(self, symbol: str, stock_data: Optional[pd.DataFrame] = None) -> Dict:
        """
        获取完整的市场情绪分析数据
        
        Args:
            symbol: 股票代码（6位数字）
            stock_data: 股票历史数据（如果已有）
            
        Returns:
            dict: 包含各类市场情绪指标的字典
        """
        sentiment_data = {
            "symbol": symbol,
            "arbr_data": None,
            "market_index": None,
            "sector_index": None,
            "turnover_rate": None,
            "limit_up_down": None,
            "margin_trading": None,
            "fear_greed_index": None,
            "data_success": False
        }

        try:
            is_chinese = self._is_chinese_stock(symbol)

            if is_chinese:
                # 1. ARBR指标
                arbr_data = self._calculate_arbr(symbol, stock_data)
                if arbr_data:
                    sentiment_data["arbr_data"] = arbr_data

                # 2. 换手率
                turnover_data = self._get_turnover_rate(symbol)
                if turnover_data:
                    sentiment_data["turnover_rate"] = turnover_data

                # 3. 大盘情绪
                market_data = self._get_market_index_sentiment()
                if market_data:
                    sentiment_data["market_index"] = market_data

                # 4. 涨跌停
                limit_data = self._get_limit_up_down_stats()
                if limit_data:
                    sentiment_data["limit_up_down"] = limit_data

                # 5. 融资融券
                margin_data = self._get_margin_trading_data(symbol)
                if margin_data:
                    sentiment_data["margin_trading"] = margin_data

                # 6. 恐慌贪婪指数
                fear_greed = self._get_fear_greed_index()
                if fear_greed:
                    sentiment_data["fear_greed_index"] = fear_greed

                sentiment_data["data_success"] = True
            else:
                sentiment_data["error"] = "美股暂不支持完整的市场情绪数据"

        except Exception as e:
            sentiment_data["error"] = str(e)

        return sentiment_data

    def _is_chinese_stock(self, symbol: str) -> bool:
        """判断是否为中国股票"""
        return symbol.isdigit() and len(symbol) == 6

    def _calculate_arbr(self, symbol: str, stock_data: Optional[pd.DataFrame] = None) -> Optional[Dict]:
        """
        计算ARBR指标
        AR = (N日内(H-O)之和 / N日内(O-L)之和) × 100
        BR = (N日内(H-CY)之和 / N日内(CY-L)之和) × 100
        """
        try:
            if stock_data is None or stock_data.empty:
                end_date = datetime.now().strftime('%Y%m%d')
                start_date = (datetime.now() - timedelta(days=150)).strftime('%Y%m%d')
                df = ak.stock_zh_a_hist(symbol=symbol, period="daily",
                                        start_date=start_date, end_date=end_date, adjust="qfq")
                if df is None or df.empty:
                    return None
                # 统一列名
                df = df.rename(columns={
                    '开盘': 'open', '收盘': 'close', '最高': 'high', '最低': 'low',
                    '成交量': 'volume', '日期': 'date'
                })
            else:
                df = stock_data.copy()
                if 'Open' in df.columns:
                    df = df.rename(columns={'Open': 'open', 'Close': 'close', 'High': 'high', 'Low': 'low', 'Volume': 'volume'})
                df = df.reset_index()
                if 'Date' in df.columns:
                    df = df.rename(columns={'Date': 'date'})

            if 'date' in df.columns:
                df['date'] = pd.to_datetime(df['date'])

            df['HO'] = (df['high'] - df['open']).clip(lower=0)
            df['OL'] = (df['open'] - df['low']).clip(lower=0)
            df['HCY'] = (df['high'] - df['close'].shift(1)).clip(lower=0)
            df['CYL'] = (df['close'].shift(1) - df['low']).clip(lower=0)

            df['AR'] = (df['HO'].rolling(window=self.arbr_period).sum() /
                        df['OL'].rolling(window=self.arbr_period).sum()) * 100
            df['BR'] = (df['HCY'].rolling(window=self.arbr_period).sum() /
                        df['CYL'].rolling(window=self.arbr_period).sum()) * 100

            df['AR'] = df['AR'].replace([np.inf, -np.inf], np.nan)
            df['BR'] = df['BR'].replace([np.inf, -np.inf], np.nan)
            df = df.dropna(subset=['AR', 'BR'])

            if df.empty:
                return None

            latest = df.iloc[-1]
            ar_value = latest['AR']
            br_value = latest['BR']

            interpretation = self._interpret_arbr(ar_value, br_value)
            signals = self._generate_arbr_signals(ar_value, br_value)

            stats = {
                "ar_mean": df['AR'].mean(), "ar_std": df['AR'].std(),
                "ar_min": df['AR'].min(), "ar_max": df['AR'].max(),
                "br_mean": df['BR'].mean(), "br_std": df['BR'].std(),
                "br_min": df['BR'].min(), "br_max": df['BR'].max(),
            }

            df['ar_signal'] = 0
            df['br_signal'] = 0
            df.loc[df['AR'] > 150, 'ar_signal'] = -1
            df.loc[df['AR'] < 70, 'ar_signal'] = 1
            df.loc[df['BR'] > 300, 'br_signal'] = -1
            df.loc[df['BR'] < 50, 'br_signal'] = 1
            df['combined_signal'] = df['ar_signal'] + df['br_signal']

            buy_signals = len(df[df['combined_signal'] > 0])
            sell_signals = len(df[df['combined_signal'] < 0])

            signal_stats = {
                "buy_signals": buy_signals, "sell_signals": sell_signals,
                "total_signals": len(df),
                "buy_ratio": f"{buy_signals/len(df)*100:.1f}%" if len(df) > 0 else "0%",
                "sell_ratio": f"{sell_signals/len(df)*100:.1f}%" if len(df) > 0 else "0%"
            }

            return {
                "latest_ar": float(ar_value), "latest_br": float(br_value),
                "interpretation": interpretation, "signals": signals,
                "statistics": stats, "signal_statistics": signal_stats,
                "calculation_date": latest.get('date', datetime.now()).strftime('%Y-%m-%d') if pd.notna(latest.get('date')) else datetime.now().strftime('%Y-%m-%d'),
                "period": self.arbr_period
            }

        except Exception as e:
            print(f"计算ARBR指标失败: {e}")
            return None

    def _interpret_arbr(self, ar_value: float, br_value: float) -> List[str]:
        """解读ARBR数值"""
        interpretation = []
        if ar_value > 180:
            interpretation.append("AR极度超买（>180），市场过热，风险极高，建议谨慎")
        elif ar_value > 150:
            interpretation.append("AR超买（>150），市场情绪过热，注意回调风险")
        elif ar_value < 40:
            interpretation.append("AR极度超卖（<40），市场过冷，可能存在机会")
        elif ar_value < 70:
            interpretation.append("AR超卖（<70），市场情绪低迷，可关注反弹机会")
        else:
            interpretation.append(f"AR处于正常区间（{ar_value:.2f}），市场情绪相对平稳")

        if br_value > 400:
            interpretation.append("BR极度超买（>400），投机情绪过热，警惕泡沫")
        elif br_value > 300:
            interpretation.append("BR超买（>300），投机情绪旺盛，注意风险")
        elif br_value < 30:
            interpretation.append("BR极度超卖（<30），投机情绪冰点，可能触底")
        elif br_value < 50:
            interpretation.append("BR超卖（<50），投机情绪低迷，关注企稳信号")
        else:
            interpretation.append(f"BR处于正常区间（{br_value:.2f}），投机情绪适中")

        if ar_value > 100 and br_value > 100:
            interpretation.append("多头力量强劲（AR>100且BR>100），但需警惕过热风险")
        elif ar_value < 100 and br_value < 100:
            interpretation.append("空头力量占优（AR<100且BR<100），市场情绪偏空")

        if ar_value > br_value:
            interpretation.append("人气指标强于意愿指标（AR>BR），市场基础较好，投资者信心相对稳定")
        else:
            interpretation.append("意愿指标强于人气指标（BR>AR），投机性较强，需注意资金稳定性")

        return interpretation

    def _generate_arbr_signals(self, ar_value: float, br_value: float) -> Dict:
        """生成ARBR交易信号"""
        signals = []
        signal_strength = 0

        if ar_value > 150:
            signals.append("AR卖出信号")
            signal_strength -= 1
        elif ar_value < 70:
            signals.append("AR买入信号")
            signal_strength += 1

        if br_value > 300:
            signals.append("BR卖出信号")
            signal_strength -= 1
        elif br_value < 50:
            signals.append("BR买入信号")
            signal_strength += 1

        if signal_strength >= 2:
            overall = "强烈买入信号"
        elif signal_strength == 1:
            overall = "买入信号"
        elif signal_strength == -1:
            overall = "卖出信号"
        elif signal_strength <= -2:
            overall = "强烈卖出信号"
        else:
            overall = "中性信号"

        return {"individual_signals": signals if signals else ["中性"], "overall_signal": overall, "signal_strength": signal_strength}

    def _get_turnover_rate(self, symbol: str) -> Optional[Dict]:
        """获取换手率数据"""
        try:
            df = ak.stock_zh_a_spot_em()
            if df is not None and not df.empty:
                stock_data = df[df['代码'] == symbol]
                if not stock_data.empty:
                    row = stock_data.iloc[0]
                    turnover_rate = row.get('换手率', 'N/A')
                    interpretation = ""
                    if turnover_rate != 'N/A':
                        try:
                            turnover = float(turnover_rate)
                            if turnover > 20:
                                interpretation = "换手率极高（>20%），资金活跃度极高，可能存在炒作"
                            elif turnover > 10:
                                interpretation = "换手率较高（>10%），交易活跃"
                            elif turnover > 5:
                                interpretation = "换手率正常（5%-10%），交易适中"
                            elif turnover > 2:
                                interpretation = "换手率偏低（2%-5%），交易相对清淡"
                            else:
                                interpretation = "换手率很低（<2%），交易清淡"
                        except:
                            pass

                    return {"current_turnover_rate": turnover_rate, "interpretation": interpretation}
        except Exception as e:
            print(f"获取换手率失败: {e}")
        return None

    def _get_market_index_sentiment(self) -> Optional[Dict]:
        """获取大盘指数情绪"""
        try:
            df = ak.stock_zh_index_spot_em(symbol="上证系列指数")
            if df is not None and not df.empty:
                sh_index = df[df['代码'] == '000001']
                if not sh_index.empty:
                    row = sh_index.iloc[0]
                    change_pct = row.get('涨跌幅', 0)
                    result = {"index_name": "上证指数", "change_percent": change_pct}

                    # 获取涨跌家数
                    try:
                        market_summary = ak.stock_zh_a_spot_em()
                        if market_summary is not None and not market_summary.empty:
                            up_count = len(market_summary[market_summary['涨跌幅'] > 0])
                            down_count = len(market_summary[market_summary['涨跌幅'] < 0])
                            total_count = len(market_summary)
                            flat_count = total_count - up_count - down_count
                            sentiment_score = (up_count - down_count) / total_count * 100

                            if sentiment_score > 30:
                                sentiment = "市场情绪极度乐观"
                            elif sentiment_score > 10:
                                sentiment = "市场情绪偏多"
                            elif sentiment_score > -10:
                                sentiment = "市场情绪中性"
                            elif sentiment_score > -30:
                                sentiment = "市场情绪偏空"
                            else:
                                sentiment = "市场情绪极度悲观"

                            result.update({
                                "up_count": up_count, "down_count": down_count,
                                "flat_count": flat_count, "total_count": total_count,
                                "sentiment_score": f"{sentiment_score:.2f}",
                                "sentiment_interpretation": sentiment
                            })
                    except:
                        pass

                    return result
        except Exception as e:
            print(f"获取大盘指数失败: {e}")
        return None

    def _get_limit_up_down_stats(self) -> Optional[Dict]:
        """获取涨跌停统计数据"""
        try:
            today = datetime.now().strftime('%Y%m%d')
            try:
                limit_up_df = ak.stock_zt_pool_em(date=today)
                limit_up_count = len(limit_up_df) if limit_up_df is not None and not limit_up_df.empty else 0
            except:
                limit_up_count = 0

            try:
                limit_down_df = ak.stock_zt_pool_dtgc_em(date=today)
                limit_down_count = len(limit_down_df) if limit_down_df is not None and not limit_down_df.empty else 0
            except:
                limit_down_count = 0

            if limit_up_count + limit_down_count > 0:
                limit_ratio = limit_up_count / (limit_up_count + limit_down_count) * 100
            else:
                limit_ratio = 50

            if limit_ratio > 70:
                interpretation = "涨停股远多于跌停股，市场情绪火热"
            elif limit_ratio > 60:
                interpretation = "涨停股多于跌停股，市场情绪较好"
            elif limit_ratio > 40:
                interpretation = "涨跌停数量相当，市场情绪分化"
            elif limit_ratio > 30:
                interpretation = "跌停股多于涨停股，市场情绪较弱"
            else:
                interpretation = "跌停股远多于涨停股，市场情绪低迷"

            return {
                "limit_up_count": limit_up_count, "limit_down_count": limit_down_count,
                "limit_ratio": f"{limit_ratio:.1f}%", "interpretation": interpretation, "date": today
            }
        except Exception as e:
            print(f"获取涨跌停数据失败: {e}")
        return None

    def _get_margin_trading_data(self, symbol: str) -> Optional[Dict]:
        """获取融资融券数据"""
        try:
            # 获取沪深融资融券明细
            try:
                df = ak.stock_margin_underlying_info_szse(date=datetime.now().strftime('%Y%m%d'))
                if df is not None and not df.empty:
                    stock_data = df[df['证券代码'] == symbol]
                    if not stock_data.empty:
                        latest = stock_data.iloc[0]
                        margin_balance = latest.get('融资余额', 0)
                        short_balance = latest.get('融券余额', 0)
                        interpretation = []
                        if margin_balance > short_balance * 10:
                            interpretation.append("融资余额远大于融券余额，投资者看多情绪强")
                        elif margin_balance > short_balance * 3:
                            interpretation.append("融资余额大于融券余额，投资者偏看多")
                        else:
                            interpretation.append("融资融券相对平衡")
                        return {
                            "margin_balance": margin_balance, "short_balance": short_balance,
                            "interpretation": interpretation, "date": datetime.now().strftime('%Y-%m-%d')
                        }
            except:
                pass

            # 获取融资融券汇总数据
            try:
                df = ak.stock_margin_szsh()
                if df is not None and not df.empty:
                    latest = df.iloc[-1]
                    return {
                        "margin_balance": latest.get('融资余额', 'N/A'),
                        "short_balance": latest.get('融券余额', 'N/A'),
                        "interpretation": ["市场整体融资融券数据"],
                        "date": latest.get('交易日期', 'N/A')
                    }
            except:
                pass

        except Exception as e:
            print(f"获取融资融券数据失败: {e}")
        return None

    def _get_fear_greed_index(self) -> Optional[Dict]:
        """计算市场恐慌贪婪指数"""
        try:
            score = 50
            factors = []

            try:
                market_summary = ak.stock_zh_a_spot_em()
                if market_summary is not None and not market_summary.empty:
                    up_count = len(market_summary[market_summary['涨跌幅'] > 0])
                    down_count = len(market_summary[market_summary['涨跌幅'] < 0])
                    total = len(market_summary)
                    up_ratio = up_count / total
                    score += (up_ratio - 0.5) * 60
                    factors.append(f"涨跌家数比例: {up_ratio:.1%}")
            except:
                pass

            score = max(0, min(100, score))

            if score >= 75:
                level = "极度贪婪"
                interpretation = "市场情绪极度乐观，投资者贪婪，需警惕回调风险"
            elif score >= 60:
                level = "贪婪"
                interpretation = "市场情绪乐观，投资者偏向贪婪"
            elif score >= 40:
                level = "中性"
                interpretation = "市场情绪中性，投资者相对理性"
            elif score >= 25:
                level = "恐慌"
                interpretation = "市场情绪悲观，投资者偏向恐慌"
            else:
                level = "极度恐慌"
                interpretation = "市场情绪极度悲观，投资者恐慌，可能存在超卖机会"

            return {"score": f"{score:.1f}", "level": level, "interpretation": interpretation, "factors": factors}
        except Exception as e:
            print(f"计算恐慌贪婪指数失败: {e}")
        return None

    def format_sentiment_data_for_ai(self, sentiment_data: Dict) -> str:
        """将市场情绪数据格式化为文本"""
        if not sentiment_data or not sentiment_data.get("data_success"):
            return "未能获取市场情绪数据"

        text_parts = []

        if sentiment_data.get("arbr_data"):
            arbr = sentiment_data["arbr_data"]
            text_parts.append(f"""
【ARBR市场情绪指标】
- 计算周期：{arbr.get('period', 26)}日
- AR值：{arbr.get('latest_ar', 'N/A'):.2f}（人气指标）
- BR值：{arbr.get('latest_br', 'N/A'):.2f}（意愿指标）
- 信号：{arbr.get('signals', {}).get('overall_signal', 'N/A')}
- 解读：
{chr(10).join(['  * ' + item for item in arbr.get('interpretation', [])])}
ARBR统计数据：
- AR历史均值：{arbr.get('statistics', {}).get('ar_mean', 0):.2f}
- BR历史均值：{arbr.get('statistics', {}).get('br_mean', 0):.2f}
- 历史买入信号比例：{arbr.get('signal_statistics', {}).get('buy_ratio', 'N/A')}
- 历史卖出信号比例：{arbr.get('signal_statistics', {}).get('sell_ratio', 'N/A')}
""")

        if sentiment_data.get("turnover_rate"):
            turnover = sentiment_data["turnover_rate"]
            text_parts.append(f"""
【换手率数据】
- 当前换手率：{turnover.get('current_turnover_rate', 'N/A')}%
- 解读：{turnover.get('interpretation', 'N/A')}
""")

        if sentiment_data.get("market_index"):
            market = sentiment_data["market_index"]
            text_parts.append(f"""
【大盘市场情绪】
- 指数：{market.get('index_name', 'N/A')}
- 涨跌幅：{market.get('change_percent', 'N/A')}%
""")
            if market.get('sentiment_score'):
                text_parts.append(f"""- 市场情绪得分：{market.get('sentiment_score', 'N/A')}
- 涨家数：{market.get('up_count', 'N/A')}只
- 跌家数：{market.get('down_count', 'N/A')}只
- 市场情绪：{market.get('sentiment_interpretation', 'N/A')}
""")

        if sentiment_data.get("limit_up_down"):
            limit = sentiment_data["limit_up_down"]
            text_parts.append(f"""
【涨跌停统计】
- 涨停股数量：{limit.get('limit_up_count', 0)}只
- 跌停股数量：{limit.get('limit_down_count', 0)}只
- 涨停占比：{limit.get('limit_ratio', 'N/A')}
- 解读：{limit.get('interpretation', 'N/A')}
""")

        if sentiment_data.get("margin_trading"):
            margin = sentiment_data["margin_trading"]
            text_parts.append(f"""
【融资融券数据】
- 融资余额：{margin.get('margin_balance', 'N/A')}元
- 融券余额：{margin.get('short_balance', 'N/A')}元
- 解读：{'; '.join(margin.get('interpretation', []))}
""")

        if sentiment_data.get("fear_greed_index"):
            fg = sentiment_data["fear_greed_index"]
            text_parts.append(f"""
【市场恐慌贪婪指数】
- 指数得分：{fg.get('score', 'N/A')}/100
- 情绪等级：{fg.get('level', 'N/A')}
- 解读：{fg.get('interpretation', 'N/A')}
""")

        return "\n".join(text_parts)