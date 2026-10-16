import { loadCanonicalListingAllocation } from "./canonical_listing_allocation";
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
 * Read only confirmed rentals that can overlap the demand date envelope.
 * Starts inside the envelope are found through the start/pickup indexes;
 * older long rentals are found through return/end indexes. The latter range
 * is intentionally open-ended: a booking that began years ago can still
 * overlap a requested date. Effective dates are rechecked with the exact same
 * pickup/return fallbacks as bookedUnitsOnDate before a row is retained.
 */
export async function confirmedForDemandWindow(
  ctx: QueryCtx,
  from: string,
  to: string,
): Promise<Doc<"reservations">[]> {
  // Keep this capacity set cross-account: physical item rows can be listed
  // through multiple rental accounts, so another account's confirmed booking
  // can still occupy the same inventory unit.
  const [byStart, byPickup, byReturn, byEnd] = await Promise.all([
    // The start-date fallback only needs rows that lack a negotiated pickup
    // date. The pickup index has start_date as its third field, so this stays
    // bounded without rereading the rows handled by byPickup.
    ctx.db.query("reservations").withIndex("by_status_pickup_date", (q) =>
      q.eq("status", "confirmed").eq("pickup_date", undefined)
        .gte("start_date", from).lte("start_date", to),
    ).collect(),
    ctx.db.query("reservations").withIndex("by_status_pickup_date", (q) =>
      q.eq("status", "confirmed").gte("pickup_date", from).lte("pickup_date", to),
    ).collect(),
    ctx.db.query("reservations").withIndex("by_status_return_date", (q) =>
      q.eq("status", "confirmed").gte("return_date", from),
    ).collect(),
    // Same rule for the legacy return-date fallback: query end_date only when
    // return_date is absent. This avoids reading the same reservation through
    // both indexes while retaining older long-term rentals in the overlap set.
    ctx.db.query("reservations").withIndex("by_status_return_end_date", (q) =>
      q.eq("status", "confirmed").eq("return_date", undefined).gte("end_date", from),
    ).collect(),
  ]);

  const rows = new Map<string, Doc<"reservations">>();
  const retainOverlap = (r: Doc<"reservations">) => {
    const start = r.pickup_date ?? r.start_date;
    const end = r.return_date ?? r.end_date;
    if (!start || !end || start > to || end < from) return;
    rows.set(String(r._id), r);
  };
  for (const r of [...byStart, ...byPickup, ...byReturn, ...byEnd]) retainOverlap(r);
  return [...rows.values()];
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

  // ── 1. Small, relevant inputs first ──────────────────────────────
  // Most reactive reads have no genuine turned-away demand in the requested
  // window. Discover that from selective reservation indexes before loading
  // the much larger confirmed-rental set and inventory/resolution tables.
  // This keeps the live result while avoiding repeated multi-MB reads when the
  // recent cancelled/obsolete slice contains nothing this metric can count.
  const accountPromise = accountSlug
    ? ctx.db.query("accounts").withIndex("by_slug", (q) => q.eq("slug", accountSlug)).first()
    : Promise.resolve(null);
  // Read only denials in the requested window. On the dashboard this query
  // used to collect the full lifetime denial table (1,081 rows in production)
  // on every reactive update, then discard all but the last 30/90 days. Keep
  // the account lookup, denial scan, and cancellation scan concurrent while
  // selecting the narrower compound index when the account is known.
  const denialRowsPromise: Promise<Doc<"denial_records">[]> = pre?.denialRows
    ? Promise.resolve(pre.denialRows)
    : accountPromise.then((account) => accountSlug && account
      ? ctx.db.query("denial_records").withIndex("by_account_created_at", (q) =>
          q.eq("account_id", account._id).gte("created_at", cutoffMs),
        ).collect()
      : ctx.db.query("denial_records").withIndex("by_created_at", (q) =>
          q.gte("created_at", cutoffMs),
        ).collect());
  const cancellationPromise = pre?.reservations && pre.reservations.gteStartDate <= cutoffStr
    ? Promise.resolve(pre.reservations.rows.filter(
        (r) => typeof r.start_date === "string" && r.start_date >= cutoffStr,
      ))
    : accountPromise.then((account) => Promise.all(account
        ? [
            ctx.db.query("reservations").withIndex("by_account_obsolete_start", (q) =>
              q.eq("account_slug", accountSlug!).eq("is_obsolete", true).gte("start_date", cutoffStr),
            ).collect(),
            ctx.db.query("reservations").withIndex("by_account_status_start_date", (q) =>
              q.eq("account_slug", accountSlug!).eq("status", "cancelled").gte("start_date", cutoffStr),
            ).collect(),
            ctx.db.query("reservations").withIndex("by_account_status_start_date", (q) =>
              q.eq("account_slug", accountSlug!).eq("status", "declined").gte("start_date", cutoffStr),
            ).collect(),
          ]
        : [
            ctx.db.query("reservations").withIndex("by_is_obsolete_start_date", (q) =>
              q.eq("is_obsolete", true).gte("start_date", cutoffStr),
            ).collect(),
            ctx.db.query("reservations").withIndex("by_status_start_date", (q) =>
              q.eq("status", "cancelled").gte("start_date", cutoffStr),
            ).collect(),
            ctx.db.query("reservations").withIndex("by_status_start_date", (q) =>
              q.eq("status", "declined").gte("start_date", cutoffStr),
            ).collect(),
          ]).then((groups) => [...new Map(groups.flat().map((r) => [String(r._id), r])).values()]));

  const [account, denialRows, cancellationRows] = await Promise.all([
    accountPromise,
    denialRowsPromise,
    cancellationPromise,
  ]);
  const accountId = account?._id;

  // ── 2. Recorded denials (explicit owner declines → real lost revenue) ──
  let denials = denialRows;
  if (accountId) denials = denials.filter((d) => d.account_id === accountId);
  denials = denials.filter((d) => d.created_at >= cutoffMs);
  const needsPricingFallback = denials.some((d) => (d.estimated_value ?? 0) === 0 && Boolean(d.item_name));
  const pricing = needsPricingFallback
    ? (await Promise.all(
        [...new Set(denials.flatMap((d) =>
          (d.estimated_value ?? 0) === 0 && d.item_name ? [d.item_name] : [],
        ))].map((itemName) =>
          ctx.db.query("pricing_catalog")
            .withIndex("by_name", (q) => q.eq("item_name_canonical", itemName))
            .collect(),
        ),
      )).flat()
    : [];
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

  let cancelled = cancellationRows;
  if (accountSlug) cancelled = cancelled.filter((r) => r.account_slug === accountSlug);
  cancelled = cancelled.filter(
    (r) => r.is_obsolete || r.status === "cancelled" || r.status === "declined",
  );

  const hasCountableDemand = cancelled.some((r) =>
    classifyRow(r) === "genuine_demand" &&
    (r.net_to_owner_gbp ?? (r.gross_paid_gbp ?? 0) * OWNER_SHARE) > 0,
  );
  if (!hasCountableDemand) {
    const denialItems = denialLosses.map((d) => ({
      name: d.itemName ?? "Unknown item",
      value: d.estimatedValue,
    }));
    return {
      totalMissed: denialTotal,
      lostRevenueTotal: denialTotal,
      missedMarketingTotal: 0,
      denialTotal,
      lostItems: rollup(denialItems),
      marketingItems: [],
      denialLosses,
    };
  }

  // ── 3. Expensive occupancy inputs, only when demand can use them ──
  const capacityWindows = cancelled.flatMap((r) => {
    if (
      classifyRow(r) !== "genuine_demand" ||
      (r.net_to_owner_gbp ?? (r.gross_paid_gbp ?? 0) * OWNER_SHARE) <= 0
    ) return [];
    const start = r.pickup_date ?? r.start_date;
    const end = r.return_date ?? r.end_date;
    return start && end ? expandDates(start, end) : [];
  });
  const capacityFrom = capacityWindows.length ? capacityWindows.reduce((a, b) => a < b ? a : b) : null;
  const capacityTo = capacityWindows.length ? capacityWindows.reduce((a, b) => a > b ? a : b) : null;

  const [items, productIndexRows, overrideRows, confirmed] = await Promise.all([
    pre?.items ?? ctx.db.query("items").collect(),
    pre?.productIndexRows ?? ctx.db.query("hygglo_product_index").collect(),
    pre?.overrideRows ?? ctx.db.query("listing_resolution_override").collect(),
    capacityFrom && capacityTo
      ? confirmedForDemandWindow(ctx, capacityFrom, capacityTo)
      : Promise.resolve([] as Doc<"reservations">[]),
  ]);
  const itemById = new Map(items.map((i) => [String(i._id), i]));
  const productIndex = buildProductIndexMap(
    productIndexRows as Array<{ account_slug: string; product_id: number; item_id: Id<"items"> }>,
  );

  const overrideMap = await loadCanonicalListingAllocation(ctx,items,overrideRows,[...confirmed,...cancelled]);

  const ownedUnitsOf = (r: Doc<"reservations">): Array<[Id<"items">, number]> => {
    const out: Array<[Id<"items">, number]> = [];
    for (const [idStr, qty] of reservationItemUnits(r, productIndex, overrideMap, items)) {
      const it = itemById.get(idStr);
      if (it && !it.is_marketing_only && it.status === "active" && (it.qty ?? 0) > 0) {
        out.push([idStr as Id<"items">, qty]);
      }
    }
    return out;
  };

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
        const b = bookedUnitsOnDate(otherConfirmed, id, d, {productIndex,overrides:overrideMap,inventory:items});
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
