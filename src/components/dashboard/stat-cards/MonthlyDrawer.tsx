"use client";

interface Props {
  data: {
    current_earnings: number;
    projected: number;
    days_remaining: number;
    avg_daily_rate: number;
    missed?: {
      total_count: number;
      renter_cancelled_pending_count: number;
      failed_security_checks_count: number;
      scheduled_month: string;
    };
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function MonthlyDrawer({ data }: Props) {
  const stats = [
    { label: "Earned this month", value: gbp(data.current_earnings), highlight: true },
    { label: "Projected total", value: gbp(data.projected), highlight: false },
    { label: "Days remaining", value: String(data.days_remaining), highlight: false },
    { label: "Avg daily rate", value: gbp(data.avg_daily_rate), highlight: false },
  ];

  return (
    <div className="text-sm text-slate-300 grid grid-cols-2 gap-2">
      {stats.map((s) => (
        <div key={s.label} className="bg-slate-800/60 rounded p-3">
          <div className="text-xs text-slate-500 mb-1">{s.label}</div>
          <div className={`text-lg font-semibold ${s.highlight ? "text-emerald-400" : "text-slate-200"}`}>
            {s.value}
          </div>
        </div>
      ))}
      {data.missed && (
        <div className="col-span-2 rounded border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-rose-300/60">
            Missed scheduled rentals · {data.missed?.scheduled_month}
          </div>
          <div className="mt-1 text-xs text-rose-200/80">
            {data.missed.total_count === 0
              ? "No renter-cancelled pending requests or failed security checks scheduled this month."
              : <>
                  {data.missed.renter_cancelled_pending_count ? `${data.missed.renter_cancelled_pending_count} renter-cancelled pending ${data.missed.renter_cancelled_pending_count === 1 ? "request" : "requests"}` : null}
                  {data.missed.renter_cancelled_pending_count && data.missed.failed_security_checks_count ? " · " : null}
                  {data.missed.failed_security_checks_count ? `${data.missed.failed_security_checks_count} failed security ${data.missed.failed_security_checks_count === 1 ? "check" : "checks"}` : null}
                </>}
          </div>
          <div className="mt-1 text-[9px] text-rose-200/50">Count only — not added to expected or realised revenue.</div>
        </div>
      )}
    </div>
  );
}
