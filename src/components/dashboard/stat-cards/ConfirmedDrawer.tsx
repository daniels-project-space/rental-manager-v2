"use client";

interface ConfirmedRental {
  reservation_id: string;
  renter_name: string;
  start_date: string;
  end_date: string;
  gross: number;
}

interface Props {
  data: {
    month_count: number;
    rentals: ConfirmedRental[];
  };
}

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function ConfirmedDrawer({ data }: Props) {
  const sorted = data.rentals.slice().sort(
    (a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime()
  );

  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">{data.month_count} confirmed this month</div>
      {sorted.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No confirmed rentals.</div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700">
              <th className="text-left py-1 pr-2">Renter</th>
              <th className="text-left py-1 pr-2">Dates</th>
              <th className="text-right py-1">Gross</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.reservation_id} className="even:bg-slate-900/30">
                <td className="py-1 pr-2">{r.renter_name}</td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
                </td>
                <td className="py-1 text-right text-emerald-400">{gbp(r.gross)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
