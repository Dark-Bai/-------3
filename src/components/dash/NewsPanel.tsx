import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, type PanelZoomProps } from "./Panel";
import { useSharedPolling } from "@/hooks/useSharedPolling";
import { api, type NewsItem } from "@/lib/api";
import { fmtTime } from "@/lib/format";
import { isTv } from "@/lib/tv";
import { MACRO_KEYWORDS } from "@/config/dashboard";

/** 快讯关键词打标 */
function tagOf(item: NewsItem): { label: string; color: string } | null {
  const text = `${item.title}${item.content}`;
  if (MACRO_KEYWORDS.some((k) => text.includes(k))) return { label: "宏观", color: "#d4943a" };
  if (/央行|降准|降息|MLF|LPR/.test(text)) return { label: "政策", color: "#d4943a" };
  return null;
}

function NewsRow({ item, isNew }: { item: NewsItem; isNew: boolean }) {
  const tag = tagOf(item);
  return (
    <article className={`rounded border-l-2 px-2.5 py-2 transition-colors ${isNew ? "border-[#d4943a] bg-[#d4943a]/8" : "border-[#e0d5c0] hover:bg-[#ede4d4]"}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#a8987e]" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtTime(item.time)}</span>
        {tag && (
          <span className="rounded-sm px-1 py-px text-[9px]" style={{ background: `${tag.color}22`, color: tag.color }}>
            {tag.label}
          </span>
        )}
        {isNew && <span className="rounded-sm bg-[#d4943a]/15 px-1 py-px text-[9px] text-[#d4943a]">NEW</span>}
      </div>
      {item.title && <h3 className="mt-1 text-[12px] font-semibold leading-5 text-[#6b5b3e]">{item.title}</h3>}
      <p className={`mt-0.5 text-[11px] leading-[1.55] text-[#8b7a5e] ${item.title ? "line-clamp-2" : ""}`}>{item.content}</p>
    </article>
  );
}

/** 7x24 实时快讯 */
export function NewsPanel({ className = "", ...zoomProps }: { className?: string } & PanelZoomProps) {
  const { data, error } = useSharedPolling<NewsItem[]>("news:60", () => api.news(60), 20000);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const seenRef = useRef<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) return;
    const fresh = data.filter((d) => !seenRef.current.has(d.id)).map((d) => d.id);
    if (seenRef.current.size > 0 && fresh.length) {
      setNewIds(new Set(fresh));
      if (autoScroll) boxRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
    data.forEach((d) => seenRef.current.add(d.id));
  }, [data, autoScroll]);

  const todayCount = useMemo(() => data?.length ?? 0, [data]);

  return (
    <Panel
      className={className}
      {...zoomProps}
      title="实时热点新闻 · 7×24 快讯"
      icon="↯"
      accent="#d4943a"
      right={
        <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-[#8b7a5e]">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="accent-[#d4943a]" />
          自动滚动 · {todayCount}条
        </label>
      }
    >
      <div ref={boxRef} className="h-full space-y-1 overflow-y-auto scroll-smooth p-1.5">
        {/* TV 弱 GPU: 滚动层全量光栅化, 60条压到25条 */}
        {(isTv ? data?.slice(0, 25) : data)?.map((item) => <NewsRow key={item.id} item={item} isNew={newIds.has(item.id)} />)}
        {!data && (
          <div className="p-6 text-center text-[11px] text-[#a8987e]">
            {error ? <span className="text-[#b8533a]">快讯源连接失败,自动重试中…<br />{error}</span> : "快讯加载中…"}
          </div>
        )}
      </div>
    </Panel>
  );
}
