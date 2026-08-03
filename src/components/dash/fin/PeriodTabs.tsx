import { useFin } from "./FinContext";

/** 宏观面板共用报告期切换(当期·披露中 / 上一期·全市场), 状态在 FinContext 同步 */
export function PeriodTabs() {
  const { period, setPeriod, periods } = useFin();
  return (
    <div className="flex items-center gap-1 text-[10px]">
      {periods.map((p) => (
        <button
          key={p.value}
          onClick={() => setPeriod(p.value)}
          className={`flex h-[22px] items-center rounded px-2 ${
            period === p.value ? "bg-[#d4943a]/20 text-[#d4943a]" : "text-[#8b7a5e] hover:text-[#6b5b3e]"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
