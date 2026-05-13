"use client";

interface CategoryValue {
  kind: string;
  value: number;
}

interface Props {
  data: {
    total_gbp: number;
    by_category: CategoryValue[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function InventoryWorthDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-slate-100">{gbp(data.total_gbp)}</span>
        <span className="text-xs text-slate-500">total inventory value</span>
      </div>
      {data.by_category.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No category breakdown available.</div>
      ) : (
        <div className="space-y-1">
          {data.by_category.map((c) => (
            <div
              key={c.kind}
              className="flex items-center justify-between py-1.5 border-b border-slate-800"
            >
              <span className="text-xs text-slate-300 capitalize">{c.kind}</span>
              <span className="text-xs font-medium text-slate-200">{gbp(c.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
