"use client";

interface BreakdownItem {
  source: string;
  amount: number;
}

interface Props {
  data: {
    total_uplift_gbp: number;
    breakdown: BreakdownItem[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function AiBoostDrawer({ data }: Props) {
  if (data.breakdown.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic py-4 text-center">
        No data yet — wiring pending in next session.
      </div>
    );
  }

  const max = Math.max(...data.breakdown.map((b) => b.amount), 1);

  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-violet-400">{gbp(data.total_uplift_gbp)}</span>
        <span className="text-xs text-slate-500">total AI uplift</span>
      </div>
      <div className="space-y-2">
        {data.breakdown.map((b) => {
          const pct = Math.round((b.amount / max) * 100);
          return (
            <div key={b.source}>
              <div className="flex justify-between text-xs mb-0.5">
                <span className="text-slate-300">{b.source}</span>
                <span className="text-violet-400">{gbp(b.amount)}</span>
              </div>
              <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-violet-500 rounded-full"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
