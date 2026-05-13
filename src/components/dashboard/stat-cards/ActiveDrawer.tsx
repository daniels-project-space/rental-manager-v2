"use client";

import Image from "next/image";

type Kind = "ongoing" | "upcoming" | "pending";

interface Rental {
  reservation_id: string;
  renter_name: string | null;
  account_slug: string;
  start_date: string | null;
  end_date: string | null;
  pickup_date?: string | null;
  pickup_time?: string | null;
  return_time?: string | null;
  items: string[];
  photo_url?: string | null;
  duration_days?: number | null;
  net_gbp?: number | null;
  order_step?: string | null;
  kind?: Kind;
  is_ongoing?: boolean;
}

interface Props {
  data: {
    total: number;
    ongoing_count: number;
    upcoming_count: number;
    pending_count: number;
    pending_value_gbp?: number;
    rentals: Rental[];
  };
}

const ACCOUNT_PILL: Record<string, { bg: string; text: string }> = {
  dbcinema: { bg: "bg-blue-900/60 border border-blue-500/30", text: "text-blue-200" },
  leo:      { bg: "bg-amber-900/40 border border-amber-500/30", text: "text-amber-200" },
};

const SECTION: Record<Kind, { label: string; color: string; bg: string; border: string; ring: string }> = {
  ongoing:  { label: "ONGOING",  color: "#f59e0b", bg: "bg-amber-500/5",  border: "border-amber-500/20",  ring: "shadow-[inset_3px_0_0_#f59e0b]" },
  upcoming: { label: "UPCOMING", color: "#a78bfa", bg: "bg-violet-500/5", border: "border-violet-500/20", ring: "shadow-[inset_3px_0_0_#a78bfa]" },
  pending:  { label: "PENDING",  color: "#ec4899", bg: "bg-pink-500/5",   border: "border-pink-500/20",   ring: "shadow-[inset_3px_0_0_#ec4899]" },
};

const fmtDate = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));

const fmtTime = (t?: string | null) => {
  if (!t) return null;
  return t.length >= 5 ? t.slice(0, 5) : t;
};

export function RentalRow({ r }: { r: Rental }) {
  const kind: Kind = r.kind ?? (r.is_ongoing ? "ongoing" : "upcoming");
  const s = SECTION[kind];
  const pill = ACCOUNT_PILL[r.account_slug] ?? { bg: "bg-slate-800 border border-slate-700", text: "text-slate-300" };
  const item = r.items[0] ?? "(no item)";
  const more = r.items.length > 1 ? ` +${r.items.length - 1}` : "";

  return (
    <div
      className={`relative flex items-stretch gap-3 rounded-lg border ${s.border} ${s.bg} ${s.ring} px-2.5 py-2`}
    >
      {/* Thumbnail */}
      <div className="relative h-14 w-14 flex-shrink-0 overflow-hidden rounded-md bg-slate-900/60 ring-1 ring-slate-800">
        {r.photo_url ? (
          <Image
            src={r.photo_url}
            alt={item}
            fill
            sizes="56px"
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-600">
            no img
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-slate-100 truncate">
            {r.renter_name ?? "—"}
          </span>
          {r.start_date && r.end_date && (
            <span className="text-[11px] text-slate-400">
              {fmtDate(r.start_date)} – {fmtDate(r.end_date)}
            </span>
          )}
          {r.duration_days != null && (
            <span className="text-[10px] text-slate-500">({r.duration_days}d)</span>
          )}
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${pill.bg} ${pill.text}`}>
            {r.account_slug}
          </span>
        </div>
        <div className="text-[11px] text-slate-400 truncate">
          {item}
          {more && <span className="text-slate-500">{more}</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-sky-300">
          {r.pickup_date && (
            <span className="inline-flex items-center gap-1">
              ↓{fmtTime(r.pickup_time) ?? "—"}, {fmtDate(r.pickup_date)}
            </span>
          )}
          {r.end_date && (
            <span className="inline-flex items-center gap-1">
              ↑{fmtTime(r.return_time) ?? "—"}, {fmtDate(r.end_date)}
            </span>
          )}
        </div>
      </div>

      {/* Price */}
      <div className="flex flex-col items-end justify-center">
        <div className="text-base font-bold text-emerald-400 tabular-nums">
          {r.net_gbp != null ? "£" + Math.round(r.net_gbp) : "—"}
        </div>
      </div>
    </div>
  );
}

export default function ActiveDrawer({ data }: Props) {
  const groups: Record<Kind, Rental[]> = { ongoing: [], upcoming: [], pending: [] };
  for (const r of data.rentals) {
    const k: Kind = r.kind ?? (r.is_ongoing ? "ongoing" : "upcoming");
    groups[k].push(r);
  }
  for (const k of Object.keys(groups) as Kind[]) {
    groups[k].sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));
  }

  const sections: Array<{ kind: Kind; count: number }> = [
    { kind: "ongoing", count: data.ongoing_count },
    { kind: "upcoming", count: data.upcoming_count },
    { kind: "pending", count: data.pending_count },
  ];

  const anyRows = data.rentals.length > 0;

  if (!anyRows) {
    return <div className="text-xs text-slate-500 italic py-4 text-center">No active rentals.</div>;
  }

  return (
    <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
      {sections.map(({ kind, count }) => {
        const s = SECTION[kind];
        const rows = groups[kind];
        if (rows.length === 0) return null;
        return (
          <div key={kind} className="space-y-1.5">
            <div className="flex items-center gap-2 px-0.5">
              <span
                className="text-[11px] font-bold tracking-wider uppercase"
                style={{ color: s.color, textShadow: `0 0 8px ${s.color}40` }}
              >
                {s.label} ({count})
              </span>
            </div>
            <div className="space-y-1.5">
              {rows.map((r) => (
                <RentalRow key={r.reservation_id} r={r} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
