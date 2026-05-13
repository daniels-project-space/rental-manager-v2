"use client";

interface Rental {
  reservation_id: string;
  renter_name: string | null;
  account_slug: string;
  start_date: string;
  end_date: string;
  items: string[];
  order_step: string | null;
  is_ongoing?: boolean;
}

interface Props {
  data: {
    total: number;
    ongoing_count?: number;
    upcoming_count?: number;
    pending_count?: number;
    rentals: Rental[];
  };
}

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

const ACCOUNT_PILL: Record<string, { bg: string; text: string; dot: string }> = {
  dbcinema: { bg: "bg-blue-900/60", text: "text-blue-300", dot: "bg-blue-400" },
  leo:      { bg: "bg-purple-900/60", text: "text-purple-300", dot: "bg-purple-400" },
};

export default function ActiveDrawer({ data }: Props) {
  const ongoing = data.ongoing_count ?? 0;
  const upcoming = data.upcoming_count ?? 0;
  const pending = data.pending_count ?? 0;
  const segTotal = ongoing + upcoming + pending;

  // Segment widths (min 4% so a single tiny segment still shows)
  const seg = (n: number) => (segTotal === 0 ? 0 : Math.max(n > 0 ? 4 : 0, (n / segTotal) * 100));
  const wOngoing = seg(ongoing);
  const wUpcoming = seg(upcoming);
  const wPending = seg(pending);

  // Group + sort: ongoing first within each account, then by start_date
  const grouped: Record<string, Rental[]> = {};
  for (const r of data.rentals) (grouped[r.account_slug] ??= []).push(r);
  for (const slug of Object.keys(grouped)) {
    grouped[slug].sort((a, b) => {
      if ((b.is_ongoing ? 1 : 0) !== (a.is_ongoing ? 1 : 0)) return (b.is_ongoing ? 1 : 0) - (a.is_ongoing ? 1 : 0);
      return a.start_date.localeCompare(b.start_date);
    });
  }
  const slugs = Object.keys(grouped).sort();

  return (
    <div className="text-sm text-slate-300 space-y-3">
      {/* ── Segmented bar ─────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
          <span>{data.total} active</span>
          <span>{segTotal} tracked</span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-900/60">
          {wOngoing > 0 && (
            <div
              className="bg-emerald-500"
              style={{ width: `${wOngoing}%` }}
              title={`Ongoing: ${ongoing}`}
            />
          )}
          {wUpcoming > 0 && (
            <div
              className="bg-sky-500"
              style={{ width: `${wUpcoming}%` }}
              title={`Upcoming: ${upcoming}`}
            />
          )}
          {wPending > 0 && (
            <div
              className="bg-amber-500"
              style={{ width: `${wPending}%` }}
              title={`Pending: ${pending}`}
            />
          )}
        </div>
        <div className="flex gap-3 text-[11px]">
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="text-slate-400">Ongoing</span><span className="text-emerald-300 font-semibold">{ongoing}</span></span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-sky-500" /><span className="text-slate-400">Upcoming</span><span className="text-sky-300 font-semibold">{upcoming}</span></span>
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /><span className="text-slate-400">Pending</span><span className="text-amber-300 font-semibold">{pending}</span></span>
        </div>
      </div>

      {/* ── Grouped tiles ─────────────────────────────────────────── */}
      {data.rentals.length === 0 ? (
        <div className="text-xs text-slate-500 italic py-4 text-center">No active rentals.</div>
      ) : (
        <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
          {slugs.map((slug) => {
            const pill = ACCOUNT_PILL[slug] ?? { bg: "bg-slate-800", text: "text-slate-300", dot: "bg-slate-500" };
            const rentals = grouped[slug];
            return (
              <div key={slug} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${pill.bg} ${pill.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
                    {slug}
                  </span>
                  <span className="text-[10px] text-slate-500">{rentals.length} rental{rentals.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {rentals.slice(0, 6).map((r) => (
                    <div
                      key={r.reservation_id}
                      className="flex items-center gap-2 rounded-lg border border-slate-800/80 bg-slate-900/40 px-2.5 py-1.5"
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${r.is_ongoing ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-sky-400"}`}
                        title={r.is_ongoing ? "Ongoing" : "Upcoming"}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-slate-200 truncate">
                          {r.items.slice(0, 1).join("") || "(no item)"}
                          {r.items.length > 1 && <span className="text-slate-500"> +{r.items.length - 1}</span>}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {r.renter_name ? r.renter_name + " · " : ""}
                          {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
                        </div>
                      </div>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          r.is_ongoing ? "bg-emerald-900/40 text-emerald-300" : "bg-sky-900/40 text-sky-300"
                        }`}
                      >
                        {r.is_ongoing ? "Live" : "Soon"}
                      </span>
                    </div>
                  ))}
                  {rentals.length > 6 && (
                    <div className="text-[10px] text-slate-500 pl-2">+ {rentals.length - 6} more in {slug}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
