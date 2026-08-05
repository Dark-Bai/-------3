import { Link } from "react-router";
import { ArrowLeft, Activity, Github, Maximize2, Minimize2, Sparkles, Loader2 } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useClock } from "@/hooks/useClock";
import { isTv } from "@/lib/tv";

type Accent = "gold" | "green";

const SUBTITLE_CLASS: Record<Accent, string> = {
  gold: "text-[#d4943a]/80",
  green: "text-[#4a6b3f]/80",
};

const LINK_HOVER_CLASS: Record<Accent, string> = {
  gold: "hover:border-[#4a6b3f]/60 hover:text-[#4a6b3f]",
  green: "hover:border-[#d4943a]/60 hover:text-[#d4943a]",
};

/** 驾驶舱报头 — 复古报刊风格 */
export function DashboardHeader({
  title,
  subtitle,
  accent,
  tagline,
  linkTo,
  linkLabel,
  links,
  linkBack = false,
  live = false,
  githubUrl,
  isFullscreen,
  onToggleFullscreen,
  onToggleMonitor,
  monitorActive = false,
  monitorAlert = false,
  onTogglePhilia,
  philiaActive = false,
  philiaAlert = false,
  philiaAnalyzing = false,
}: {
  title: string;
  subtitle: string;
  accent: Accent;
  tagline: string;
  linkTo: string;
  linkLabel: string;
  links?: { to: string; label: string }[];
  linkBack?: boolean;
  live?: boolean;
  githubUrl?: string;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleMonitor?: () => void;
  monitorActive?: boolean;
  monitorAlert?: boolean;
  onTogglePhilia?: () => void;
  philiaActive?: boolean;
  philiaAlert?: boolean;
  philiaAnalyzing?: boolean;
}) {
  const now = useClock(isTv ? 60000 : 1000);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];

  return (
    <header className="titlebar flex h-9 shrink-0 items-center gap-3 border-b border-[#e0d5c0] bg-gradient-to-r from-[#f5f0e6] via-[#faf6ee] to-[#f5f0e6]">
      <div className="flex items-center gap-2.5">
        <Logo size={22} className="rounded-[4px] shadow-[0_0_8px_rgba(212,148,58,0.3)]" />
        <h1 className="text-[13px] font-bold tracking-wider text-[#6b5b3e] font-newspaper-heading">
          {title}
          <span className={`ml-2 text-[8px] font-medium tracking-[0.2em] ${SUBTITLE_CLASS[accent]}`}>{subtitle}</span>
        </h1>
      </div>
      <div className="mx-1 h-4 w-px bg-[#e0d5c0]" />
      <div className="hidden items-center gap-3 text-[10px] text-[#8b7a5e] lg:flex">
        <span>{tagline}</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {(links ?? [{ to: linkTo, label: linkLabel }]).map((l, i) => (
          <Link
            key={l.to}
            to={l.to}
            {...(isTv ? { "data-tv-focusable": true, tabIndex: -1 } : {})}
            className={`flex items-center gap-1 rounded border border-[#e0d5c0] bg-[#ede4d4] px-2 py-1 text-[10px] text-[#8b7a5e] transition-colors ${LINK_HOVER_CLASS[accent]}`}
          >
            {linkBack && i === 0 && <ArrowLeft size={10} />}
            {l.label}
          </Link>
        ))}
        {live && (
          <span className="flex items-center gap-1.5 text-[10px] text-[#4a6b3f]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4a6b3f] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#4a6b3f]" />
            </span>
            实时行情
          </span>
        )}
        <span className="hidden text-[10px] text-[#8b7a5e] md:inline" style={{ fontVariantNumeric: "tabular-nums" }}>
          {dateStr} 星期{week}
        </span>
        <span className="rounded border border-[#e0d5c0] bg-[#ede4d4] px-2 py-px font-mono text-[12px] font-bold text-[#d4943a]">
          {hh}:{mm}{isTv ? "" : <span className="text-[#c9b99a]">:{ss}</span>}
        </span>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub 仓库"
            className="flex h-[22px] w-[22px] items-center justify-center rounded border border-[#e0d5c0] bg-[#ede4d4] text-[#8b7a5e] transition-colors hover:border-[#d4943a]/60 hover:text-[#d4943a]"
          >
            <Github size={12} />
          </a>
        )}
        {onTogglePhilia && (
          <button
            onClick={onTogglePhilia}
            title={philiaActive ? "PHILIA AI 综合分析" : "PHILIA AI 综合分析（未配置 Key）"}
            className={`relative flex h-[22px] w-[22px] items-center justify-center rounded border transition-colors ${
              philiaAnalyzing
                ? "border-[#d4943a]/60 bg-[#d4943a]/10 text-[#d4943a]"
                : philiaActive
                ? "border-[#4a6b3f]/60 bg-[#4a6b3f]/10 text-[#4a6b3f]"
                : "border-[#e0d5c0] bg-[#ede4d4] text-[#8b7a5e] hover:border-[#d4943a]/60 hover:text-[#d4943a]"
            }`}
          >
            {philiaAnalyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {philiaAlert && !philiaActive && !philiaAnalyzing && (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#d4943a]" />
            )}
          </button>
        )}
        {onToggleMonitor && (
          <button
            onClick={onToggleMonitor}
            title={monitorActive ? "关闭系统监控" : "打开系统监控"}
            className={`relative flex h-[22px] w-[22px] items-center justify-center rounded border transition-colors ${
              monitorActive
                ? "border-[#4a6b3f]/60 bg-[#4a6b3f]/10 text-[#4a6b3f]"
                : "border-[#e0d5c0] bg-[#ede4d4] text-[#8b7a5e] hover:border-[#4a6b3f]/60 hover:text-[#4a6b3f]"
            }`}
          >
            <Activity size={12} />
            {monitorAlert && !monitorActive && (
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#b8533a]" />
            )}
          </button>
        )}
        <button
          onClick={onToggleFullscreen}
          title={isFullscreen ? "退出全屏" : "全屏显示"}
          className="flex h-[22px] w-[22px] items-center justify-center rounded border border-[#e0d5c0] bg-[#ede4d4] text-[#8b7a5e] transition-colors hover:border-[#d4943a]/60 hover:text-[#d4943a]"
        >
          {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>
    </header>
  );
}