#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
市场情绪分析师 - 基于 akshare + pandas + numpy 的实时行情数据处理
输出 JSON 到 stdout 供 Node.js 主进程调用

功能:
  1. 大盘指数数据 (上证指数)
  2. A股全量涨跌分布 (上涨/下跌家数、涨跌停统计)
  3. 恐慌贪婪指数 (结合涨跌比、涨跌停比、成交量)
  4. ARBR 情绪指标 (基于历史K线计算)
  5. 成交量分析 (当前量 vs 5日均量)
"""
import json
import sys
import traceback
from datetime import datetime, timedelta

import akshare as ak
import pandas as pd
import numpy as np


def get_market_sentiment() -> dict:
    """获取市场情绪数据"""
    result = {
        "marketIndex": None,
        "limitUpDown": None,
        "fearGreed": None,
        "arbr": None,
        "volumeAnalysis": None,
        "dataSuccess": False,
    }

    # 1. 大盘指数数据 (sina)
    try:
        idx_df = ak.stock_zh_index_spot_sina()
        sh = idx_df[idx_df["代码"] == "sh000001"]
        if not sh.empty:
            row = sh.iloc[0]
            change_pct = float(row["涨跌幅"])
            current_price = float(row["最新价"])
            result["marketIndex"] = {
                "indexName": "上证指数",
                "currentPrice": current_price,
                "changePercent": round(change_pct, 2),
                "upCount": 0,
                "downCount": 0,
                "totalCount": 0,
                "sentimentScore": "0",
                "sentimentInterpretation": "市场情绪偏多" if change_pct >= 0 else "市场情绪偏空",
            }
    except Exception as e:
        print(f"[WARN] 指数数据获取失败: {e}", file=sys.stderr)

    # 2. A股全量实时行情 (腾讯接口)
    try:
        spot = ak.stock_zh_a_spot_tx()
        spot = spot.dropna(subset=["zdf"])
        spot["zdf"] = pd.to_numeric(spot["zdf"], errors="coerce")
        spot = spot.dropna(subset=["zdf"])
        total = len(spot)

        if total > 0:
            up = int((spot["zdf"] > 0).sum())
            down = int((spot["zdf"] < 0).sum())
            flat = total - up - down
            limit_up = int((spot["zdf"] >= 9.9).sum())
            limit_down = int((spot["zdf"] <= -9.9).sum())

            # 更新大盘涨跌分布
            if result["marketIndex"]:
                result["marketIndex"]["upCount"] = up
                result["marketIndex"]["downCount"] = down
                result["marketIndex"]["totalCount"] = total
                sentiment_score = (up - down) / total * 100 if total > 0 else 0
                result["marketIndex"]["sentimentScore"] = f"{sentiment_score:.2f}"

                # 更新市场情绪解读（更详细）
                up_ratio = up / total * 100
                if up_ratio >= 70:
                    interp = "市场普涨，情绪极度乐观"
                elif up_ratio >= 55:
                    interp = "上涨家数占优，市场情绪偏多"
                elif up_ratio >= 45:
                    interp = "涨跌家数接近，市场情绪中性"
                elif up_ratio >= 30:
                    interp = "下跌家数占优，市场情绪偏空"
                else:
                    interp = "市场普跌，情绪极度悲观"
                if change_pct := result["marketIndex"].get("changePercent", 0):
                    interp += f"，上证{'+' if change_pct >= 0 else ''}{change_pct}%"
                result["marketIndex"]["sentimentInterpretation"] = interp

            # 涨跌停统计
            limit_total = limit_up + limit_down
            if limit_total > 5:
                limit_ratio = limit_up / limit_total * 100
                if limit_ratio > 70:
                    interp = "涨停股远多于跌停股，市场情绪火热"
                elif limit_ratio > 60:
                    interp = "涨停股多于跌停股，市场情绪较好"
                elif limit_ratio < 30:
                    interp = "跌停股远多于涨停股，市场情绪低迷"
                else:
                    interp = "涨跌停数量相当，市场情绪分化"
            else:
                limit_ratio = 50.0
                interp = "涨跌停数量较少，市场无明显极端情绪"

            today = pd.Timestamp.now().strftime("%Y%m%d")
            result["limitUpDown"] = {
                "limitUpCount": limit_up,
                "limitDownCount": limit_down,
                "limitRatio": f"{limit_ratio:.1f}%",
                "interpretation": interp,
                "date": today,
            }

            # 恐慌贪婪指数 (综合计算)
            up_ratio = up / total
            score = 50.0 + (up_ratio - 0.5) * 60  # 基础涨跌分
            if limit_total > 5:
                score += (limit_ratio / 100 - 0.5) * 20  # 涨跌停加分
            # 成交量修正: 如果当前总成交额 > 5日均量，加分
            try:
                vol_col = "成交额" if "成交额" in spot.columns else "turnover"
                if vol_col in spot.columns:
                    current_vol = pd.to_numeric(spot[vol_col], errors="coerce").sum()
                    # 获取5日历史K线估算均量
                    try:
                        hist = ak.stock_zh_index_hist_tx(symbol="000001", start_date=(datetime.now() - timedelta(days=10)).strftime("%Y%m%d"), end_date=today)
                        if hist is not None and not hist.empty:
                            avg_vol = hist["成交量"].tail(5).mean()
                            if avg_vol > 0:
                                vol_ratio = current_vol / avg_vol
                                if vol_ratio > 1.5:
                                    score += 5
                                elif vol_ratio > 1.2:
                                    score += 2
                                elif vol_ratio < 0.6:
                                    score -= 5
                                elif vol_ratio < 0.8:
                                    score -= 2
                    except Exception:
                        pass
            except Exception:
                pass

            score = max(0, min(100, score))

            if score >= 75:
                level = "极度贪婪"
                fg_interp = "市场情绪极度乐观，投资者贪婪，需警惕回调风险"
            elif score >= 60:
                level = "贪婪"
                fg_interp = "市场情绪乐观，投资者偏向贪婪"
            elif score >= 40:
                level = "中性"
                fg_interp = "市场情绪中性，投资者相对理性"
            elif score >= 25:
                level = "恐慌"
                fg_interp = "市场情绪悲观，投资者偏向恐慌"
            else:
                level = "极度恐慌"
                fg_interp = "市场情绪极度悲观，投资者恐慌，可能存在超卖机会"

            result["fearGreed"] = {
                "score": f"{score:.1f}",
                "level": level,
                "interpretation": fg_interp,
            }

            # 涨跌分布详细数据
            # 按涨跌幅区间分类
            intervals = [
                ("<-5%", -100, -5),
                ("-5%~-3%", -5, -3),
                ("-3%~-1%", -3, -1),
                ("-1%~0%", -1, 0),
                ("0%~1%", 0, 1),
                ("1%~3%", 1, 3),
                ("3%~5%", 3, 5),
                (">5%", 5, 100),
            ]
            distribution = []
            for label, lo, hi in intervals:
                cnt = int(((spot["zdf"] >= lo) & (spot["zdf"] < hi)).sum())
                distribution.append({"range": label, "count": cnt, "pct": round(cnt / total * 100, 1)})

            result["distribution"] = {
                "upCount": up,
                "downCount": down,
                "flatCount": flat,
                "totalCount": total,
                "upPct": round(up / total * 100, 1),
                "downPct": round(down / total * 100, 1),
                "intervals": distribution,
            }

            # 成交量分析
            try:
                vol_col = "成交额" if "成交额" in spot.columns else "turnover"
                if vol_col in spot.columns:
                    current_vol_val = float(pd.to_numeric(spot[vol_col], errors="coerce").sum())
                    # 估算5日均量
                    try:
                        hist = ak.stock_zh_index_hist_tx(symbol="000001", start_date=(datetime.now() - timedelta(days=10)).strftime("%Y%m%d"), end_date=today)
                        if hist is not None and not hist.empty:
                            avg_vol_5 = float(hist["成交量"].tail(5).mean())
                            if avg_vol_5 > 0:
                                vol_ratio_val = current_vol_val / avg_vol_5
                                if vol_ratio_val >= 1.5:
                                    vol_level = "放量"
                                    vol_interp = "成交量明显放大，市场参与度提升"
                                elif vol_ratio_val >= 1.2:
                                    vol_level = "温和放量"
                                    vol_interp = "成交量温和放大，市场活跃度增加"
                                elif vol_ratio_val >= 0.8:
                                    vol_level = "正常"
                                    vol_interp = "成交量处于正常水平"
                                elif vol_ratio_val >= 0.5:
                                    vol_level = "缩量"
                                    vol_interp = "成交量萎缩，市场观望情绪浓厚"
                                else:
                                    vol_level = "极度缩量"
                                    vol_interp = "成交量极度萎缩，市场交投冷清"
                                result["volumeAnalysis"] = {
                                    "currentVolume": round(current_vol_val, 0),
                                    "avgVolume5": round(avg_vol_5, 0),
                                    "ratio": round(vol_ratio_val, 2),
                                    "level": vol_level,
                                    "interpretation": vol_interp,
                                }
                    except Exception:
                        # 无历史数据时跳过成交量分析
                        pass
            except Exception:
                pass

            # ARBR 情绪指标 (使用个股历史K线采样估算)
            try:
                # 使用上证指数历史K线计算ARBR
                hist = ak.stock_zh_index_hist_tx(symbol="000001",
                    start_date=(datetime.now() - timedelta(days=30)).strftime("%Y%m%d"),
                    end_date=today)
                if hist is not None and not hist.empty and len(hist) >= 10:
                    recent = hist.tail(26)  # 使用26日周期
                    if len(recent) >= 10:
                        # AR = (H-O)和 / (O-L)和 * 100
                        sum_ho = (recent["最高价"] - recent["开盘价"]).sum()
                        sum_ol = (recent["开盘价"] - recent["最低价"]).sum()
                        ar = (sum_ho / sum_ol * 100) if sum_ol > 0 else 100.0

                        # BR = (H-PC)和 / (PC-L)和 * 100
                        recent_26 = hist.tail(27)  # 多取一天用于昨收
                        if len(recent_26) >= 11:
                            br_data = recent_26.tail(26)
                            prev_close = recent_26.iloc[:26]["收盘价"].values  # 26个昨收
                            sum_hpc = sum(max(br_data.iloc[i]["最高价"] - prev_close[i], 0) for i in range(len(br_data)))
                            sum_pcl = sum(max(prev_close[i] - br_data.iloc[i]["最低价"], 0) for i in range(len(br_data)))
                            br = (sum_hpc / sum_pcl * 100) if sum_pcl > 0 else 100.0
                        else:
                            br = 100.0

                        # ARBR 解读
                        ar_judge = "多头" if ar >= 150 else "偏多" if ar >= 120 else "中性" if ar >= 80 else "偏空" if ar >= 60 else "空头"
                        br_judge = "多头" if br >= 300 else "偏多" if br >= 150 else "中性" if br >= 100 else "偏空" if br >= 70 else "空头"

                        # 综合判断
                        if ar >= 150 and br >= 300:
                            arbr_interp = "ARBR均处于高位，市场情绪过热，需警惕回调风险"
                        elif ar >= 120 and br >= 150:
                            arbr_interp = "ARBR偏强，市场情绪积极，但需注意追高风险"
                        elif ar <= 60 and br <= 70:
                            arbr_interp = "ARBR均处于低位，市场情绪低迷，可能存在超跌反弹机会"
                        elif ar <= 80 and br <= 100:
                            arbr_interp = "ARBR偏弱，市场情绪谨慎，观望为主"
                        else:
                            arbr_interp = "ARBR处于正常范围，市场情绪中性"

                        result["arbr"] = {
                            "ar": round(ar, 1),
                            "br": round(br, 1),
                            "arJudgment": ar_judge,
                            "brJudgment": br_judge,
                            "interpretation": arbr_interp,
                            "period": "26日",
                        }
            except Exception:
                # ARBR 计算失败时跳过
                pass

    except Exception as e:
        print(f"[WARN] A股行情数据获取失败: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    result["dataSuccess"] = (
        result["marketIndex"] is not None
        or result["limitUpDown"] is not None
    )
    return result


if __name__ == "__main__":
    try:
        data = get_market_sentiment()
        print(json.dumps(data, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e), "dataSuccess": False}, ensure_ascii=False))
        sys.exit(1)