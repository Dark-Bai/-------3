import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "../Panel";
import { usePolling } from "@/hooks/usePolling";
import { api, type FinCalendarItem } from "@/lib/api";
import { useFin } from "./FinContext";
import { SkeletonRows } from "./SkeletonRows";
import { TNUM, prefixCode, quarterLabel } from "./utils";

const DAY = 86400000;
const STRIP_H = 40; // 顶部柱带总高(柱区 + 8px 刻度行)

const dateKey = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 财报日历: 顶部全宽 14 天柱带(今日 amber 实色) + 下方双列流式披露清单(可点选公司) */
export function FinCalendarPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const [retry, setRetry] = useState(0);
  const { period } = useFin();
  const { data, error, loading } = usePolling(() => api.financeBoard(period), 1800000, [retry, period]);
  const { select } = useFin();

  const boxRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(160);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      if (r.width > 40) setW(r.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]); // 容器仅在拿到数据后挂载, 数据到达时重新挂观察

  const view = useMemo(() => {
    const cal = data?.calendar ?? [];
    const counts = new Map<string, number>();
    for (const it of cal) counts.set(it.date, (counts.get(it.date) ?? 0) + 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 14 }, (_, i) => {
      const key = dateKey(today.getTime() + i * DAY);
      return { key, offset: i, count: counts.get(key) ?? 0 };
    });
    const todayKey = days[0].key;
    const peak = Math.max(...days.map((d) => d.count), 0);
    const peakKey = days.find((d) => d.count === peak)?.key ?? todayKey;
    // 清单: 今日 → 明日 → 最近有披露的一日(降级并标注日期)
    const byDate = new Map<string, FinCalendarItem[]>();
    for (const it of cal) {
      const arr = byDate.get(it.date) ?? [];
      arr.push(it);
      byDate.set(it.date, arr);
    }
    let listDate = todayKey;
    if (!byDate.has(todayKey)) {
      const tmr = dateKey(today.getTime() + DAY);
      // calendar 按公告日倒序, 首条即最近一日
      listDate = byDate.has(tmr) ? tmr : cal[0]?.date ?? todayKey;
    }
    const heavy = new Set((data?.stocks ?? []).map((s) => s.code)); // 净利 TOP50 视作重磅
    return { days, todayKey, todayCount: counts.get(todayKey) ?? 0, peak, peakKey, list: byDate.get(listDate) ?? [], listDate, heavy };
  }, [data]);

  const W = w;
  const padX = 6;
  const slot = (W - padX * 2) / 14;
  const bw = Math.max(3, slot * 0.55);
  const baseY = STRIP_H - 10; // 底部 10px 留给 8px 刻度行
  const peak = Math.max(view.peak, 1);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="财报日历"
      icon="▦"
      accent="#d4943a"
      right={
        data && (
          <span className="text-[10px] text-[#a8987e]" style={TNUM}>
            今日 <span className="font-semibold text-[#d4943a]">{view.todayCount}</span> 家 · 峰值 {view.peak} 家(
            {view.peakKey.slice(5).replace("-", "/")})
          </span>
        )
      }
    >
      {!data ? (
        loading ? (
          <SkeletonRows rows={6} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px]">
            <button className="h-full w-full text-[#a8987e]" onClick={() => setRetry((r) => r + 1)}>
              数据获取失败，点击重试{error ? `(${error})` : ""}
            </button>
          </div>
        )
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {/* 全宽 40px 柱带: 今日 amber 实色 + 柱顶 8px 数字, 未来 cyan/40 */}
          <div ref={boxRef} className="shrink-0">
            <svg width={W} height={STRIP_H} className="block">
              {view.days.map((d, i) => {
                const bh = d.count > 0 ? Math.max(2, (d.count / peak) * (baseY - 12)) : 0;
                const x = padX + i * slot + (slot - bw) / 2;
                const isToday = i === 0;
                return (
                  <g key={d.key}>
                    {bh > 0 && (
                      <rect
                        x={x}
                        y={baseY - bh}
                        width={bw}
                        height={bh}
                        rx={1.5}
                        fill={isToday ? "#d4943a" : "#d4943a"}
                        opacity={isToday ? 1 : 0.4}
                      />
                    )}
                    {d.count > 0 && (
                      <text
                        x={x + bw / 2}
                        y={baseY - bh - 2}
                        fontSize={8}
                        fill={isToday ? "#d4943a" : "#a8987e"}
                        textAnchor="middle"
                        style={TNUM}
                      >
                        {d.count}
                      </text>
                    )}
                  </g>
                );
              })}
              <line x1={padX} y1={baseY} x2={W - padX} y2={baseY} stroke="#c8b89a" strokeWidth={1} />
              {[
                { i: 0, t: "今天", a: "start" as const },
                { i: 3, t: "+3", a: "middle" as const },
                { i: 7, t: "+7", a: "middle" as const },
                { i: 13, t: "+14", a: "end" as const },
              ].map(({ i, t, a }) => (
                <text
                  key={t}
                  x={a === "start" ? padX : a === "end" ? W - padX : padX + i * slot + slot / 2}
                  y={STRIP_H - 2}
                  fontSize={8}
                  fill="#a8987e"
                  textAnchor={a}
                >
                  {t}
                </text>
              ))}
            </svg>
          </div>
          {/* 双列流式披露清单: 名称 11px / 期 9px / 重磅 ★ amber */}
          <div className="shrink-0 border-t border-[#e0d5c0] px-2 pt-1 text-[9px] text-[#d4943a]">
            {view.listDate === view.todayKey ? "今晚披露" : `${view.listDate.slice(5).replace("-", "/")} 披露`}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
            {view.list.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[11px] text-[#a8987e]">未来 14 天暂无披露安排</div>
            ) : (
              <div className="grid grid-cols-2">
                {view.list.map((it) => (
                  <button
                    key={`${it.date}-${it.code}`}
                    onClick={() => select(prefixCode(it.code), it.name)}
                    className="flex h-[18px] min-w-0 items-center gap-1.5 border-b border-[#e0d5c0] px-2 text-left hover:bg-[#ede4d4]"
                  >
                    <span className="min-w-0 flex-1 truncate text-[11px] text-[#6b5b3e]">{it.name}</span>
                    <span className="shrink-0 text-[9px] text-[#a8987e]">{quarterLabel(it.period)}</span>
                    {view.heavy.has(it.code) && <span className="shrink-0 text-[9px] text-[#d4943a]">★</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
