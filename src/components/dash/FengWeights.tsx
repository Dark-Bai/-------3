import { useEffect, useRef, useState } from "react";
import { FENG_DIM_LABELS, type FengDimKey, type FengWeights } from "@/hooks/useFengWeights";

const TNUM = { fontVariantNumeric: "tabular-nums" } as const;

/** 风口权重调节入口 — 面板标题栏右侧按钮 + 下拉滑杆面板 */
export function FengWeights({ weights, normalized, setWeight, reset }: FengWeights) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击面板外或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="风口权重设置"
        className={`flex h-[22px] items-center gap-1 rounded border px-1.5 text-[10px] transition-colors ${
          open
            ? "border-[#d4943a]/60 bg-[#d4943a]/10 text-[#d4943a]"
            : "border-[#e0d5c0] bg-[#ede4d4] text-[#8b7a5e] hover:border-[#d4943a]/60 hover:text-[#d4943a]"
        }`}
      >
        ⚙ 权重
      </button>

      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 w-56 rounded border border-[#e0d5c0] bg-[#faf6ee] p-2.5 shadow-newspaper">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-[#6b5b3e]">风口权重</span>
            <button
              type="button"
              onClick={reset}
              className="text-[10px] text-[#d4943a] hover:underline"
            >
              重置
            </button>
          </div>

          {(Object.keys(FENG_DIM_LABELS) as FengDimKey[]).map((k) => (
            <label key={k} className="mb-1.5 block">
              <div className="flex items-center justify-between text-[10px] text-[#8b7a5e]">
                <span>{FENG_DIM_LABELS[k]}</span>
                <span style={TNUM}>{normalized[k].toFixed(0)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={weights[k]}
                onChange={(e) => setWeight(k, Number(e.target.value))}
                className="w-full accent-[#d4943a]"
              />
            </label>
          ))}

          <div className="flex items-center justify-between border-t border-[#e0d5c0] pt-1.5 text-[10px] text-[#a8987e]">
            <span>合计</span>
            <span style={TNUM}>100%</span>
          </div>
        </div>
      )}
    </div>
  );
}