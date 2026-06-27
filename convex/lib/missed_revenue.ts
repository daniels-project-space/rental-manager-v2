/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Missed Revenue — shared helper (single source of truth).
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Used by:
 *   - convex/revenue.ts          → getMissedRevenue (the large panel)
 *   - convex/dashboard.ts        → getStatsDrawerData.missed_revenue (top tile)
 *
 *  LOGIC OVERHAUL (2026-06-27, Daniel): "missed revenue" now means TURNED-AWAY
 *  DEMAND — real bookings that didn't happen — NOT idle capacity. Idle days ×
 *  daily price was a vanity number (an item nobody wanted still "missed" money).
 *  The new headline = lost requests the renter genuinely wanted but didn't get:
 *    • recorded denials (denial_records — owner explicitly declined), PLUS
 *    • reservations classified `genuine_demand` by the vetted demand classifier
 *      (owner-denied / verification-failed / paid-then-cancelled / booked-then-
 *      lost). Classified LIVE here so it never depends on a stale batch.
 *  Renter-walked browsers and never-booked inquiries are deliberately excluded.
 *
 *  Net convention: denial_records.estimated_value + pricing are GROSS Hygglo £;
 *  multiply by OWNER_SHARE (0.64) so this matches every other revenue widget
 *  (reservation values use net_to_owner_gbp directly, already net).
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { OWNER_SHARE } from "./revenue_attribution";
import { classifyRow } from "../demand_loss";

// Re-export so existing import sites stay valid.
export { OWNER_SHARE };

export type DenialLoss = {
  denialId: string;
  reason: string | undefined;
  itemName: string | undefined;
  estimatedValue: number; // net (post-platform-fee)
  estimatedValueGross: number;
  notes: string | undefined;
  createdAt: number;
};

/** Per-item rollup of turned-away demand, sorted by value desc. */
export type MissedItem = {
  itemName: string;
  value: number; // net £, summed
  count: number; // how many turned-away requests
  cause: string; // dominant cause label ("declined" / "cancelled" / "mixed" …)
};

export type MissedRevenueResult = {
  totalMissed: number; // NET turned-away demand — headline
  denialTotal: number; // recorded-denial portion
  lostBookingTotal: number; // auto-classified lost-booking portion
  items: MissedItem[]; // per-item rollup
  denialLosses: DenialLoss[]; // recorded denials (for the "Recent denials" drawer)
};

const CAUSE_LABEL: Record<string, string> = {
  owner_denied: "declined",
  verification_failed: "verification failed",
  renter_cancelled: "cancelled after paying",
  other: "fell through",
};

function primaryItemName(r: Doc<"reservations">): string {
  const resolved = (r.resolved_items ?? [])[0];
  if (resolved?.item_name_canonical) return resolved.item_name_canonical;
  const raw = (r.items ?? [])[0];
  if (raw?.item_name) return raw.item_name;
  return "Unknown item";
}

/**
 * Turned-away demand for an account over the trailing N days. Headline
 * `totalMissed` (NET) = recorded denials + live-classified genuine-demand
 * losses, so the top tile and the panel always agree.
 */
export async function computeMissedRevenue(
  ctx: QueryCtx,
  accountSlug: string | null,
  days: number,
): Promise<MissedRevenueResult> {
  const cutoffMs = Date.now() - days * 86_400_000;
  const cutoffStr = new Date(cutoffMs).toISOString().slice(0, 10);

  let accountId: Doc<"accounts">["_id"] | undefined;
  if (accountSlug) {
    const accountRow = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
      .first();
    accountId = accountRow?._id;
  }

  // ── 1. Recorded denials (owner explicitly declined) ──────────────
  let denials = await ctx.db.query("denial_records").collect();
  if (accountId) denials = denials.filter((d) => d.account_id === accountId);
  denials = denials.filter((d) => d.created_at >= cutoffMs);

  const pricingRows = await ctx.db.query("pricing_catalog").collect();
  const priceByName = new Map(
    pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
  );

  const denialLosses: DenialLoss[] = denials.map((d) => {
    let gross = d.estimated_value ?? 0;
    if (gross === 0 && d.item_name) {
      const rate = priceByName.get(d.item_name);
      if (rate) gross = rate * 2; // assume a 2-day rental when no value recorded
    }
    return {
      denialId: d._id as string,
      reason: d.reason,
      itemName: d.item_name,
      estimatedValue: parseFloat((gross * OWNER_SHARE).toFixed(2)),
      estimatedValueGross: gross,
      notes: d.notes,
      createdAt: d.created_at,
    };
  });
  const denialTotal = parseFloat(
    denialLosses.reduce((s, d) => s + d.estimatedValue, 0).toFixed(2),
  );

  // ── 2. Live-classified lost bookings (genuine demand that didn't convert) ──
  // Bounded fetch by start_date window (cancelled requests carry a rental date
  // in/after the window); classify each with the vetted decision tree and keep
  // only genuine_demand. Renter-walked / unbooked / browsers are dropped.
  let cancelled = await ctx.db
    .query("reservations")
    .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
    .collect();
  if (accountSlug) cancelled = cancelled.filter((r) => r.account_slug === accountSlug);
  cancelled = cancelled.filter(
    (r) => r.is_obsolete || r.status === "cancelled" || r.status === "declined",
  );

  type Lost = { name: string; value: number; cause: string };
  const lost: Lost[] = [];
  for (const r of cancelled) {
    if (classifyRow(r) !== "genuine_demand") continue;
    const value =
      r.net_to_owner_gbp ?? (r.gross_paid_gbp ?? 0) * OWNER_SHARE;
    if (value <= 0) continue;
    lost.push({
      name: primaryItemName(r),
      value: parseFloat(value.toFixed(2)),
      cause: CAUSE_LABEL[r.obsolete_reason ?? "other"] ?? "lost",
    });
  }
  const lostBookingTotal = parseFloat(
    lost.reduce((s, l) => s + l.value, 0).toFixed(2),
  );

  // ── 3. Merge into a per-item rollup (denials + lost bookings) ─────
  const byItem = new Map<
    string,
    { value: number; count: number; causes: Map<string, number> }
  >();
  const add = (name: string, value: number, cause: string) => {
    const e = byItem.get(name) ?? { value: 0, count: 0, causes: new Map() };
    e.value += value;
    e.count += 1;
    e.causes.set(cause, (e.causes.get(cause) ?? 0) + 1);
    byItem.set(name, e);
  };
  for (const d of denialLosses) add(d.itemName ?? "Unknown item", d.estimatedValue, "declined");
  for (const l of lost) add(l.name, l.value, l.cause);

  const items: MissedItem[] = [...byItem.entries()]
    .map(([itemName, e]) => {
      const causes = [...e.causes.entries()].sort((a, b) => b[1] - a[1]);
      const cause = causes.length === 1 ? causes[0][0] : "mixed";
      return {
        itemName,
        value: parseFloat(e.value.toFixed(2)),
        count: e.count,
        cause,
      };
    })
    .sort((a, b) => b.value - a.value);

  const totalMissed = parseFloat((denialTotal + lostBookingTotal).toFixed(2));

  return { totalMissed, denialTotal, lostBookingTotal, items, denialLosses };
}
