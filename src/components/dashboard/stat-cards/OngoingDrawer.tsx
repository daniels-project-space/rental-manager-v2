"use client";

interface OngoingRental {
  reservation_id: string;
  renter_name: string;
  start_date: string;
  end_date: string;
  items: string[];
  days_left: number;
}

interface Props {
  data: {
    count: number;
    rentals: OngoingRental[];
  };
}

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

function daysLeftColor(days: number): string {
  if (days <= 1) return "bg-red-900/60 text-red-300";
  if (days <= 3) return "bg-amber-900/60 text-amber-300";
  return "bg-emerald-900/60 text-emerald-300";
}

export default function OngoingDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">{data.count} ongoing rental{data.count !== 1 ? "s" : ""}</div>
      {data.rentals.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No ongoing rentals.</div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700">
              <th className="text-left py-1 pr-2">Renter</th>
              <th className="text-left py-1 pr-2">Items</th>
              <th className="text-left py-1 pr-2">Dates</th>
              <th className="text-left py-1">Left</th>
            </tr>
          </thead>
          <tbody>
            {data.rentals.map((r) => (
              <tr key={r.reservation_id} className="even:bg-slate-900/30">
                <td className="py-1 pr-2">{r.renter_name}</td>
                <td className="py-1 pr-2 max-w-[110px] truncate">
                  {r.items.slice(0, 2).join(", ")}
                  {r.items.length > 2 ? ` +${r.items.length - 2}` : ""}
                </td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
                </td>
                <td className="py-1">
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${daysLeftColor(r.days_left)}`}>
                    {r.days_left}d
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
