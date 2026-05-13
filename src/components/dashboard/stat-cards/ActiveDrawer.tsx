"use client";

interface Rental {
  reservation_id: string;
  renter_name: string;
  account_slug: string;
  start_date: string;
  end_date: string;
  items: string[];
  order_step: string;
}

interface Props {
  data: {
    total: number;
    rentals: Rental[];
  };
}

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

const accountColor: Record<string, string> = {
  dbcinema: "bg-blue-900/60 text-blue-300",
  leo: "bg-purple-900/60 text-purple-300",
};

export default function ActiveDrawer({ data }: Props) {
  const grouped: Record<string, Rental[]> = {};
  for (const r of data.rentals) {
    (grouped[r.account_slug] ??= []).push(r);
  }

  const rows = data.rentals
    .slice()
    .sort((a, b) => a.account_slug.localeCompare(b.account_slug));
  const visible = rows.slice(0, 8);
  const overflow = rows.length - visible.length;

  return (
    <div className="text-sm text-slate-300 space-y-2">
      <div className="text-xs text-slate-400 mb-1">{data.total} active rental{data.total !== 1 ? "s" : ""}</div>
      {visible.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No active rentals.</div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-slate-500 border-b border-slate-700">
              <th className="text-left py-1 pr-2">Renter</th>
              <th className="text-left py-1 pr-2">Items</th>
              <th className="text-left py-1 pr-2">Dates</th>
              <th className="text-left py-1">Step</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.reservation_id} className="even:bg-slate-900/30">
                <td className="py-1 pr-2">
                  <div>{r.renter_name}</div>
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                      accountColor[r.account_slug] ?? "bg-slate-700 text-slate-300"
                    }`}
                  >
                    {r.account_slug}
                  </span>
                </td>
                <td className="py-1 pr-2 max-w-[120px] truncate">
                  {r.items.slice(0, 2).join(", ")}
                  {r.items.length > 2 ? ` +${r.items.length - 2}` : ""}
                </td>
                <td className="py-1 pr-2 whitespace-nowrap">
                  {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
                </td>
                <td className="py-1 text-slate-400">{r.order_step}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {overflow > 0 && (
        <div className="text-xs text-slate-500 text-right">+ {overflow} more</div>
      )}
    </div>
  );
}
