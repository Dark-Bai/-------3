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

export function StockDetailProvider({ children }: { children: ReactNode }) {
  const [stocks, setStocks] = useState<StockDetailItem[]>([]);

  const openStockDetail = useCallback((code: string, name: string) => {
    setStocks((prev) => {
      if (prev.some((s) => s.code === code)) return prev; // 已存在则不重复
      return [...prev, { code, name }];
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