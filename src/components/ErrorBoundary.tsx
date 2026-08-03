import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** 根级错误边界: 外部数据异常导致的渲染错误不再整屏白屏, 给出重载入口 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#070b12] text-slate-400">
          <div className="text-[13px]">页面渲染异常：{error.message}</div>
          <button
            onClick={() => window.location.reload()}
            className="rounded border border-slate-700 px-3 py-1 text-[12px] transition hover:border-cyan-500/50 hover:text-cyan-300"
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
