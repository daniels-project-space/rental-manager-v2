"use client";

import { useState } from "react";

interface ConflictReservation {
  reservation_id: string;
  kind: "ongoing" | "upcoming" | "pending";
  renter_name: string | null;
  account_slug: string;
  start_date: string;
  end_date: string;
}

interface Conflict {
  item_canonical: string;
  qty: number;
  conflict_start: string;
  conflict_end: string;
  overlap_count: number;
  reservations: ConflictReservation[];
}

interface UntrackedReservation {
  reservation_id: string;
  renter_name: string | null;
  account_slug: string;
  start_date: string | null;
  end_date: string | null;
  items: string[];
  net_gbp: number | null;
}

interface Props {
  conflicts: Conflict[];
  untracked: {
    count: number;
    total_value_gbp: number;
    reservations: UntrackedReservation[];
  };
}

const fmtDate = (d: string | null) => {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));
};

const fmtGbp = (n: number) => "£" + Math.round(n).toLocaleString("en-GB");

export function CriticalAlerts({ conflicts, untracked }: Props) {
  const hasConflicts = conflicts.length > 0;
  const hasUntracked = untracked.count > 0;
  if (!hasConflicts && !hasUntracked) return null;

  return (
    <>
      {/* Local keyframes for the pulsating ring */}
      <style jsx>{`
        @keyframes pulseRing {
          0%   { box-shadow: 0 0 0 0   rgba(239,68,68,0.55), inset 0 0 0 1px rgba(239,68,68,0.4); }
          70%  { box-shadow: 0 0 0 14px rgba(239,68,68,0),   inset 0 0 0 1px rgba(239,68,68,0.4); }
          100% { box-shadow: 0 0 0 0   rgba(239,68,68,0),   inset 0 0 0 1px rgba(239,68,68,0.4); }
        }
        @keyframes pulseDot {
          0%, 100% { transform: scale(1);   opacity: 1; }
          50%      { transform: scale(1.4); opacity: 0.6; }
        }
        .pulse-ring { animation: pulseRing 2s ease-out infinite; }
        .pulse-dot  { animation: pulseDot 1.2s ease-in-out infinite; }
      `}</style>

      <div className="space-y-2 mb-3">
        {hasConflicts && (
          <ConflictsBanner conflicts={conflicts} />
        )}
        {hasUntracked && (
          <UntrackedBanner data={untracked} />
        )}
      </div>
    </>
  );
}

function ConflictsBanner({ conflicts }: { conflicts: Conflict[] }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div
      className="pulse-ring rounded-xl p-3"
      style={{
        background: "linear-gradient(135deg, rgba(239,68,68,0.16), rgba(190,18,60,0.12))",
        border: "1px solid rgba(239,68,68,0.45)",
      }}
    >
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center gap-2 text-left"
      >
        <span
          className="pulse-dot inline-block flex-shrink-0"
          style={{ width: 10, height: 10, borderRadius: 9999, background: "#ef4444" }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-rose-200">
            Double-booking alert · {conflicts.length} item{conflicts.length === 1 ? "" : "s"} oversold
          </div>
          <div className="text-xs text-rose-100 mt-0.5">
            Resolve before earliest conflict on {fmtDate(conflicts[0].conflict_start)} · click to {expanded ? "collapse" : "expand"}
          </div>
        </div>
        <span className="text-rose-300 text-sm" style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▾</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {conflicts.map((c) => (
            <ConflictRow key={`${c.item_canonical}-${c.conflict_start}`} conflict={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictRow({ conflict }: { conflict: Conflict }) {
  return (
    <div
      className="rounded-lg p-2.5"
      style={{ background: "rgba(0,0,0,0.32)", border: "1px solid rgba(239,68,68,0.3)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mb-1.5">
        <span className="text-sm font-semibold text-rose-50">{conflict.item_canonical}</span>
        <span className="text-[10px] uppercase tracking-wider text-rose-300 px-1.5 py-0.5 rounded" style={{ background: "rgba(239,68,68,0.18)", border: "1px solid rgba(239,68,68,0.3)" }}>
          qty {conflict.qty} · {conflict.overlap_count} booked
        </span>
        <span className="text-[11px] text-rose-200">
          conflict starts {fmtDate(conflict.conflict_start)}
        </span>
      </div>
      <div className="space-y-1">
        {conflict.reservations.map((r) => {
          const kindColor = r.kind === "ongoing" ? "#f59e0b" : r.kind === "upcoming" ? "#a78bfa" : "#ec4899";
          return (
            <div
              key={r.reservation_id}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1 rounded text-[11px]"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
            >
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] uppercase font-semibold"
                style={{ background: `${kindColor}22`, color: kindColor, border: `1px solid ${kindColor}55` }}
              >
                {r.kind}
              </span>
              <span className="text-rose-50 font-medium">{r.renter_name ?? "Unknown renter"}</span>
              <span className="text-rose-200">{fmtDate(r.start_date)} → {fmtDate(r.end_date)}</span>
              <span className="text-slate-400">[{r.account_slug}]</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UntrackedBanner({ data }: { data: Props["untracked"] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="rounded-xl p-3"
      style={{
        background: "linear-gradient(135deg, rgba(245,158,11,0.13), rgba(217,119,6,0.08))",
        border: "1px solid rgba(245,158,11,0.35)",
      }}
    >
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center gap-2 text-left"
      >
        <span
          className="inline-block flex-shrink-0"
          style={{ width: 8, height: 8, borderRadius: 9999, background: "#f59e0b" }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-amber-200">
            {data.count} pending claim{data.count === 1 ? "" : "s"} with items not in master inventory
          </div>
          <div className="text-xs text-amber-100/80 mt-0.5">
            {fmtGbp(data.total_value_gbp)} potential revenue · review whether to add these to inventory · click to {expanded ? "collapse" : "expand"}
          </div>
        </div>
        <span className="text-amber-300 text-sm" style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▾</span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-1.5">
          {data.reservations.map((r) => (
            <div
              key={r.reservation_id}
              className="rounded-md px-2 py-1.5 text-[11px]"
              style={{ background: "rgba(0,0,0,0.32)", border: "1px solid rgba(245,158,11,0.25)" }}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-semibold text-amber-100">{r.renter_name ?? "Unknown"}</span>
                <span className="text-amber-200">{fmtDate(r.start_date)} → {fmtDate(r.end_date)}</span>
                <span className="text-slate-400">[{r.account_slug}]</span>
                {r.net_gbp != null && <span className="text-amber-300 font-semibold">{fmtGbp(r.net_gbp)}</span>}
              </div>
              {r.items.length > 0 && (
                <div className="mt-0.5 text-slate-300 truncate">
                  {r.items.slice(0, 3).join(" + ")}{r.items.length > 3 ? ` +${r.items.length - 3}` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
