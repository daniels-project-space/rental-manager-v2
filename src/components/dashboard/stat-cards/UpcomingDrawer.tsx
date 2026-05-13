"use client";

interface UpcomingRental {
  reservation_id: string;
  renter_name: string;
  pickup_date: string;
  pickup_time: string;
  items: string[];
  days_until: number;
}

interface Props {
  data: {
    count: number;
    rentals: UpcomingRental[];
  };
}

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

const fmtTime = (t: string) => t.slice(0, 5); // HH:MM

export default function UpcomingDrawer({ data }: Props) {
  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">{data.count} upcoming pickup{data.count !== 1 ? "s" : ""}</div>
      {data.rentals.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No upcoming pickups.</div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700">
              <th className="text-left py-1 pr-2">Renter</th>
              <th className="text-left py-1 pr-2">Pickup</th>
              <th className="text-left py-1 pr-2">Time</th>
              <th className="text-left py-1 pr-2">Items</th>
              <th className="text-right py-1">In</th>
            </tr>
          </thead>
          <tbody>
            {data.rentals.map((r) => (
              <tr key={r.reservation_id} className="even:bg-slate-900/30">
                <td className="py-1 pr-2">{r.renter_name}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{fmtDate(r.pickup_date)}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(r.pickup_time)}</td>
                <td className="py-1 pr-2 max-w-[100px] truncate">
                  {r.items.slice(0, 2).join(", ")}
                  {r.items.length > 2 ? ` +${r.items.length - 2}` : ""}
                </td>
                <td className="py-1 text-right text-slate-400">{r.days_until}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
