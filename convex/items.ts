import { mutation, query } from "./_generated/server";
import { isPaid } from "./order_step_semantics";
import { v } from "convex/values";
import { infoPoolEnabledAccounts } from "./lib/feature_flags_helper";
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
 * W10 Item Revenue Panel - ranked list by revenue over a period.
 *
 * @deprecated for UI use (Phase 2.2, 2026-05-24). The dashboard panel now
 * reads from the cached MV via `api.mv.top_earners.getRanking` to avoid the
 * per-mount live `.collect()` over reservations + pricing_catalog + items.
 *
 * STILL IN USE by `src/trigger/snapshot-inventory-overview.ts`, which needs
 * fields the MV does not store (`totalRevenue`/`totalDays`/`avgValue`) and
 * runs on a Trigger.dev cron — not a hot UI path. Do NOT delete without
 * migrating that caller or expanding the MV row shape.
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

    // 2026-05-24: listing info pool override prep for attributeRevenue.
    // When a per-account flag is ON, build a (account#product_id) ->
    // [{item_id, item_name_canonical, qty}] map. Each rental passes
    // through this map keyed by its hygglo_items[i].product_id. When the
    // flag is OFF or no pool entry exists, attributeRevenue uses the
    // legacy expanded/resolved cascade verbatim.
    const candidateSlugsForPool = Array.from(new Set(
      reservations.map((r) => r.account_slug).filter((s): s is string => !!s)
    ));
    const poolEnabledAccountsAttrib = await infoPoolEnabledAccounts(ctx, candidateSlugsForPool);
    const poolOverrideByProduct = new Map<string, Array<{ item_id: typeof itemsAll[number]["_id"]; item_name_canonical: string; qty: number }>>();
    if (poolEnabledAccountsAttrib.size > 0) {
      const poolRows = await ctx.db.query("listing_info_pool").collect();
      for (const pr of poolRows) {
        if (!poolEnabledAccountsAttrib.has(pr.account_slug)) continue;
        const mo = pr.manual_override;
        const compsRaw = mo?.bundle_components && mo.bundle_components.length > 0
          ? mo.bundle_components.map((c) => ({ item_id: c.item_id, qty: c.qty }))
          : pr.bundle_components
              .filter((c) => c.source_kind !== "comparison_reference" && c.source_kind !== "standard_included")
              .map((c) => ({ item_id: c.item_id, qty: c.qty }));
        const out: Array<{ item_id: typeof itemsAll[number]["_id"]; item_name_canonical: string; qty: number }> = [];
        for (const c of compsRaw) {
          if (!c.item_id) continue;
          const inv = itemById.get(c.item_id);
          if (!inv) continue;
          out.push({ item_id: c.item_id, item_name_canonical: inv.name_canonical, qty: c.qty });
        }
        if (out.length > 0) poolOverrideByProduct.set(`${pr.account_slug}#${pr.product_id}`, out);
      }
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

      // 2026-05-24: pool_override — sum per-position pool components when
      // the per-account flag is ON. Reservations may have multiple
      // hygglo_items[] with different product_ids; we union the components
      // (sum qty by item_id) and pass to attributeRevenue.
      let poolOverride: RentalForAttribution["pool_override"] = undefined;
      if (poolEnabledAccountsAttrib.has(r.account_slug ?? "")) {
        const hItemsR = (r as { hygglo_items?: Array<{ product_id?: number; qty?: number }> }).hygglo_items ?? [];
        if (hItemsR.length > 0) {
          const agg = new Map<string, { item_id: typeof itemsAll[number]["_id"]; item_name_canonical: string; qty: number }>();
          for (const h of hItemsR) {
            if (typeof h.product_id !== "number") continue;
            const comps = poolOverrideByProduct.get(`${r.account_slug}#${h.product_id}`);
            if (!comps || comps.length === 0) continue;
            const lineQty = typeof h.qty === "number" && h.qty > 0 ? h.qty : 1;
            for (const c of comps) {
              const k = String(c.item_id);
              const cur = agg.get(k);
              if (cur) cur.qty += c.qty * lineQty;
              else agg.set(k, { item_id: c.item_id, item_name_canonical: c.item_name_canonical, qty: c.qty * lineQty });
            }
          }
          if (agg.size > 0) poolOverride = Array.from(agg.values());
        }
      }

      const rental: RentalForAttribution = {
        _id: r._id,
        gross_gbp: r.gross_paid_gbp ?? 0,
        duration_days: r.duration_days,
        expanded_items: (r as { expanded_items?: RentalForAttribution["expanded_items"] }).expanded_items,
        resolved_items: resolved as RentalForAttribution["resolved_items"],
        pool_override: poolOverride,
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

    // 2026-05-24: listing info pool components — gated per-account.
    // When the flag is ON for an account, the pool's bundle_components
    // are summed per item_id (lens + body each count toward their own
    // capacity). When OFF, the legacy resolved_items strict-canonical-
    // name match runs verbatim. Components flagged as comparison_reference
    // or standard_included never contribute to OOS counts.
    const candidateSlugs = Array.from(new Set(
      reservations.map((r) => r.account_slug).filter((s): s is string => !!s)
    ));
    const poolEnabledAccounts = await infoPoolEnabledAccounts(ctx, candidateSlugs);
    const itemIdToCanonical = new Map<string, string>();
    for (const i of activeItems) itemIdToCanonical.set(String(i._id), i.name_canonical);

    const poolComponentsByProduct = new Map<string, Array<{ item_id: string; qty: number }>>();
    if (poolEnabledAccounts.size > 0) {
      const poolRows = await ctx.db.query("listing_info_pool").collect();
      for (const pr of poolRows) {
        if (!poolEnabledAccounts.has(pr.account_slug)) continue;
        const mo = pr.manual_override;
        const moComps = mo?.bundle_components;
        const comps: Array<{ item_id: string; qty: number }> = [];
        if (moComps && moComps.length > 0) {
          for (const c of moComps) comps.push({ item_id: String(c.item_id), qty: c.qty });
        } else {
          for (const c of pr.bundle_components) {
            if (!c.item_id) continue;
            if (c.source_kind === "comparison_reference") continue;
            if (c.source_kind === "standard_included") continue;
            comps.push({ item_id: String(c.item_id), qty: c.qty });
          }
        }
        if (comps.length > 0) poolComponentsByProduct.set(`${pr.account_slug}#${pr.product_id}`, comps);
      }
    }

    const canonicalNames = activeItems.map((i) => i.name_canonical);
    const canonSet = new Set<string>(canonicalNames);
    const holdCounts = new Map<string, number>();
    const nextAvailMap = new Map<string, string>();
    for (const r of reservations) {
      // Pool path — when ANY hygglo_items[].product_id has a pool entry,
      // tally those components and skip the resolved_items fallback for
      // this reservation (the pool is authoritative). Listings without a
      // pool match still get the legacy path.
      const hItems = (r as { hygglo_items?: Array<{ product_id?: number; qty?: number }> }).hygglo_items ?? [];
      const slug = r.account_slug ?? "";
      let usedPool = false;
      if (hItems.length > 0 && poolEnabledAccounts.has(slug)) {
        for (const h of hItems) {
          if (typeof h.product_id !== "number") continue;
          const comps = poolComponentsByProduct.get(`${slug}#${h.product_id}`);
          if (!comps || comps.length === 0) continue;
          const lineQty = typeof h.qty === "number" && h.qty > 0 ? h.qty : 1;
          for (const c of comps) {
            const canon = itemIdToCanonical.get(c.item_id);
            if (!canon || !canonSet.has(canon)) continue;
            holdCounts.set(canon, (holdCounts.get(canon) ?? 0) + c.qty * lineQty);
            const existing = nextAvailMap.get(canon);
            if (!existing || (r.end_date && r.end_date > existing)) {
              nextAvailMap.set(canon, r.end_date ?? endStr);
            }
            usedPool = true;
          }
        }
      }
      if (usedPool) continue;
      // Legacy path (flag OFF, no pool row, or pool components all dropped).
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

/**
 * Append aliases to an item, de-duplicated (case-insensitive). Used by the
 * listing_info_pool resolver-fix backfill — when the LLM's free-form guess
 * doesn't match name_canonical, we store the guess as an alias so future
 * guesses of the same variant resolve immediately. See item_matcher.ts
 * bug A fix (aliases are now scored against the query).
 */
export const admin_appendAliases = mutation({
  args: {
    item_id: v.id("items"),
    aliases: v.array(v.string()),
  },
  handler: async (ctx, { item_id, aliases }) => {
    const item = await ctx.db.get(item_id);
    if (!item) throw new Error(`item not found: ${item_id}`);
    const existing = (item.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    const existingLower = new Set(existing.map((a) => a.toLowerCase()));
    const additions: string[] = [];
    for (const raw of aliases) {
      const a = raw.trim();
      if (!a) continue;
      const lower = a.toLowerCase();
      if (existingLower.has(lower)) continue;
      existingLower.add(lower);
      additions.push(lower);
    }
    if (additions.length === 0) {
      return { item_id, name_canonical: item.name_canonical, added: [], aliases: existing };
    }
    const merged = [...existing, ...additions];
    await ctx.db.patch(item_id, { aliases: merged, updated_at: Date.now() });
    return { item_id, name_canonical: item.name_canonical, added: additions, aliases: merged };
  },
});

/** Replace the aliases array on an item (deduplicated, lowercased). */
export const admin_setAliases = mutation({
  args: {
    item_id: v.id("items"),
    aliases: v.array(v.string()),
  },
  handler: async (ctx, { item_id, aliases }) => {
    const item = await ctx.db.get(item_id);
    if (!item) throw new Error(`item not found: ${item_id}`);
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of aliases) {
      const a = raw.trim().toLowerCase();
      if (!a || seen.has(a)) continue;
      seen.add(a);
      cleaned.push(a);
    }
    await ctx.db.patch(item_id, { aliases: cleaned, updated_at: Date.now() });
    return { item_id, name_canonical: item.name_canonical, aliases: cleaned };
  },
});

/**
 * Adjust an owned item's inventory facts by canonical name. Patches only the
 * fields supplied — qty (units owned, drives capacity / overbooking / calendar
 * / utilization) and the cost fields (acquisition_cost_gbp drives the dashboard
 * "inventory worth" / equipment-value card). Call with just `name_canonical`
 * and no value fields to read the current row (no-op write skipped). Writes an
 * `audit_log` row for traceability, matching the seed-script convention.
 */
export const admin_setItemInventory = mutation({
  args: {
    name_canonical: v.string(),
    qty: v.optional(v.number()),
    acquisition_cost_gbp: v.optional(v.number()),
    replacement_cost_gbp: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("items")
      .withIndex("by_canonical_name", (q) => q.eq("name_canonical", args.name_canonical))
      .first();
    if (!item) throw new Error(`item not found: ${args.name_canonical}`);

    const before = {
      qty: item.qty,
      acquisition_cost_gbp: item.acquisition_cost_gbp,
      replacement_cost_gbp: item.replacement_cost_gbp,
    };

    const patch: Record<string, number> = {};
    if (args.qty !== undefined && args.qty !== item.qty) patch.qty = args.qty;
    if (
      args.acquisition_cost_gbp !== undefined &&
      args.acquisition_cost_gbp !== item.acquisition_cost_gbp
    )
      patch.acquisition_cost_gbp = args.acquisition_cost_gbp;
    if (
      args.replacement_cost_gbp !== undefined &&
      args.replacement_cost_gbp !== item.replacement_cost_gbp
    )
      patch.replacement_cost_gbp = args.replacement_cost_gbp;

    const changed = Object.keys(patch).length > 0;
    if (changed) {
      await ctx.db.patch(item._id, { ...patch, updated_at: Date.now() });
      await ctx.db.insert("audit_log", {
        table_name: "items",
        actor: "daniel",
        op: "update",
        count: 1,
        source_file: "items.admin_setItemInventory",
        note:
          args.note ??
          `${item.name_canonical}: ${Object.entries(patch)
            .map(([k, v]) => `${k} ${(before as Record<string, unknown>)[k]}→${v}`)
            .join(", ")}`,
        ts: Date.now(),
      });
    }

    return {
      item_id: item._id,
      name_canonical: item.name_canonical,
      changed,
      before,
      after: { ...before, ...patch },
    };
  },
});

// `backfillImagesFuzzy` removed (Phase 7 / FIX-DESIGN §4.3): substring matching
// against unrelated reservations was the secondary cross-item-photo
// contamination path. Replaced by per-reservation `image_hints` written at
// poll time + `resolveImageForReservationItem` at read time.
