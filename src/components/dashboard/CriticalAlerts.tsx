"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

interface ConflictReservation {
  reservation_id: string;
  kind: "ongoing" | "upcoming" | "pending";
  renter_name: string | null;
  account_slug: string;
  start_date: string;
  end_date: string;
  image_url?: string | null;
}

interface Conflict {
  conflict_key: string;
  item_id: string;
  item_canonical: string;
  item_image_url: string | null;
  /** "confirmed" = confirmed bookings alone exceed stock (live oversell).
   *  "pending" = only overbooks if a pending request gets accepted. */
  severity?: "confirmed" | "pending";
  qty: number;
  conflict_start: string;
  conflict_end: string;
  overlap_count: number;
  reservations: ConflictReservation[];
}

interface QtyDriftSample {
  reservation_id: string;
  hygglo_order_id: string;
  renter_name: string | null;
  drift_kind: "listing_count_lt_items" | "unique_sku_lt_items";
  raw_n: number;
  expanded_n: number;
}

interface Props {
  conflicts: Conflict[];
  qty_drift_count?: number;
  qty_drift_sample?: QtyDriftSample[];
}

const fmtDate = (d: string | null) => {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(new Date(d));
};

// ── per-severity theme ───────────────────────────────────────────────────────
type Variant = "confirmed" | "pending";
const THEME: Record<
  Variant,
  { base: string; ring: string; tintA: string; tintB: string; border: string; chipBg: string; title: string; sub: string; icon: string }
> = {
  confirmed: {
    base: "#ef4444",
    ring: "rgba(239,68,68,0.55)",
    tintA: "rgba(239,68,68,0.16)",
    tintB: "rgba(190,18,60,0.10)",
    border: "rgba(239,68,68,0.45)",
    chipBg: "rgba(239,68,68,0.18)",
    title: "Double-booked",
    sub: "confirmed bookings exceed stock — fix now",
    icon: "⛔",
  },
  pending: {
    base: "#f59e0b",
    ring: "rgba(245,158,11,0.45)",
    tintA: "rgba(245,158,11,0.13)",
    tintB: "rgba(217,119,6,0.08)",
    border: "rgba(245,158,11,0.38)",
    chipBg: "rgba(245,158,11,0.18)",
    title: "Pending may double-book",
    sub: "accepting a pending request would oversell",
    icon: "⚠",
  },
};

const KIND_COLOR: Record<ConflictReservation["kind"], string> = {
  ongoing: "#f59e0b",
  upcoming: "#a78bfa",
  pending: "#ec4899",
};

export function CriticalAlerts({ conflicts, qty_drift_count = 0, qty_drift_sample = [] }: Props) {
  // Treat a missing severity (older backend during a deploy) as confirmed so
  // nothing is silently downgraded.
  const confirmed = conflicts.filter((c) => c.severity !== "pending");
  const pending = conflicts.filter((c) => c.severity === "pending");
  const hasDrift = qty_drift_count > 0;
  if (!confirmed.length && !pending.length && !hasDrift) return null;

  return (
    <>
      <style jsx>{`
        @keyframes obPulse {
          0% { box-shadow: 0 0 0 0 var(--ring); }
          70% { box-shadow: 0 0 0 10px rgba(0, 0, 0, 0); }
          100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0); }
        }
        .ob-pulse { animation: obPulse 2.2s ease-out infinite; }
      `}</style>

      <div className="space-y-2 mb-3">
        {confirmed.length > 0 && <OverbookBanner conflicts={confirmed} variant="confirmed" />}
        {pending.length > 0 && <OverbookBanner conflicts={pending} variant="pending" />}
        {hasDrift && <QtyDriftBadge count={qty_drift_count} sample={qty_drift_sample} />}
      </div>
    </>
  );
}

// ── capacity meter: stock slots filled + overage slots in the alert colour ───
function CapacityMeter({ qty, booked, color }: { qty: number; booked: number; color: string }) {
  const total = Math.min(Math.max(booked, qty), 16);
  const over = Math.max(booked - qty, 0);
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-[3px]">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            style={{
              width: 13,
              height: 7,
              borderRadius: 2,
              background: i < qty ? "rgba(255,255,255,0.22)" : color,
              boxShadow: i < qty ? "none" : `0 0 6px ${color}88`,
            }}
          />
        ))}
      </div>
      <span className="text-[11px] font-bold tabular-nums" style={{ color }}>
        {booked}/{qty}
      </span>
      {over > 0 && (
        <span className="text-[10px] font-semibold" style={{ color }}>
          +{over} over
        </span>
      )}
    </div>
  );
}

function OverbookBanner({ conflicts, variant }: { conflicts: Conflict[]; variant: Variant }) {
  const t = THEME[variant];
  const [expanded, setExpanded] = useState(false);
  const earliest = conflicts.map((c) => c.conflict_start).sort()[0];
  return (
    <div
      className={variant === "confirmed" && !expanded ? "ob-pulse rounded-xl" : "rounded-xl"}
      style={
        {
          background: `linear-gradient(135deg, ${t.tintA}, ${t.tintB})`,
          border: `1px solid ${t.border}`,
          "--ring": t.ring,
        } as React.CSSProperties
      }
    >
      <button onClick={() => setExpanded((x) => !x)} className="w-full flex items-center gap-3 text-left p-3">
        <span
          className="flex-shrink-0 flex items-center justify-center rounded-lg text-base"
          style={{ width: 34, height: 34, background: t.chipBg, border: `1px solid ${t.border}` }}
        >
          {t.icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold" style={{ color: t.base }}>
            {t.title} · {conflicts.length} item{conflicts.length === 1 ? "" : "s"}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: "rgba(255,255,255,0.62)" }}>
            {t.sub} · earliest {fmtDate(earliest)}
          </div>
        </div>
        <span
          className="text-sm"
          style={{ color: t.base, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {conflicts.map((c) => (
            <ConflictCard key={c.conflict_key} conflict={c} variant={variant} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictCard({ conflict, variant }: { conflict: Conflict; variant: Variant }) {
  const t = THEME[variant];
  const dismiss = useMutation(api.conflict_dismissals.dismissConflict);
  const [resolving, setResolving] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);

  async function onResolve() {
    if (resolving) return;
    setResolving(true);
    try {
      await dismiss({
        conflict_key: conflict.conflict_key,
        item_id: conflict.item_id as Id<"items">,
        reservation_ids: conflict.reservations.map((r) => r.reservation_id),
        note: undefined,
      });
    } finally {
      setResolving(false);
    }
  }

  const showImg = conflict.item_image_url && !imgBroken;
  return (
    <div className="rounded-lg p-2.5" style={{ background: "rgba(0,0,0,0.30)", border: `1px solid ${t.border}` }}>
      {/* header: image · name + meter · resolve */}
      <div className="flex items-center gap-2.5">
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={conflict.item_image_url as string}
            alt={conflict.item_canonical}
            onError={() => setImgBroken(true)}
            className="flex-shrink-0 rounded-md object-cover"
            style={{ width: 42, height: 42, background: "rgba(255,255,255,0.05)", border: `1px solid ${t.border}` }}
            loading="lazy"
          />
        ) : (
          <div
            className="flex-shrink-0 flex items-center justify-center rounded-md text-sm font-bold"
            style={{ width: 42, height: 42, background: t.chipBg, color: t.base, border: `1px solid ${t.border}` }}
          >
            {conflict.item_canonical.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-white truncate">{conflict.item_canonical}</div>
          <div className="mt-1">
            <CapacityMeter qty={conflict.qty} booked={conflict.overlap_count} color={t.base} />
          </div>
        </div>
        <button
          onClick={onResolve}
          disabled={resolving}
          className="flex-shrink-0 text-[11px] px-2.5 py-1 rounded-md font-semibold transition-colors disabled:opacity-40"
          style={{ background: "rgba(34,197,94,0.14)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.4)" }}
          title="Dismiss this conflict. Reappears if the booking set changes."
        >
          {resolving ? "…" : "Resolve ✓"}
        </button>
      </div>

      {/* clash date */}
      <div className="mt-2 text-[11px]" style={{ color: "rgba(255,255,255,0.55)" }}>
        Clashes from <span style={{ color: t.base, fontWeight: 600 }}>{fmtDate(conflict.conflict_start)}</span>
      </div>

      {/* visual crossover timeline — bars per booking, red line at the clash */}
      <ClashTimeline reservations={conflict.reservations} conflictStart={conflict.conflict_start} />

      {/* the clashing bookings — each with its own listing photo */}
      <div className="mt-2 space-y-1.5">
        {conflict.reservations.map((r) => (
          <ResvRow key={r.reservation_id} r={r} />
        ))}
      </div>
    </div>
  );
}

// One clashing booking: its listing photo + renter + dates + kind tag.
function ResvRow({ r }: { r: ConflictReservation }) {
  const [broken, setBroken] = useState(false);
  const color = KIND_COLOR[r.kind];
  const showImg = !!r.image_url && !broken;
  return (
    <div
      className="flex items-center gap-2 rounded-md p-1"
      style={{ background: "rgba(255,255,255,0.03)", borderLeft: `3px solid ${color}` }}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={r.image_url as string}
          alt=""
          onError={() => setBroken(true)}
          className="flex-shrink-0 rounded object-cover"
          style={{ width: 32, height: 32, background: "rgba(255,255,255,0.05)" }}
          loading="lazy"
        />
      ) : (
        <div
          className="flex-shrink-0 flex items-center justify-center rounded text-[12px] font-bold"
          style={{ width: 32, height: 32, background: `${color}22`, color }}
        >
          {(r.renter_name ?? "?").charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-white/90 truncate">{r.renter_name ?? "Unknown renter"}</div>
        <div className="text-[10px] text-white/45 tabular-nums">
          {fmtDate(r.start_date)} → {fmtDate(r.end_date)}
        </div>
      </div>
      <span
        className="flex-shrink-0 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded"
        style={{ background: `${color}22`, color }}
      >
        {r.kind}
      </span>
    </div>
  );
}

// Horizontal timeline: each booking is a bar over the shared window so the
// crossover is obvious; a red line marks where the clash begins.
function ClashTimeline({
  reservations,
  conflictStart,
}: {
  reservations: ConflictReservation[];
  conflictStart: string;
}) {
  const parse = (d: string) => new Date(d + "T00:00:00Z").getTime();
  const starts = reservations.map((r) => parse(r.start_date));
  const ends = reservations.map((r) => parse(r.end_date));
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const span = Math.max(max - min, 1);
  const pct = (t: number) => ((t - min) / span) * 100;
  const clashX = Math.min(Math.max(pct(parse(conflictStart)), 0), 100);
  return (
    <div className="mt-2">
      <div className="relative">
        <div
          className="absolute top-0 bottom-0"
          style={{ left: `${clashX}%`, width: 2, background: "rgba(239,68,68,0.75)", zIndex: 1, borderRadius: 2 }}
          title={`clash from ${fmtDate(conflictStart)}`}
        />
        <div className="space-y-1">
          {reservations.map((r) => {
            const a = pct(parse(r.start_date));
            const b = pct(parse(r.end_date));
            const color = KIND_COLOR[r.kind];
            return (
              <div
                key={r.reservation_id}
                className="relative rounded-full"
                style={{ height: 9, background: "rgba(255,255,255,0.05)" }}
              >
                <div
                  className="absolute rounded-full"
                  style={{
                    left: `${a}%`,
                    width: `${Math.max(b - a, 3)}%`,
                    height: 9,
                    background: color,
                    opacity: 0.85,
                    boxShadow: `0 0 6px ${color}66`,
                  }}
                  title={`${r.renter_name ?? "?"}: ${fmtDate(r.start_date)}–${fmtDate(r.end_date)}`}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-between text-[9px] mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>
        <span>{fmtDate(new Date(min).toISOString().slice(0, 10))}</span>
        <span>{fmtDate(new Date(max).toISOString().slice(0, 10))}</span>
      </div>
    </div>
  );
}

// qty-drift mini-banner — non-blocking resolver-miss warning (unchanged behaviour).
function QtyDriftBadge({ count, sample }: { count: number; sample: QtyDriftSample[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="rounded-xl p-3"
      style={{
        background: "linear-gradient(135deg, rgba(234,179,8,0.12), rgba(202,138,4,0.08))",
        border: "1px solid rgba(234,179,8,0.32)",
      }}
    >
      <button onClick={() => setExpanded((x) => !x)} className="w-full flex items-center gap-2 text-left">
        <span className="text-amber-300 text-sm">⚙</span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-amber-200">
            {count} booking{count === 1 ? "" : "s"} with an unmatched listing
          </div>
          <div className="text-[11px] text-amber-100/70 mt-0.5">
            a listing on these isn&apos;t in your master inventory (often an accessory) — info only
          </div>
        </div>
        <span
          className="text-amber-300 text-sm"
          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
        >
          ▾
        </span>
      </button>
      {expanded && sample.length > 0 && (
        <ul className="mt-2 text-[11px] text-amber-100 space-y-1">
          {sample.map((s) => (
            <li key={s.reservation_id}>
              <span className="font-mono">{s.hygglo_order_id}</span> {s.renter_name ?? "—"} · expanded {s.expanded_n} /
              raw {s.raw_n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
