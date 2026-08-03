/** 面板加载态: 骨架行(bg-[#ede4d4] h-3 rounded) + 11px slate-600 提示 */
export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex h-full flex-col gap-[6px] p-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-3 shrink-0 rounded bg-[#ede4d4]" style={{ width: `${88 - (i % 3) * 12}%` }} />
      ))}
      <div className="mt-auto pt-1 text-center text-[11px] text-[#a8987e]">数据加载中…</div>
    </div>
  );
}
