/**
 * 查看思考过程 - 按钮 + 模态窗口
 *
 * 展示 agent 在本次分析/复盘过程中的完整链路:
 *  - 加载的资源(数据源/技能库/参考池)
 *  - 调用的工具/函数与脱敏参数
 *  - 各步骤时间戳与执行状态
 *
 * 数据安全: 仅消费后端返回的 PhiliaTraceStep(已脱敏摘要),
 * 不展示明文 Key / 完整 prompt / 原始 LLM 响应。
 * 交互: 关闭按钮 + 点击外部关闭 + ESC 关闭 + 响应式。
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Brain,
  X,
  FileText,
  Wrench,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
} from "lucide-react";
import type { PhiliaTraceStep } from "@/lib/api";

interface Props {
  /** 思考过程步骤(后端脱敏摘要) */
  trace: PhiliaTraceStep[];
  /** 本次分析模型(id) */
  model?: string;
  /** 分析日期 */
  date?: string;
  /** 是否本次命中降频缓存 */
  fromCache?: boolean;
}

/** 时间戳(ms) → HH:MM:SS */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 步骤类型 → 分组标签与图标 */
const TYPE_META = {
  agent: { label: "整体流程", icon: Sparkles, color: "#d4943a" },
  resource: { label: "加载的资源", icon: FileText, color: "#4a6b3f" },
  tool: { label: "调用的工具 / 函数", icon: Wrench, color: "#8b7a5e" },
} as const;

export function ThinkingProcessButton({
  trace,
  model,
  date,
  fromCache,
}: Props) {
  const [open, setOpen] = useState(false);

  /* ESC 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /* 按类型分组(保持后端原始顺序) */
  const groups = useMemo(() => {
    const g: { key: keyof typeof TYPE_META; items: PhiliaTraceStep[] }[] = [];
    for (const t of ["agent", "resource", "tool"] as const) {
      const items = trace.filter((s) => s.type === t);
      if (items.length) g.push({ key: t, items });
    }
    return g;
  }, [trace]);

  const totalMs = useMemo(() => {
    if (trace.length < 2) return 0;
    const first = trace[0].startedAt;
    const last = trace[trace.length - 1].startedAt + trace[trace.length - 1].durationMs;
    return Math.max(0, last - first);
  }, [trace]);

  const failedCount = useMemo(() => trace.filter((s) => s.status === "failed").length, [trace]);

  return (
    <>
      {/* 触发按钮: 视觉明显, 符合 PHILIA 暖色纸感风格 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={trace.length === 0}
        title="查看本次 AI 分析的思考过程(加载的资源 / 调用的工具 / 耗时状态)"
        className="group flex items-center gap-1.5 rounded border border-[#d4943a]/50 bg-gradient-to-b from-[#faf6ee] to-[#ede4d4] px-2 py-1 text-[10px] font-semibold text-[#6b5b3e] shadow-sm transition-all hover:border-[#d4943a]/80 hover:shadow disabled:opacity-40"
      >
        <Brain size={13} className="text-[#d4943a] transition-transform group-hover:scale-110" />
        查看思考过程
        {trace.length > 0 && (
          <span className="rounded bg-[#d4943a]/15 px-1 text-[9px] tabular-nums text-[#b07a2a]">
            {trace.length}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9100] flex items-center justify-center bg-black/40 p-4"
            onClick={() => setOpen(false)}
          >
            <div
              className="flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-sm border border-[#d4943a]/50 bg-[#faf6ee] shadow-[0_8px_40px_rgba(0,0,0,0.25)]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* 标题栏 */}
              <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[#e0d5c0] bg-gradient-to-r from-[#f5f0e6] via-[#faf6ee] to-[#f5f0e6] px-4">
                <Brain size={15} className="text-[#d4943a]" />
                <h2 className="text-[14px] font-bold tracking-wide text-[#6b5b3e] font-newspaper-heading">
                  思考过程
                </h2>
                <span className="ml-1 rounded bg-[#d4943a]/12 px-1.5 py-px text-[9px] text-[#b07a2a]">
                  {trace.length} 步
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {failedCount > 0 && (
                    <span className="rounded bg-[#b8533a]/12 px-1.5 py-px text-[9px] text-[#b8533a]">
                      {failedCount} 步异常
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    title="关闭"
                    className="flex h-7 w-7 items-center justify-center rounded text-[#8b7a5e] transition-colors hover:bg-[#ede4d4] hover:text-[#6b5b3e]"
                  >
                    <X size={15} />
                  </button>
                </div>
              </header>

              {/* 摘要行 */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#e0d5c0]/70 bg-[#f5f0e6]/50 px-4 py-1.5 text-[10px] text-[#8b7a5e]">
                {model && <span>模型：{model}</span>}
                {date && <span>日期：{date}</span>}
                <span className="flex items-center gap-0.5">
                  <Clock size={10} /> 总耗时 {totalMs}ms
                </span>
                {fromCache !== undefined && (
                  <span className={fromCache ? "text-[#d4943a]" : "text-[#4a6b3f]"}>
                    {fromCache ? "命中缓存" : "实时计算"}
                  </span>
                )}
              </div>

              {/* 步骤列表 */}
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {groups.length === 0 ? (
                  <div className="flex h-24 flex-col items-center justify-center gap-1 text-[11px] text-[#a8987e]">
                    <Loader2 size={16} className="animate-spin" />
                    暂无思考过程数据
                  </div>
                ) : (
                  groups.map((g) => {
                    const meta = TYPE_META[g.key];
                    const Icon = meta.icon;
                    return (
                      <div key={g.key}>
                        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold" style={{ color: meta.color }}>
                          <Icon size={12} />
                          {meta.label}
                          <span className="text-[9px] font-normal text-[#a8987e]">({g.items.length})</span>
                        </div>
                        <div className="space-y-1">
                          {g.items.map((s) => {
                            const ok = s.status === "ok";
                            return (
                              <div
                                key={s.id}
                                className="rounded border border-[#e0d5c0]/70 bg-[#f5f0e6]/40 px-2 py-1.5"
                              >
                                <div className="flex items-center gap-1.5">
                                  {ok ? (
                                    <CheckCircle2 size={12} className="shrink-0 text-[#4a6b3f]" />
                                  ) : (
                                    <XCircle size={12} className="shrink-0 text-[#b8533a]" />
                                  )}
                                  <span className={`min-w-0 flex-1 truncate text-[11px] font-semibold ${ok ? "text-[#6b5b3e]" : "text-[#b8533a]"}`}>
                                    {s.name}
                                  </span>
                                  <span className="shrink-0 text-[9px] tabular-nums text-[#a8987e]">
                                    {fmtClock(s.startedAt)}
                                  </span>
                                  <span className="shrink-0 rounded px-1 py-px text-[9px] tabular-nums text-[#8b7a5e]"
                                    style={{ backgroundColor: ok ? "rgba(74,107,63,0.12)" : "rgba(184,83,58,0.15)" }}
                                  >
                                    {s.durationMs}ms
                                  </span>
                                </div>
                                {s.summary && (
                                  <p className="mt-0.5 pl-[18px] text-[9px] leading-snug text-[#8b7a5e]">
                                    {s.summary}
                                  </p>
                                )}
                                {s.params && Object.keys(s.params).length > 0 && (
                                  <div className="mt-0.5 flex flex-wrap gap-1 pl-[18px]">
                                    {Object.entries(s.params).map(([k, v]) => (
                                      <span
                                        key={k}
                                        className="truncate rounded bg-[#ede4d4] px-1 py-px text-[8px] text-[#8b7a5e]"
                                        title={`${k}: ${String(v)}`}
                                      >
                                        {k}={Array.isArray(v) ? v.join("/") : String(v)}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* 底部 */}
              <footer className="flex shrink-0 items-center gap-2 border-t border-[#e0d5c0] bg-[#f5f0e6]/60 px-4 py-2 text-[9px] text-[#a8987e]">
                <span>数据已脱敏，仅展示资源/工具/耗时，不含密钥与原始响应。</span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="ml-auto rounded border border-[#d4943a]/40 px-2 py-0.5 text-[10px] text-[#6b5b3e] transition-colors hover:border-[#d4943a]/70"
                >
                  关闭
                </button>
              </footer>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}