"use client";

interface DeniedItem {
  reservation_id: string;
  renter_name: string;
  gross: number;
  reason: string;
}

interface Props {
  data: {
    total_gbp: number;
    items: DeniedItem[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function DeniedRevenueDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-red-400">{gbp(data.total_gbp)}</span>
        <span className="text-xs text-slate-500">total denied revenue</span>
      </div>
      {data.items.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No denied revenue items.</div>
      ) : (
        <div className="space-y-1.5">
          {data.items.map((item) => (
            <div
              key={item.reservation_id}
              className="flex items-start justify-between gap-2 py-1.5 border-b border-slate-800"
            >
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-200">{item.renter_name}</div>
                <div className="text-[10px] text-slate-500 truncate">{item.reason}</div>
              </div>
              <div className="text-xs font-medium text-red-400 whitespace-nowrap">{gbp(item.gross)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
