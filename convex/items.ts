import { mutation, query } from "./_generated/server";
import { isPaid } from "./order_step_semantics";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { isConfirmedWithDates, isPaidWithV1Legacy } from "./lib/reservations/predicates";
// Attribution engine (was gated by `use_new_attribution_engine` — Phase 6 cutover).
import {
  attributeRevenue,
  type RentalForAttribution,
} from "./lib/revenue_attribution";
// Equivalence-class fallback: maps marketing-listing titles to the closest
// OWNED MASTER_INVENTORY SKU when direct resolution returns nothing. Powers
// the "circle item tracker" so e.g. denied GoPro listings still contribute
// activity to the GoPro 12 Hero (or Osmo Action) circle. See
// convex/lib/listing_equivalence.ts for the editable keyword map.
// EQ-A: load runtime-editable map from settings (override) → in-code default.
import {
  loadEquivalenceMap,
  resolveListingToInventoryWithMap,
} from "./lib/listing_equivalence";

// Re-export image-resolution helpers for backward compatibility — other widget
// files may import from `./items` or `./lib/imageResolution` directly.
// Per FIX-DESIGN §4.3 (Phase 7).
export {
  resolveImageForReservationItem,
  buildSharedImageBlacklist,
  normaliseItemName,
} from "./lib/imageResolution";

// ─── Shared resolver-output reader ─────────────────────────────────────
// Prefers expanded_items (bundle-decomposed, per-physical qty). Falls back
// to resolved_items + qty:1 when expansion has not run yet on the row.
// Strict id-only — no fuzzy substring matching.
type ResolverItem = { item_id: string; item_name_canonical: string; qty: number };
function readResolverItems(r: {
  expanded_items?: Array<{ item_id: string; item_name_canonical: string; qty: number }>;
  resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
}): ResolverItem[] {
  if (r.expanded_items && r.expanded_items.length > 0) {
    return r.expanded_items.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty,
    }));
  }
  return (r.resolved_items ?? []).map((x) => ({
    item_id: x.item_id,
    item_name_canonical: x.item_name_canonical,
    qty: x.qty ?? 1,
  }));
}

/**
 * W10 Item Revenue Panel - ranked list by revenue over a period
 */
export const getItemRevenueRanking = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    // REVENUE-SUM CANON (order_step_semantics.ts): the by_start_date index
    // pulls everything from cutoff forward — including FUTURE-dated and
    // not-yet-paid rows. Item revenue must reflect realised cash only, so:
    //   • exclude cancelled / declined / obsolete,
    //   • exclude future-dated rows (haven't earned yet),
    //   • require isPaid(order_step) when order_step is set,
    //   • accept v1-imported rows (no order_step, status="completed").
    const todayIso = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      if (r.is_obsolete) return false;
      if (r.status === "cancelled" || r.status === "declined") return false;
      const sd = r.start_date as string | undefined;
      if (sd && sd > todayIso) return false;
      if (r.order_step) return isPaid(r.order_step);
      return r.status === "confirmed" || r.status === "completed";
    });

    // Fetch pricing for weighted split
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map(pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]));

    // Phase 6 — attribution engine is the only path.
    const itemsAll = await ctx.db.query("items").collect();
    const itemById = new Map<typeof itemsAll[number]["_id"], typeof itemsAll[number]>();
    const itemByCanonical = new Map<string, typeof itemsAll[number]>();
    for (const it of itemsAll) {
      itemById.set(it._id, it);
      const nm = (it as { name_canonical?: string }).name_canonical;
      if (nm) itemByCanonical.set(nm, it);
    }

    // LLM-resolved items: revenue attributed strictly to inventory items
    // returned by item_resolver, never substring matched. Multi-item bundles
    // split gross by pricing_catalog weights (equal split if no prices).
    //
    // EQUIVALENCE FALLBACK (circle item tracker): when resolved_items is
    // empty (resolver never ran or returned nothing for this listing), fall
    // back to mapping raw items[].item_name → owned MASTER_INVENTORY SKU via
    // listing_equivalence. So e.g. a paid GoPro Hero 11 rental still shows on
    // the GoPro 12 Hero circle. Direct match always wins (no double-attribution).
    const ownedSkus = new Set<string>(
      itemsAll.filter((it) => (it as { is_marketing_only?: boolean }).is_marketing_only !== true)
        .map((it) => (it as { name_canonical?: string }).name_canonical ?? "")
        .filter((n) => n.length > 0),
    );
    // EQ-A: load effective equivalence map (settings override → default).
    const equivMap = await loadEquivalenceMap(ctx);
    const itemMap = new Map<string, { totalRevenue: number; rentalCount: number; totalDays: number }>();
    for (const r of reservations) {
      const resolved = (r as { resolved_items?: Array<{ item_id?: string; item_name_canonical: string; qty?: number }> }).resolved_items ?? [];
      const days = r.duration_days ?? 0;

      // Equivalence fallback path — no direct resolution, try keyword-map.
      if (resolved.length === 0) {
        const rawItems = (r as { items?: Array<{ item_name: string }> }).items ?? [];
        const title = rawItems.map((it) => it.item_name).filter(Boolean).join(" | ");
        if (!title) continue;
        const eq = resolveListingToInventoryWithMap(title, null, ownedSkus, equivMap);
        if (eq.matchType !== "equivalence" || !eq.sku) continue;
        const gross = r.gross_paid_gbp ?? 0;
        if (gross === 0) continue;
        const cleanName = eq.sku.replace(/\s*\[[^\]]+\]\s*$/, "");
        const existing = itemMap.get(cleanName) ?? { totalRevenue: 0, rentalCount: 0, totalDays: 0 };
        existing.totalRevenue += gross;
        existing.rentalCount += 1;
        existing.totalDays += days;
        itemMap.set(cleanName, existing);
        continue;
      }

      const rental: RentalForAttribution = {
        _id: r._id,
        gross_gbp: r.gross_paid_gbp ?? 0,
        duration_days: r.duration_days,
        expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
        resolved_items: resolved as RentalForAttribution["resolved_items"],
      };
      const lines = attributeRevenue(rental, {
        itemById,
        itemByCanonical,
        priceByName: priceByCanonical,
      });
      for (const line of lines) {
        // Strip " [kind]" tag that some LLM-resolved rows captured into the
        // canonical name (the model copied the inventory listing format).
        const cleanName = line.key.nameCanonical.replace(/\s*\[[^\]]+\]\s*$/, "");
        const existing = itemMap.get(cleanName) ?? { totalRevenue: 0, rentalCount: 0, totalDays: 0 };
        existing.totalRevenue += line.share;
        existing.rentalCount += 1;
        existing.totalDays += days;
        itemMap.set(cleanName, existing);
      }
    }

    return Array.from(itemMap.entries())
      .map(([name, stats]) => ({
        name,
        totalRevenue: Math.round(stats.totalRevenue * 100) / 100,
        rentalCount: stats.rentalCount,
        avgValue: stats.rentalCount > 0 ? Math.round((stats.totalRevenue / stats.rentalCount) * 100) / 100 : 0,
        totalDays: stats.totalDays,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  },
});

/**
 * W12 Item Cycle Tracker - utilization per item over a period
 */
export const getItemCycles = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const activeCanonicals = activeItems.map((i) => i.name_canonical);

    // LLM-resolved items only — strict per-id match (no substring matching).
    const activeCanonSet = new Set<string>(activeCanonicals);
    // EQ-A: load effective equivalence map (settings override → default).
    const equivMap = await loadEquivalenceMap(ctx);
    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      const resolved = (r as { resolved_items?: Array<{ item_name_canonical: string }> }).resolved_items ?? [];
      // EQUIVALENCE FALLBACK: when resolver yielded nothing, map listing
      // title → owned SKU via listing_equivalence so denied/unresolved
      // rentals still register utilization on the closest available item's
      // circle. Direct (already-resolved) match always wins.
      if (resolved.length === 0) {
        const rawItems = (r as { items?: Array<{ item_name: string }> }).items ?? [];
        const title = rawItems.map((it) => it.item_name).filter(Boolean).join(" | ");
        if (!title) continue;
        const eq = resolveListingToInventoryWithMap(title, null, activeCanonSet, equivMap);
        if (eq.matchType === "equivalence" && eq.sku) {
          rentalDaysMap.set(
            eq.sku,
            (rentalDaysMap.get(eq.sku) ?? 0) + (r.duration_days ?? 0),
          );
        }
        continue;
      }
      for (const x of resolved) {
        if (!activeCanonSet.has(x.item_name_canonical)) continue;
        rentalDaysMap.set(
          x.item_name_canonical,
          (rentalDaysMap.get(x.item_name_canonical) ?? 0) + (r.duration_days ?? 0),
        );
      }
    }

    return activeItems.map((item) => {
        const rentalDays = rentalDaysMap.get(item.name_canonical) ?? 0;
        const qty = item.qty ?? 1;
        return {
          itemId: item._id,
          name: item.name_canonical,
          rentalDays,
          idleDays: Math.max(0, days - rentalDays),
          unavailDays: 0,
          utilizationPct: days > 0 && qty > 0 ? Math.min(100, (rentalDays / (qty * days)) * 100) : 0,
        };
      });
  },
});

/**
 * W13 Out-of-Stock Panel - items fully booked within look-ahead window
 */
export const getOutOfStockItems = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    lookAheadDays: v.number(),
  },
  handler: async (ctx, { accountSlug, lookAheadDays }) => {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + lookAheadDays);
    const endStr = endDate.toISOString().slice(0, 10);

    // Include ongoing (start<=today, end>=today) + upcoming (start<=endStr) confirmed reservations
    let reservations = await ctx.db
      .query("reservations")
      .collect();
    reservations = reservations.filter(
      (r) =>
        isConfirmedWithDates(r as any) &&
        (r.start_date as string) <= endStr &&
        (r.end_date as string) >= today
    );
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    // Build hold counts using fuzzy canonical name matching
    // (Hygglo item_name is the full listing title; items table uses short canonical names)
    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // resolved_items (LLM-driven) — strict item lookup, no substring fuzz.
    const canonicalNames = activeItems.map((i) => i.name_canonical);
    const canonSet = new Set<string>(canonicalNames);
    const holdCounts = new Map<string, number>();
    const nextAvailMap = new Map<string, string>();
    for (const r of reservations) {
      const resolved = (r as { resolved_items?: Array<{ item_name_canonical: string }> }).resolved_items ?? [];
      for (const x of resolved) {
        if (!canonSet.has(x.item_name_canonical)) continue;
        holdCounts.set(x.item_name_canonical, (holdCounts.get(x.item_name_canonical) ?? 0) + 1);
        const existing = nextAvailMap.get(x.item_name_canonical);
        if (!existing || (r.end_date && r.end_date > existing)) {
          nextAvailMap.set(x.item_name_canonical, r.end_date ?? endStr);
        }
      }
    }

    return activeItems
      .filter(
        (i) =>
          holdCounts.has(i.name_canonical) &&
          (holdCounts.get(i.name_canonical) ?? 0) >= i.qty
      )
      .map((i) => ({
        itemId: i._id,
        name: i.name_canonical,
        nextAvailableDate: nextAvailMap.get(i.name_canonical) ?? null,
        activeReservationCount: holdCounts.get(i.name_canonical) ?? 0,
      }));
  },
});

/**
 * W16 Sell Recommender - low utilization items flagged for sale.
 * Groups by name_canonical so multiple units of the same model appear as ONE row
 * (mirrors v1 sell-recommender.service.ts which groups by item_name before scoring).
 */
export const getSellRecommendations = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const LOOKBACK_DAYS = 90;
    const UTIL_THRESHOLD = 0.25;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const allItems = await ctx.db.query("items").collect();
    const activeGroups = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const sellCanonSet = new Set<string>(activeGroups.map((i) => i.name_canonical));

    // Build rental-days per canonical name from LLM-resolved + bundle-expanded
    // items only. Strict id-based match (no substring fuzz, no A7-II↔A7-III
    // confusion). Qty multiplied through so 2× per reservation counts twice.
    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      const items = readResolverItems(r);
      for (const x of items) {
        if (!sellCanonSet.has(x.item_name_canonical)) continue;
        rentalDaysMap.set(
          x.item_name_canonical,
          (rentalDaysMap.get(x.item_name_canonical) ?? 0) + (r.duration_days ?? 0) * x.qty,
        );
      }
    }

    // Group by name_canonical — multiple unit rows collapse to one recommendation
    type GroupEntry = {
      representative_id: string;
      name_canonical: string;
      total_qty: number;
      earliest_created_at: number;
    };
    const groups = new Map<string, GroupEntry>();
    for (const i of allItems) {
      if (i.status !== "active" || i.is_marketing_only) continue;
      const existing = groups.get(i.name_canonical);
      if (!existing) {
        groups.set(i.name_canonical, {
          representative_id: i._id,
          name_canonical: i.name_canonical,
          total_qty: i.qty,
          earliest_created_at: i.created_at,
        });
      } else {
        existing.total_qty += i.qty;
        if (i.created_at < existing.earliest_created_at) {
          existing.earliest_created_at = i.created_at;
        }
      }
    }

    const flagged = await Promise.all(
      Array.from(groups.values()).map(async (g) => {
        const rentalDays = rentalDaysMap.get(g.name_canonical) ?? 0;
        const qty = g.total_qty ?? 1;
        const utilizationPct = LOOKBACK_DAYS > 0 && qty > 0 ? Math.min(100, (rentalDays / (qty * LOOKBACK_DAYS)) * 100) : 0;
        const ageMonths =
          (Date.now() - g.earliest_created_at) / (1000 * 60 * 60 * 24 * 30);

        if (utilizationPct > UTIL_THRESHOLD && ageMonths < 24) return null;

        const priceRow = await ctx.db
          .query("pricing_catalog")
          .withIndex("by_name", (q) => q.eq("item_name_canonical", g.name_canonical))
          .first();
        const estResaleValue = priceRow ? priceRow.daily_price_min * 30 : null;
        const reason = utilizationPct <= UTIL_THRESHOLD ? "Low demand" : "High age";

        return {
          itemId: g.representative_id,
          name: g.name_canonical,
          qty: g.total_qty,
          utilizationPct,
          ageMonths,
          estResaleValue,
          reason,
        };
      })
    );

    return flagged.filter((r) => r !== null);
  },
});

/**
 * W17 Price Recommendations - demand-signal based price suggestions
 */
export const getPriceRecommendations = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const LOOKBACK_DAYS = 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const freqMap = new Map<string, number>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        freqMap.set(item.item_name, (freqMap.get(item.item_name) ?? 0) + 1);
      }
    }

    const allPricingRows = await ctx.db.query("pricing_catalog").collect();

    // BF-01: deduplicate — one row per name_canonical, keep highest updated_at
    const bestByName = new Map<string, typeof allPricingRows[0]>();
    for (const p of allPricingRows) {
      if (p.is_bundle || p.marketing_only) continue;
      const existing = bestByName.get(p.item_name_canonical);
      if (!existing || p.created_at > existing.created_at) {
        bestByName.set(p.item_name_canonical, p);
      }
    }

    return Array.from(bestByName.values()).map((p) => {
      const bookings = freqMap.get(p.item_name_canonical) ?? 0;
      const currentRate = p.daily_price_min;
      if (bookings >= 3) {
        return {
          itemId: p.item_id,
          name: p.item_name_canonical,
          currentRate,
          suggestedRate: parseFloat((currentRate * 1.15).toFixed(2)),
          pctChange: 15,
          demandSignal: bookings + " bookings this month",
        };
      } else if (bookings <= 1) {
        return {
          itemId: p.item_id,
          name: p.item_name_canonical,
          currentRate,
          suggestedRate: parseFloat((currentRate * 0.9).toFixed(2)),
          pctChange: -10,
          demandSignal: bookings === 0 ? "No bookings this month" : "Low demand",
        };
      }
      return null;
    }).filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

/** Simple list of active item names for dropdown selects. */
export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    return items
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({ id: i._id, name: i.name_canonical }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Wave 2 Task 5: listForReconcile — item rows shaped for reconcile-holds.ts.
 * Items are not account-scoped; returns all items.
 * Maps name_canonical → name and includes aliases, qty.
 */
export const listForReconcile = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("items").collect();
    return all.map((i) => ({
      _id: i._id as string,
      name: i.name_canonical,
      aliases: i.aliases ?? [],
      qty: i.qty,
    }));
  },
});

// `backfillImagesFuzzy` removed (Phase 7 / FIX-DESIGN §4.3): substring matching
// against unrelated reservations was the secondary cross-item-photo
// contamination path. Replaced by per-reservation `image_hints` written at
// poll time + `resolveImageForReservationItem` at read time.
