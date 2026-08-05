import { useCallback, useEffect, useRef, useState } from "react";

// 模块级 visibilitychange 单监听器: 所有 usePolling 实例共享,
// 避免每个实例各挂一个 document 监听(大屏数百行时监听器数量爆炸)
const visListeners = new Set<() => void>();
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const fn of visListeners) fn();
  });
}

/** 通用轮询 hook: 立即执行 + 固定间隔刷新
 *  - 上一轮完成后才排下一轮, 组件卸载自动停止
 *  - 后台标签页(hidden)暂停轮询, 回到前台立即补拉一次并恢复
 *  - 传入 isEqual 且新旧数据相等时复用旧引用且不刷新 updated, 整次跳过重渲染
 *  - enabled=false 时完全停发请求并保留当前数据(定格), 置 true 立即补拉一次 */
export function usePolling<T>(
  fn: () => Promise<T>,
  interval: number,
  deps: unknown[] = [],
  isEqual?: (a: T, b: T) => boolean,
  enabled = true,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // 在途刷新中(首次加载后仍为 true, 供刷新指示器)
  const fnRef = useRef(fn);
  const isEqualRef = useRef(isEqual);
  // 最新数据引用, 供 isEqual 比较(避免在 setState updater 里做副作用)
  const dataRef = useRef<T | null>(null);
  // 手动刷新触发器: 指向当前 effect 闭包内的 run, 供外部主动拉取
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    fnRef.current = fn;
    isEqualRef.current = isEqual;
  });

  useEffect(() => {
    // 停用(如收盘后): 不请求、不调度, 保留当前数据(定格); 重新启用时本 effect 重跑并立即补拉
    if (!enabled) return;
    let dead = false;
    let timer = 0;
    let inflight = false; // 上一轮仍在途时跳过新触发, 防乱序返回旧数据覆盖新数据
    const schedule = () => {
      // 后台标签页不排下一轮, 等 visibilitychange 唤醒
      if (!document.hidden) timer = window.setTimeout(run, interval);
    };
    const run = async () => {
      if (inflight) return;
      inflight = true;
      setRefreshing(true);
      try {
        const d = await fnRef.current();
        if (!dead) {
          // isEqual 命中: 引用与 updated 都保持不变, 组件本次完全不重渲染
          if (!(dataRef.current !== null && isEqualRef.current?.(dataRef.current, d))) {
            dataRef.current = d;
            setData(d);
            setUpdated(Date.now());
          }
          setError(null);
        }
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inflight = false;
        if (!dead) {
          setRefreshing(false);
          setLoading(false);
          schedule();
        }
      }
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden && !dead) void run();
    };
    runRef.current = run;
    void run();
    visListeners.add(onVisibility);
    return () => {
      dead = true;
      window.clearTimeout(timer);
      visListeners.delete(onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, ...deps, enabled]);

  return { data, error, updated, loading, refreshing, refresh: useCallback(() => runRef.current(), []) };
}
