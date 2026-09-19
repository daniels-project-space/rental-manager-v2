"use client";

interface MissedItem {
  reservation_id: string;
  renter_name: string;
  gross: number;
  reason: string;
}

interface Props {
  data: {
    total_gbp: number;
    items: MissedItem[];
    operational_losses?: {
      renter_cancelled_pending_count: number;
      failed_security_checks_count: number;
      period_days: number;
    };
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function MissedRevenueDrawer({ data }: Props) {
  const losses = data.operational_losses;
  const hasOperationalLosses =
    (losses?.renter_cancelled_pending_count ?? 0) > 0 ||
    (losses?.failed_security_checks_count ?? 0) > 0;

  if (data.items.length === 0 && !hasOperationalLosses) {
    return (
      <div className="text-xs text-slate-500 italic py-4 text-center">
        No missed revenue or platform/renter fallout in this period.
      </div>
    );
  }

  return (
    <div className="text-sm text-slate-300 space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold text-amber-400">{gbp(data.total_gbp)}</span>
        <span className="text-xs text-slate-500">total missed revenue</span>
      </div>
      {hasOperationalLosses && losses && (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/[0.06] px-2.5 py-2 text-[11px] text-rose-200/80">
          <div className="mb-1 text-[9px] uppercase tracking-wider text-rose-300/60">
            Platform / renter fallout · last {losses.period_days} days
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {losses.renter_cancelled_pending_count > 0 && (
              <span>{losses.renter_cancelled_pending_count} renter-cancelled pending {losses.renter_cancelled_pending_count === 1 ? "request" : "requests"}</span>
            )}
            {losses.failed_security_checks_count > 0 && (
              <span>{losses.failed_security_checks_count} failed security {losses.failed_security_checks_count === 1 ? "check" : "checks"}</span>
            )}
          </div>
          <div className="mt-1 text-[9px] text-rose-200/50">Counts only — excluded from all revenue totals.</div>
        </div>
      )}
      {data.items.length > 0 && (
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
              <div className="text-xs font-medium text-amber-400 whitespace-nowrap">{gbp(item.gross)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
