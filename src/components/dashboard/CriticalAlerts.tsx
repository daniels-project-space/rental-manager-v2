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
  /** Effective capacity (owned − in repair) the sweep compared against. */
  qty: number;
  /** Total units owned; shown so a shrunken effective qty is explicable. */
  owned_qty?: number;
  /** Units held by repair cases (quote_received / in_for_repair stages). */
  in_repair?: number;
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

interface BlacklistAlert {
  reservation_id: string;
  renter_name: string | null;
  order_step: string | null;
  start_date: string | null;
  end_date: string | null;
  items: string[];
  account_slug: string | null;
  reason: string | null;
}

/**
 * A rented listing whose Hygglo product_id maps to no inventory item. The gear
 * is physically out, but the overbooking widget, calendar and renter bot all
 * read it as FREE — so it can be double-booked. Highest-severity alert here:
 * the others describe a conflict you can see, this one describes stock the
 * system does not know is gone.
 */
interface UnmappedListing {
  reservation_id: string;
  account_slug: string | null;
  renter_name: string | null;
  start_date: string | null;
  end_date: string | null;
  product_id: number | null;
  listing_title: string;
}

interface Props {
  conflicts: Conflict[];
  unmapped_listings?: UnmappedListing[];
  qty_drift_count?: number;
  qty_drift_sample?: QtyDriftSample[];
  blacklist_alerts?: BlacklistAlert[];
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

export function CriticalAlerts({
  conflicts,
  unmapped_listings = [],
  qty_drift_count = 0,
  qty_drift_sample = [],
  blacklist_alerts = [],
}: Props) {
  // Treat a missing severity (older backend during a deploy) as confirmed so
  // nothing is silently downgraded.
  const confirmed = conflicts.filter((c) => c.severity !== "pending");
  const pending = conflicts.filter((c) => c.severity === "pending");
  const hasDrift = qty_drift_count > 0;
  const hasBlacklist = blacklist_alerts.length > 0;
  const hasUnmapped = unmapped_listings.length > 0;
  if (
    !confirmed.length &&
    !pending.length &&
    !hasDrift &&
    !hasBlacklist &&
    !hasUnmapped
  )
    return null;

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
        {/* First: this is stock the system does not know is gone. */}
        {hasUnmapped && <UnmappedListingsBanner alerts={unmapped_listings} />}
        {hasBlacklist && <BlacklistBanner alerts={blacklist_alerts} />}
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
        <div className="px-3 pb-3 flex flex-wrap gap-2">
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
    <div className="rounded-lg p-2" style={{ flex: "1 1 230px", minWidth: 0, maxWidth: "100%", background: "rgba(0,0,0,0.30)", border: `1px solid ${t.border}` }}>
      <div className="flex items-center gap-2">
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={conflict.item_image_url as string}
            alt={conflict.item_canonical}
            onError={() => setImgBroken(true)}
            className="flex-shrink-0 rounded-md object-cover"
            style={{ width: 30, height: 30, background: "rgba(255,255,255,0.05)", border: `1px solid ${t.border}` }}
            loading="lazy"
          />
        ) : (
          <div className="flex-shrink-0 flex items-center justify-center rounded-md text-xs font-bold" style={{ width: 30, height: 30, background: t.chipBg, color: t.base, border: `1px solid ${t.border}` }}>
            {conflict.item_canonical.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-white truncate">{conflict.item_canonical}</div>
          <div className="mt-0.5"><CapacityMeter qty={conflict.qty} booked={conflict.overlap_count} color={t.base} /></div>
          {(conflict.in_repair ?? 0) > 0 && (
            <div className="text-[10px]" style={{ color: "rgba(255,255,255,0.45)" }} title="Capacity = owned units minus units held by open repair cases">
              {conflict.owned_qty ?? conflict.qty + (conflict.in_repair ?? 0)} owned − {conflict.in_repair} in repair
            </div>
          )}
        </div>
        <button
          onClick={onResolve}
          disabled={resolving}
          className="flex-shrink-0 text-[11px] px-2 py-1 rounded-md font-semibold transition-colors disabled:opacity-40"
          style={{ background: "rgba(34,197,94,0.14)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.4)" }}
          title="Dismiss this conflict. Reappears if the booking set changes."
        >
          {resolving ? "…" : "✓"}
        </button>
      </div>
      <div className="mt-1 text-[10px] truncate" style={{ color: "rgba(255,255,255,0.5)" }}>
        from <span style={{ color: t.base, fontWeight: 600 }}>{fmtDate(conflict.conflict_start)}</span>
        {" · "}
        {conflict.reservations.map((r, idx) => (
          <span key={r.reservation_id} style={{ color: KIND_COLOR[r.kind] }} title={`${r.renter_name ?? "?"} · ${r.kind}`}>{idx > 0 ? ", " : ""}{r.renter_name ?? "?"}</span>
        ))}
      </div>
    </div>
  );
}

// Blacklisted-renter alert — a flagged renter has a LIVE booking (request → out).
/**
 * Rented gear the system cannot see. Deliberately the loudest banner: the other
 * alerts describe a conflict that IS visible somewhere, this one describes
 * stock that is out while every availability surface still reads it as free —
 * i.e. it can be double-booked. Amber rather than red so it reads as
 * "needs mapping", not "a booking is broken".
 */
function UnmappedListingsBanner({ alerts }: { alerts: UnmappedListing[] }) {
  const [expanded, setExpanded] = useState(false);
  const bookings = new Set(alerts.map((a) => a.reservation_id)).size;
  return (
    <div
      className={!expanded ? "ob-pulse rounded-xl" : "rounded-xl"}
      style={
        {
          background: "linear-gradient(135deg, rgba(245,158,11,0.18), rgba(120,53,15,0.12))",
          border: "1px solid rgba(245,158,11,0.5)",
          "--ring": "rgba(245,158,11,0.55)",
        } as React.CSSProperties
      }
    >
      <button
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center gap-3 text-left p-3"
      >
        <span
          className="flex-shrink-0 flex items-center justify-center rounded-lg text-base"
          style={{
            width: 34,
            height: 34,
            background: "rgba(245,158,11,0.2)",
            border: "1px solid rgba(245,158,11,0.45)",
          }}
        >
          🔗
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold" style={{ color: "#f59e0b" }}>
            Rented gear not tracked · {alerts.length} line
            {alerts.length === 1 ? "" : "s"} across {bookings} booking
            {bookings === 1 ? "" : "s"}
          </div>
          <div className="text-[11px]" style={{ color: "#9ca3af" }}>
            These listings aren&apos;t linked to inventory, so the gear is out but still
            shows as available — it can be double-booked. Map them in Settings.
          </div>
        </div>
        <span className="text-[11px]" style={{ color: "#9ca3af" }}>
          {expanded ? "hide" : "show"}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1">
          {alerts.map((a, i) => (
            <UnmappedRow key={`${a.reservation_id}-${a.product_id ?? i}`} alert={a} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One unmapped line, with an inline escape hatch.
 *
 * Not every flagged line is a mapping bug — some listings genuinely hold no
 * inventory (a delivery fee, a marketing-only listing). "Not inventory" pins
 * that judgement as an audit-authoritative `listing_resolution_override` with
 * an EMPTY components list, which is the codebase's existing convention for
 * "this listing owns nothing" (see dashboard.ts expandedIdsOf step A.0). The
 * override is one of the signals getUnmappedRentedListings checks, so the line
 * drops out of this banner on the next tick — and, because it is the same row
 * the conflict/out-of-stock resolver reads, the rest of the dashboard agrees.
 *
 * The override table is keyed by (account_slug, product_id), so a line Hygglo
 * gave no product_id cannot be pinned this way — that one needs fixing at the
 * listing, and the button says so instead of failing silently.
 */
function UnmappedRow({ alert: a }: { alert: UnmappedListing }) {
  const setOverride = useMutation(api.listing_overrides.setOverride);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const canPin = a.product_id !== null && !!a.account_slug;

  async function onNotInventory() {
    if (saving || done || !canPin) return;
    setSaving(true);
    try {
      await setOverride({
        account_slug: a.account_slug as string,
        product_id: a.product_id as number,
        components: [],
        note: `marked non-inventory from dashboard alert: ${a.listing_title}`,
      });
      setDone(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="text-[11px] flex items-center gap-2" style={{ color: "#d1d5db" }}>
      <span style={{ color: "#f59e0b" }}>
        {fmtDate(a.start_date)}–{fmtDate(a.end_date)}
      </span>
      <span className="truncate flex-1 min-w-0">{a.listing_title}</span>
      <span className="flex-shrink-0" style={{ color: "#6b7280" }}>
        {a.account_slug ?? "?"}
        {a.product_id === null ? " · no product id" : ` · #${a.product_id}`}
      </span>
      <button
        onClick={onNotInventory}
        disabled={!canPin || saving || done}
        className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors disabled:opacity-40"
        style={{
          background: "rgba(148,163,184,0.14)",
          color: "#cbd5e1",
          border: "1px solid rgba(148,163,184,0.35)",
        }}
        title={
          canPin
            ? "This listing holds no inventory (fee, service, marketing-only). Pins it as non-inventory so it stops being reported as untracked."
            : "Hygglo sent no product id for this line, so it can't be pinned — fix the listing itself."
        }
      >
        {done ? "pinned" : saving ? "…" : "not inventory"}
      </button>
    </div>
  );
}

function BlacklistBanner({ alerts }: { alerts: BlacklistAlert[] }) {
  const [expanded, setExpanded] = useState(false);
  const renterCount = new Set(alerts.map((a) => a.renter_name ?? "?")).size;
  return (
    <div
      className={!expanded ? "ob-pulse rounded-xl" : "rounded-xl"}
      style={
        {
          background: "linear-gradient(135deg, rgba(239,68,68,0.18), rgba(127,29,29,0.12))",
          border: "1px solid rgba(239,68,68,0.5)",
          "--ring": "rgba(239,68,68,0.55)",
        } as React.CSSProperties
      }
    >
      <button onClick={() => setExpanded((x) => !x)} className="w-full flex items-center gap-3 text-left p-3">
        <span
          className="flex-shrink-0 flex items-center justify-center rounded-lg text-base"
          style={{ width: 34, height: 34, background: "rgba(239,68,68,0.2)", border: "1px solid rgba(239,68,68,0.45)" }}
        >
          ⛔
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold" style={{ color: "#ef4444" }}>
            Blacklisted renter active · {renterCount} renter{renterCount === 1 ? "" : "s"}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: "rgba(255,255,255,0.62)" }}>
            {alerts.length} live booking{alerts.length === 1 ? "" : "s"} from a flagged renter — review
          </div>
        </div>
        <span className="text-sm" style={{ color: "#ef4444", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>▾</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {alerts.map((a) => (
            <div key={a.reservation_id} className="rounded-lg p-2" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(239,68,68,0.3)" }}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12px] font-semibold text-rose-50">{a.renter_name ?? "Unknown"}</span>
                {a.order_step && (
                  <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded" style={{ background: "rgba(239,68,68,0.18)", color: "#f87171" }}>{a.order_step}</span>
                )}
                <span className="text-[10px] text-white/45">{fmtDate(a.start_date)} → {fmtDate(a.end_date)}</span>
                {a.account_slug && <span className="text-[10px] text-white/35">[{a.account_slug}]</span>}
              </div>
              {a.reason && <div className="text-[10px] mt-0.5" style={{ color: "#f87171" }}>reason: {a.reason}</div>}
              {a.items.length > 0 && <div className="text-[10px] text-white/45 truncate mt-0.5">{a.items.join(", ")}</div>}
            </div>
          ))}
        </div>
      )}
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
