"use client";

interface KPI {
  label: string;
  value: string;
  badge: "strong" | "moderate" | "watch";
}

interface Props {
  data: {
    kpis: KPI[];
  };
}

const badgeStyle: Record<KPI["badge"], string> = {
  strong: "bg-emerald-900/60 text-emerald-300",
  moderate: "bg-amber-900/60 text-amber-300",
  watch: "bg-red-900/60 text-red-300",
};

export default function BusinessIntelDrawer({ data }: Props) {
  if (data.kpis.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic py-4 text-center">
        No data yet — wiring pending in next session.
      </div>
    );
  }

  return (
    <div className="text-sm text-slate-300 grid grid-cols-2 gap-2">
      {data.kpis.map((kpi) => (
        <div key={kpi.label} className="bg-slate-800/60 rounded p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-slate-500 uppercase tracking-wide truncate mr-1">
              {kpi.label}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${badgeStyle[kpi.badge]}`}
            >
              {kpi.badge}
            </span>
          </div>
          <div className="text-sm font-semibold text-slate-100">{kpi.value}</div>
        </div>
      ))}
    </div>
  );
}
