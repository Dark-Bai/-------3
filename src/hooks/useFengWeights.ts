import { useCallback, useEffect, useMemo, useState } from "react";

/** 风口评分维度键 */
export type FengDimKey = "limitUp" | "ladder" | "capital" | "theme" | "news";

/** 风口评分维度顺序(与后端 parseFengWeights 的权重拼接顺序一致) */
export const FENG_DIM_ORDER: FengDimKey[] = ["limitUp", "ladder", "capital", "theme", "news"];

/** 风口评分维度中文名 */
export const FENG_DIM_LABELS: Record<FengDimKey, string> = {
  limitUp: "涨停家数",
  ladder: "连板高度",
  capital: "板块资金",
  theme: "题材热度",
  news: "新闻催化",
};

/** 风口评分默认权重(绝对权重, 展示时归一化到 100%) */
export const FENG_DEFAULT_WEIGHTS: Record<FengDimKey, number> = {
  limitUp: 30,
  ladder: 20,
  capital: 20,
  theme: 15,
  news: 15,
};

/** localStorage 持久化键名 */
const STORAGE_KEY = "fengk-weights";

/** 从 localStorage 读取权重, 校验合法并夹取到 [0,100] */
function loadWeights(): Record<FengDimKey, number> {
  const out = { ...FENG_DEFAULT_WEIGHTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(FENG_DEFAULT_WEIGHTS) as FengDimKey[]) {
      const v = Number(parsed[k]);
      if (Number.isFinite(v)) out[k] = Math.max(0, Math.min(100, v));
    }
  } catch {
    // 解析失败退回默认权重
  }
  return out;
}

export interface FengWeights {
  /** 绝对权重(0-100), 供滑块编辑 */
  weights: Record<FengDimKey, number>;
  /** 归一化权重(占比, 之和恒为 100%), 供评分/展示 */
  normalized: Record<FengDimKey, number>;
  /** 更新单个维度权重 */
  setWeight: (key: FengDimKey, value: number) => void;
  /** 恢复默认权重 */
  reset: () => void;
}

/** 风口维度权重: 前端可调 + localStorage 持久化 + 自动归一化到 100% */
export function useFengWeights(): FengWeights {
  const [weights, setWeights] = useState<Record<FengDimKey, number>>(loadWeights);

  // 权重变化即持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(weights));
    } catch {
      // 存储失败(如隐私模式)忽略, 不影响功能
    }
  }, [weights]);

  const setWeight = useCallback((key: FengDimKey, value: number) => {
    setWeights((prev) => ({ ...prev, [key]: Math.max(0, Math.min(100, value)) }));
  }, []);

  const reset = useCallback(() => {
    setWeights({ ...FENG_DEFAULT_WEIGHTS });
  }, []);

  // 归一化: 各维度占比之和恒为 100%
  const normalized = useMemo(() => {
    const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    const out = {} as Record<FengDimKey, number>;
    for (const k of Object.keys(FENG_DEFAULT_WEIGHTS) as FengDimKey[]) {
      out[k] = (weights[k] / total) * 100;
    }
    return out;
  }, [weights]);

  return { weights, normalized, setWeight, reset };
}