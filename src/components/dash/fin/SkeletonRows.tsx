/** 面板加载态: 骨架行(bg-slate-800/40 h-3 rounded) + 11px slate-600 提示 */
export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex h-full flex-col gap-[6px] p-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-3 shrink-0 rounded bg-slate-800/40" style={{ width: `${88 - (i % 3) * 12}%` }} />
      ))}
      <div className="mt-auto pt-1 text-center text-[11px] text-slate-600">数据加载中…</div>
    </div>
  );
}
