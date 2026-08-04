import { useMemo, useRef, useState } from "react";
import { FloatingWindow } from "./FloatingWindow";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/api";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;
const HISTORY_MAX = 120; // 每 10s 一个采样点, 约 20 分钟趋势

/** 接口路径 → 中文名称/说明(用于监控面板直观展示);
 *  未覆盖的接口回退为原始路径。 */
const API_LABELS: Record<string, { n: string; d: string; s: string }> = {
  "/api/quotes": { n: "统一报价", d: "指数/个股实时报价(统一报价中心)", s: "腾讯/KPL/新浪" },
  "/api/minute": { n: "分时数据", d: "个股/指数日内分时走势", s: "腾讯/KPL" },
  "/api/boards": { n: "板块排行", d: "行业/概念板块涨跌排行", s: "腾讯" },
  "/api/board-stocks": { n: "板块成分股", d: "板块内成分股列表", s: "腾讯" },
  "/api/rank": { n: "个股榜单", d: "涨跌幅/成交额/换手率排行", s: "新浪/腾讯" },
  "/api/moneyflow": { n: "资金流", d: "个股资金流向排行", s: "东财/新浪" },
  "/api/stock-flow": { n: "个股资金流", d: "单只个股资金流向", s: "东财" },
  "/api/stock-flows": { n: "个股资金流(批量)", d: "批量获取多只个股资金流", s: "东财" },
  "/api/stock-main-forces": { n: "个股主力净额", d: "个股主力净流入/主动买卖", s: "KPL" },
  "/api/board-flow": { n: "板块资金流", d: "板块累计主力净流入曲线", s: "东财" },
  "/api/stock-boards": { n: "个股板块", d: "个股所属行业/地域/概念", s: "本地库/KPL" },
  "/api/stock-profile": { n: "个股主营业务", d: "个股主营业务简介", s: "KPL" },
  "/api/stock-quote": { n: "个股盘口", d: "个股实时盘口行情", s: "KPL" },
  "/api/stock-detail": { n: "个股详情聚合", d: "个股详情(本地库+按需抓取+失败回退)", s: "本地库/KPL" },
  "/api/stock-finance": { n: "个股财务", d: "个股财务指标摘要", s: "KPL" },
  "/api/news": { n: "快讯", d: "实时财经快讯", s: "新浪" },
  "/api/treasuries": { n: "美债收益率", d: "美债即时收益率", s: "CNBC" },
  "/api/treasury-history": { n: "美债历史曲线", d: "美债月度收益率历史曲线", s: "CNBC" },
  "/api/finance-main": { n: "财报主指标", d: "单公司近12期财务主指标", s: "KPL" },
  "/api/finance-board": { n: "财报榜单", d: "盈利榜+行业聚合+披露日历", s: "KPL" },
  "/api/finance-forecast": { n: "业绩预告", d: "财报业绩预告统计", s: "KPL" },
  "/api/health": { n: "健康检查", d: "服务存活与缓存状态", s: "本地" },
  "/api/monitor": { n: "系统监控", d: "接口性能/DB状态/内存监控", s: "本地" },
  "/api/openrouter-usage": { n: "用量统计", d: "OpenRouter 模型用量统计", s: "OpenRouter" },
  "/api/stock-search": { n: "股票搜索", d: "名称/拼音首字母搜索股票", s: "新浪" },
  "/api/plugin-news-analyst": { n: "新闻分析师", d: "新闻/社交/财务情绪分析", s: "KPL" },
  "/api/plugin-market-sentiment": { n: "市场情绪", d: "市场情绪指标与涨跌统计", s: "KPL" },
  "/api/fengk-front": { n: "风口榜", d: "市场板块实时热点(风口榜)", s: "KPL" },
};

/** 取接口中文名称; 未收录时回退为原始路径 */
function apiLabel(path: string) {
  return API_LABELS[path] ?? { n: path, d: "", s: "—" };
}

/** 系统监控悬浮窗: 接口调用监控 / 本地DB状态 / 性能趋势 / 异常告警 */
export function MonitorWindow({ onClose }: { onClose: () => void }) {
  const { data } = usePolling(() => api.monitor(), 10000, []);
  const histRef = useRef<{ ts: number; rate: number; avg: number; p95: number; err: number }[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // 记录历史趋势点(标定当前时刻)
  const snap = useMemo(() => {
    const s = { ts: Date.now(), rate: 0, avg: 0, p95: 0, err: 0 };
    if (data?.endpoints?.length) {
      s.rate = data.endpoints.reduce((a, e) => a + e.rate1m, 0);
      const fast = data.endpoints.filter((e) => e.count > 0);
      if (fast.length) {
        s.avg = Math.round(fast.reduce((a, e) => a + e.avg, 0) / fast.length);
        s.p95 = Math.max(...fast.map((e) => e.p95));
        s.err = fast.reduce((a, e) => a + e.errors, 0);
      }
    }
    const h = histRef.current;
    h.push({ ...s, ts: Date.now() });
    if (h.length > HISTORY_MAX) h.shift();
    setNow(Date.now());
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const endpoints = data?.endpoints ?? [];
  const totalCount = endpoints.reduce((a, e) => a + e.count, 0);
  const totalErr = endpoints.reduce((a, e) => a + e.errors, 0);
  const slow = endpoints.filter((e) => e.count > 0 && (e.p95 > 1000 || e.errors > 0));

  // 排序: 慢接口 / 报错接口优先展示
  const sorted = useMemo(
    () => [...endpoints].sort((a, b) => (b.errors > 0 ? 1 : 0) + (b.p95 - a.p95) / 1000 - ((a.errors > 0 ? 1 : 0) + (a.p95 - b.p95) / 1000)),
    [endpoints]
  );

  const hist = histRef.current;
  const maxRate = Math.max(1, ...hist.map((h) => h.rate));
  const maxAvg = Math.max(1, ...hist.map((h) => h.avg));
  const memMb = data ? Math.round(data.serverMem.rss / 1048576) : 0;
  const uptime = data ? Math.floor(data.uptime / 60) : 0;

  return (
    <FloatingWindow id="monitor" title="系统监控" icon="◉" accent="#4a6b3f" onClose={onClose} defaultWidth={720} defaultHeight={560}>
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-3">
        {/* 顶部汇总卡 */}
        <div className="grid grid-cols-4 gap-2">
          <Summary label="累计请求" value={totalCount.toLocaleString()} tone="#6b5b3e" />
          <Summary label="调用速率(1min)" value={snap.rate.toLocaleString()} tone="#d4943a" />
          <Summary label="平均响应" value={`${snap.avg}ms`} tone="#4a6b3f" />
          <Summary label="错误数" value={totalErr.toLocaleString()} tone={totalErr > 0 ? "#b8533a" : "#4a6b3f"} />
        </div>

        {/* 系统/DB 状态 */}
        <div className="grid grid-cols-4 gap-2">
          <Summary label="本地个股缓存" value={data ? data.db.stocks.toLocaleString() : "—"} tone="#4a6b3f" />
          <Summary label="趋势记录" value={data ? data.db.trends.toLocaleString() : "—"} tone="#4a6b3f" />
          <Summary label="内存缓存条目" value={data ? data.cache.entries.toLocaleString() : "—"} tone="#8b7a5e" />
          <Summary label="服务内存" value={`${memMb}MB`} tone="#8b7a5e" />
        </div>

        {/* 性能趋势图 */}
        <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 p-2">
          <div className="mb-1 flex items-center justify-between text-[10px] text-[#8b7a5e]">
            <span className="font-semibold">性能趋势(近{Math.min(hist.length, 20)}分钟)</span>
            <span>运行 {uptime} 分钟</span>
          </div>
          {hist.length > 1 ? (
            <TrendChart hist={hist} maxRate={maxRate} maxAvg={maxAvg} />
          ) : (
            <div className="flex h-16 items-center justify-center text-[11px] text-[#a8987e]">采集数据中…</div>
          )}
        </div>

        {/* 异常告警 */}
        {slow.length > 0 && (
          <div className="rounded border border-[#b8533a]/40 bg-[#b8533a]/5 p-2">
            <div className="mb-1 text-[10px] font-semibold text-[#b8533a]">⚠ 异常告警</div>
            <div className="flex flex-col gap-1">
              {slow.slice(0, 6).map((e) => {
                const lb = apiLabel(e.path);
                return (
                <div key={e.path} className="flex items-center justify-between text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 rounded-sm bg-[#d4943a]/15 px-1 py-0.5 text-[9px] text-[#d4943a]">{lb.s}</span>
                    <span className="truncate text-[#6b5b3e]" title={lb.d || e.path}>{lb.n}</span>
                  </span>
                  <span className="ml-2 shrink-0" style={TNUM}>
                    {e.errors > 0 ? `${e.errors} 错误 · ` : ""}p95 {e.p95 >= 1000 ? `${(e.p95 / 1000).toFixed(1)}s` : `${e.p95}ms`}
                  </span>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 接口明细表 */}
        <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 p-2">
          <div className="mb-1 text-[10px] font-semibold text-[#8b7a5e]">接口调用明细</div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-[#e0d5c0] text-left text-[#a8987e]">
                <th className="py-1 pr-2 font-medium">接口</th>
                <th className="py-1 pr-2 font-medium">来源</th>
                <th className="py-1 pr-2 text-right font-medium">次数</th>
                <th className="py-1 pr-2 text-right font-medium">平均</th>
                <th className="py-1 pr-2 text-right font-medium">p95</th>
                <th className="py-1 pr-2 text-right font-medium">最大</th>
                <th className="py-1 pr-2 text-right font-medium">成功率</th>
                <th className="py-1 text-right font-medium">1min</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const slowRow = e.p95 > 1000 || e.errors > 0;
                const lb = apiLabel(e.path);
                return (
                  <tr key={e.path} className={slowRow ? "bg-[#b8533a]/5" : ""}>
                    <td className="max-w-[150px] py-1 pr-2" title={lb.d || e.path}>
                      <span className="block truncate text-[#6b5b3e]">{lb.n}</span>
                      <span className="block truncate text-[9px] text-[#a8987e]">{e.path}</span>
                    </td>
                    <td className="py-1 pr-2">
                      <span className="rounded-sm bg-[#d4943a]/15 px-1.5 py-0.5 text-[9px] text-[#d4943a]">{lb.s}</span>
                    </td>
                    <td className="py-1 pr-2 text-right" style={TNUM}>{e.count.toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right" style={TNUM}>{e.avg}ms</td>
                    <td className={`py-1 pr-2 text-right ${e.p95 > 1000 ? "font-semibold text-[#b8533a]" : ""}`} style={TNUM}>{e.p95}ms</td>
                    <td className="py-1 pr-2 text-right" style={TNUM}>{e.max}ms</td>
                    <td className={`py-1 pr-2 text-right ${e.errors > 0 ? "font-semibold text-[#b8533a]" : "text-[#4a6b3f]"}`} style={TNUM}>{e.successRate}%</td>
                    <td className="py-1 text-right" style={TNUM}>{e.rate1m}</td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={8} className="py-3 text-center text-[#a8987e]">暂无接口数据</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="text-[9px] text-[#a8987e]">
          数据源: /api/monitor · 每 10s 刷新 · 更新于 {new Date(now).toLocaleTimeString("zh-CN")}
        </div>
      </div>
    </FloatingWindow>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded border border-[#e0d5c0] bg-[#f5f0e6]/60 px-2 py-1.5">
      <div className="text-[9px] text-[#a8987e]">{label}</div>
      <div className="text-[16px] font-bold leading-tight" style={{ color: tone, ...TNUM }}>{value}</div>
    </div>
  );
}

/** 简易 SVG 双轴趋势图: 调用速率(柱) + 平均响应(线) */
function TrendChart({ hist, maxRate, maxAvg }: { hist: { rate: number; avg: number }[]; maxRate: number; maxAvg: number }) {
  const W = 680, H = 64, PAD = 4;
  const n = hist.length;
  const bw = (W - PAD * 2) / n;
  const bars = hist.map((h, i) => {
    const hh = (h.rate / maxRate) * (H - PAD * 2);
    return <rect key={i} x={PAD + i * bw + bw * 0.2} y={H - PAD - hh} width={bw * 0.6} height={hh} fill="#d4943a" opacity={0.5} />;
  });
  const line = hist.map((h, i) => {
    const x = PAD + i * bw + bw / 2;
    const y = H - PAD - (h.avg / maxAvg) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none">
      {bars}
      {line && <polyline points={line} fill="none" stroke="#4a6b3f" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
    </svg>
  );
}