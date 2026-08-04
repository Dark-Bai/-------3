import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface StockDetailItem {
  code: string;
  name: string;
}

interface StockDetailContextValue {
  openStockDetail: (code: string, name: string) => void;
  closeStockDetail: (code: string) => void;
  stocks: StockDetailItem[];
}

const StockDetailContext = createContext<StockDetailContextValue>({
  openStockDetail: () => {},
  closeStockDetail: () => {},
  stocks: [],
});

/** 归一化为腾讯代码: 6/9→sh, 0/2/3→sz, 4/8→bj; 已带 sh/sz/bj 前缀则原样。
 *  板块榜/涨停数据给的裸 6 位代码(如 600519)若不补前缀, 分时与报价都会取数失败 */
function normalizeCode(input: string): string {
  const s = String(input || "").trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  if (/^\d{6}$/.test(s)) {
    const c = s[0];
    if (c === "6" || c === "9") return `sh${s}`;
    if (c === "0" || c === "2" || c === "3") return `sz${s}`;
    if (c === "4" || c === "8") return `bj${s}`;
  }
  return s;
}

export function StockDetailProvider({ children }: { children: ReactNode }) {
  const [stocks, setStocks] = useState<StockDetailItem[]>([]);

  const openStockDetail = useCallback((code: string, name: string) => {
    const normalized = normalizeCode(code);
    setStocks((prev) => {
      if (prev.some((s) => s.code === normalized)) return prev; // 已存在则不重复
      return [...prev, { code: normalized, name }];
    });
  }, []);

  const closeStockDetail = useCallback((code: string) => {
    setStocks((prev) => prev.filter((s) => s.code !== code));
  }, []);

  return (
    <StockDetailContext.Provider value={{ openStockDetail, closeStockDetail, stocks }}>
      {children}
    </StockDetailContext.Provider>
  );
}

export function useStockDetail() {
  return useContext(StockDetailContext);
}