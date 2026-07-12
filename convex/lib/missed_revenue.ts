/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Missed Revenue — shared helper (single source of truth).
 * ──────────────────────────────────────────────────────────────────────────
 *
 *  Used by:
 *   - convex/revenue.ts          → getMissedRevenue (the large panel)
 *   - convex/dashboard.ts        → getStatsDrawerData.missed_revenue (top tile)
 *
 *  LOGIC (2026-06-27, Daniel). "Missed" splits into two genuinely different
 *  things, by whether we actually OWN the requested gear:
 *
 *   • LOST REVENUE (real, headline): turned-away demand for gear we DO own that
 *     we couldn't fulfil — it was fully booked at the requested dates (a real
 *     double-booking conflict), plus recorded owner denials. This is money we
 *     could have earned but capacity stopped us.
 *
 *   • MISSED MARKETING (buy signal): demand for gear we DON'T own (marketing-
 *     only listings — e.g. a RED Komodo we list to attract enquiries). The
 *     renter wanted it but we never had it, so it was never real revenue and
 *     can't have been "cancelled after paying". It's a signal of what to buy.
 *
 *  Owned gear that was AVAILABLE but the request still fell through (the renter
 *  walked) is NOT counted — that's not a capacity loss.
 *
 *  Demand is detected by the vetted classifier (demand_loss.classifyRow →
 *  genuine_demand), run LIVE so it never depends on a stale batch. Values are
 *  NET (reservation net_to_owner_gbp; gross sources × OWNER_SHARE).
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { OWNER_SHARE } from "./revenue_attribution";
import { classifyRow } from "../demand_loss";
import { bookedUnitsOnDate } from "./availability";
import {
  reservationItemUnits,
  buildProductIndexMap,
  buildOverrideMap,
} from "./reservations/itemUnits";

export { OWNER_SHARE };

export type DenialLoss = {
  denialId: string;
  reason: string | undefined;
  itemName: string | undefined;
  estimatedValue: number; // net
  estimatedValueGross: number;
  notes: string | undefined;
  createdAt: number;
};

export type MissedItem = {
  itemName: string;
  value: number; // net £
  count: number; // # turned-away requests
};

export type MissedRevenueResult = {
  totalMissed: number; // headline = LOST REVENUE (real, owned + couldn't fulfil)
  lostRevenueTotal: number;
  missedMarketingTotal: number;
  denialTotal: number;
  lostItems: MissedItem[]; // owned gear we couldn't fulfil (double-booked) + denials
  marketingItems: MissedItem[]; // demand for gear we don't own → buy signals
  denialLosses: DenialLoss[]; // recorded denials (for the drawer)
};

const DAY = 86_400_000;

function primaryRawName(r: Doc<"reservations">): string {
  return (
    (r.resolved_items ?? [])[0]?.item_name_canonical ||
    (r.items ?? [])[0]?.item_name ||
    (r.hygglo_items ?? [])[0]?.name ||
    "Unknown item"
  );
}

function expandDates(start: string, end: string, cap = 45): string[] {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  if (isNaN(s) || isNaN(e) || e < s) return [start];
  const out: string[] = [];
  for (let t = s; t <= e && out.length < cap; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function rollup(rows: { name: string; value: number }[]): MissedItem[] {
  const m = new Map<string, { value: number; count: number }>();
  for (const r of rows) {
    const e = m.get(r.name) ?? { value: 0, count: 0 };
    e.value += r.value;
    e.count += 1;
    m.set(r.name, e);
  }
  return [...m.entries()]
    .map(([itemName, e]) => ({ itemName, value: parseFloat(e.value.toFixed(2)), count: e.count }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Optional pre-collected inputs (2026-07-12). getStatsDrawerData's live
 * compute (the _bypassMv path run once per slug by mv/stats_drawer.ts)
 * already collects these exact tables for its own cards; passing them in
 * removes 5 duplicate collects per refreshed slug. Every field MUST be the
 * UNFILTERED result of the stated query — this function applies its own
 * account/date filters, so pre-scoped arrays would change results. Inputs
 * are never mutated (all downstream use is read-only / filter-copies).
 *
 * NOT preloadable: the by_status "confirmed" reservations collect (see the
 * comment at its call site), pricing_catalog (the dashboard handler never
 * full-collects it) and the single accounts by_slug .first().
 */
export type MissedRevenuePreloads = {
  /** ctx.db.query("items").collect() — full, unfiltered. */
  items?: Doc<"items">[];
  /** ctx.db.query("hygglo_product_index").collect() — full. */
  productIndexRows?: Doc<"hygglo_product_index">[];
  /** ctx.db.query("listing_resolution_override").collect() — full. */
  overrideRows?: Doc<"listing_resolution_override">[];
  /** ctx.db.query("denial_records").collect() — full, unfiltered. */
  denialRows?: Doc<"denial_records">[];
  /**
   * reservations collected via .withIndex("by_start_date", q =>
   * q.gte("start_date", gteStartDate)) — cross-account, unfiltered.
   * Only used when gteStartDate <= this run's own cutoff (i.e. the passed
   * window provably contains every row the narrower gte would return);
   * otherwise the function falls back to its own indexed collect.
   */
  reservations?: { rows: Doc<"reservations">[]; gteStartDate: string };
};

export async function computeMissedRevenue(
  ctx: QueryCtx,
  accountSlug: string | null,
  days: number,
  pre?: MissedRevenuePreloads,
): Promise<MissedRevenueResult> {
  const cutoffMs = Date.now() - days * DAY;
  const cutoffStr = new Date(cutoffMs).toISOString().slice(0, 10);

  let accountId: Doc<"accounts">["_id"] | undefined;
  if (accountSlug) {
    const acc = await ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", accountSlug)).first();
    accountId = acc?._id;
  }

  // ── Inventory + resolution maps ──────────────────────────────────
  const items = pre?.items ?? (await ctx.db.query("items").collect());
  const itemById = new Map(items.map((i) => [String(i._id), i]));
  const productIndex = buildProductIndexMap(
    (pre?.productIndexRows ??
      (await ctx.db.query("hygglo_product_index").collect())) as Array<{
      account_slug: string; product_id: number; item_id: Id<"items">;
    }>,
  );
  const overrideMap = buildOverrideMap(
    (pre?.overrideRows ??
      (await ctx.db.query("listing_resolution_override").collect())) as Array<{
      account_slug: string; product_id: number;
      components: Array<{ item_id: Id<"items"> | string; qty: number }>;
    }>,
  );
  // Confirmed occupancy (for the fully-booked / double-booking test).
  // Deliberately NOT preloadable from a start_date-windowed pool: confirmed
  // rows can have start_date arbitrarily far in the past (e.g. >365d-old
  // long bookings) yet still occupy dates inside this run's window, so only
  // the by_status index provably returns them all.
  const confirmed = await ctx.db
    .query("reservations")
    .withIndex("by_status", (q) => q.eq("status", "confirmed"))
    .collect();

  const ownedUnitsOf = (r: Doc<"reservations">): Array<[Id<"items">, number]> => {
    const out: Array<[Id<"items">, number]> = [];
    for (const [idStr, qty] of reservationItemUnits(r, productIndex, overrideMap)) {
      const it = itemById.get(idStr);
      if (it && !it.is_marketing_only && it.status === "active" && (it.qty ?? 0) > 0) {
        out.push([idStr as Id<"items">, qty]);
      }
    }
    return out;
  };

  // ── 1. Recorded denials (explicit owner declines → real lost revenue) ──
  let denials = pre?.denialRows ?? (await ctx.db.query("denial_records").collect());
  if (accountId) denials = denials.filter((d) => d.account_id === accountId);
  denials = denials.filter((d) => d.created_at >= cutoffMs);
  const pricing = await ctx.db.query("pricing_catalog").collect();
  const priceByName = new Map(pricing.map((p) => [p.item_name_canonical, p.daily_price_min]));
  const denialLosses: DenialLoss[] = denials.map((d) => {
    let gross = d.estimated_value ?? 0;
    if (gross === 0 && d.item_name) {
      const rate = priceByName.get(d.item_name);
      if (rate) gross = rate * 2;
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
  const denialTotal = parseFloat(denialLosses.reduce((s, d) => s + d.estimatedValue, 0).toFixed(2));

  // ── 2. Turned-away demand, split by ownership + capacity ─────────
  // When the caller passed a pre-collected by_start_date window that provably
  // contains this one (same index, same gte, wider-or-equal bound), derive in
  // memory with the identical predicate. Rows lacking start_date are excluded
  // by the string-gte index in both cases (undefined sorts below strings),
  // and ISO-date string comparison is identical in Convex and JS.
  let cancelled =
    pre?.reservations && pre.reservations.gteStartDate <= cutoffStr
      ? pre.reservations.rows.filter(
          (r) => typeof r.start_date === "string" && r.start_date >= cutoffStr,
        )
      : await ctx.db
          .query("reservations")
          .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
          .collect();
  if (accountSlug) cancelled = cancelled.filter((r) => r.account_slug === accountSlug);
  cancelled = cancelled.filter(
    (r) => r.is_obsolete || r.status === "cancelled" || r.status === "declined",
  );

  const lostRows: { name: string; value: number }[] = [];
  const marketingRows: { name: string; value: number }[] = [];
  for (const r of cancelled) {
    if (classifyRow(r) !== "genuine_demand") continue;
    const value = r.net_to_owner_gbp ?? (r.gross_paid_gbp ?? 0) * OWNER_SHARE;
    if (value <= 0) continue;

    const owned = ownedUnitsOf(r);
    if (owned.length === 0) {
      // We don't own it — demand for marketing-only / un-stocked gear.
      marketingRows.push({ name: primaryRawName(r), value });
      continue;
    }
    // Owned: was it actually un-fulfillable (fully booked) at the dates?
    const start = r.pickup_date ?? r.start_date;
    const end = r.return_date ?? r.end_date;
    if (!start || !end) continue;
    const dates = expandDates(start, end);
    const otherConfirmed = confirmed.filter((c) => c._id !== r._id);
    let fullyBooked = false;
    let lostName = "";
    for (const [id, reqQty] of owned) {
      const total = itemById.get(String(id))?.qty ?? 0;
      let peak = 0;
      for (const d of dates) {
        const b = bookedUnitsOnDate(otherConfirmed, id, d);
        if (b > peak) peak = b;
      }
      if (total - peak < reqQty) {
        fullyBooked = true;
        lostName = itemById.get(String(id))?.name_canonical ?? primaryRawName(r);
        break;
      }
    }
    // Owned + available + cancelled = renter walked → NOT a capacity loss, skip.
    if (fullyBooked) lostRows.push({ name: lostName || primaryRawName(r), value });
  }

  // Recorded denials are explicit owner declines → count as lost revenue.
  for (const d of denialLosses) lostRows.push({ name: d.itemName ?? "Unknown item", value: d.estimatedValue });

  const lostItems = rollup(lostRows);
  const marketingItems = rollup(marketingRows);
  const lostRevenueTotal = parseFloat(lostRows.reduce((s, l) => s + l.value, 0).toFixed(2));
  const missedMarketingTotal = parseFloat(marketingRows.reduce((s, l) => s + l.value, 0).toFixed(2));

  return {
    totalMissed: lostRevenueTotal,
    lostRevenueTotal,
    missedMarketingTotal,
    denialTotal,
    lostItems,
    marketingItems,
    denialLosses,
  };
}
