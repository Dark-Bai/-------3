/** 驾驶舱静态配置:指数、大宗商品 */

export interface IndexDef {
  code: string;
  label: string;
  region: "CN" | "HK" | "US" | "FX";
}

export const INDICES: IndexDef[] = [
  { code: "sh000001", label: "上证指数", region: "CN" },
  { code: "sz399001", label: "深证成指", region: "CN" },
  { code: "sz399006", label: "创业板指", region: "CN" },
  { code: "sh000688", label: "科创50", region: "CN" },
  { code: "sh000300", label: "沪深300", region: "CN" },
  { code: "sh000905", label: "中证500", region: "CN" },
  { code: "hkHSI", label: "恒生指数", region: "HK" },
  { code: "hkHSTECH", label: "恒生科技", region: "HK" },
  { code: "usDJI", label: "道琼斯", region: "US" },
  { code: "usIXIC", label: "纳斯达克", region: "US" },
  { code: "usINX", label: "标普500", region: "US" },
  { code: "usVIX", label: "恐慌指数", region: "US" },
  { code: "usSOXX", label: "费城半导体", region: "US" },
  { code: "usN225", label: "日经225", region: "US" },
  { code: "usKS11", label: "韩国KOSPI", region: "US" },
];

export const FOREX: IndexDef[] = [{ code: "whUSDCNY", label: "美元/人民币", region: "FX" }];

/** 宏观关键词 — 快讯高亮 */
export const MACRO_KEYWORDS = [
  "央行", "美联储", "降息", "加息", "降准", "GDP", "CPI", "PMI",
  "财政部", "国债", "专项债", "汇率", "人民币", "关税", "国常会",
];
