import { useEffect, useState } from "react";

/** 定时更新的当前时间(TV 传 60s: 每秒重渲染会造成持续重绘) */
export function useClock(intervalMs = 1000) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
