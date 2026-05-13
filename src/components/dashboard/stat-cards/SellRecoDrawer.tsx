"use client";

interface Recommendation {
  item_name: string;
  reason: string;
  suggested_price_gbp: number;
}

interface Props {
  data: {
    recommendations: Recommendation[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function SellRecoDrawer({ data }: Props) {
  if (data.recommendations.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic py-4 text-center">
        No data yet — wiring pending in next session.
      </div>
    );
  }

  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">
        {data.recommendations.length} sell recommendation{data.recommendations.length !== 1 ? "s" : ""}
      </div>
      <div className="space-y-2">
        {data.recommendations.map((r, i) => (
          <div key={i} className="py-1.5 border-b border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-200 truncate">{r.item_name}</span>
              <span className="text-xs font-medium text-emerald-400 whitespace-nowrap">
                {gbp(r.suggested_price_gbp)}
              </span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 truncate">{r.reason}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
