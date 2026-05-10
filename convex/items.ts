import { query } from "./_generated/server";
import { v } from "convex/values";

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

    // Fetch pricing for weighted split
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map(pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]));

    // Build canonical name lookup from pricing_catalog keys (normalized for fuzzy match)
    function normalizeKey(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    const canonicalNames = Array.from(priceByCanonical.keys());

    function matchCanonicalName(listingTitle: string): string {
      const titleNorm = normalizeKey(listingTitle);
      let best = listingTitle;
      let bestScore = 0;
      for (const canon of canonicalNames) {
        const canonNorm = normalizeKey(canon);
        if (titleNorm.includes(canonNorm) && canonNorm.length > bestScore) {
          best = canon;
          bestScore = canonNorm.length;
        }
      }
      return best;
    }

    const itemMap = new Map<string, { totalRevenue: number; rentalCount: number; totalDays: number }>();
    for (const r of reservations) {
      const items = r.items ?? [];
      const gross = r.gross_paid_gbp ?? 0;
      if (items.length === 0) continue;

      // Resolve canonical names and prices
      const canonNames = items.map((i) => matchCanonicalName(i.item_name));
      const prices = canonNames.map((name) => priceByCanonical.get(name) ?? 0);
      const priceSum = prices.reduce((s, p) => s + p, 0);

      for (let idx = 0; idx < items.length; idx++) {
        const canonName = canonNames[idx];
        const share = priceSum > 0
          ? gross * (prices[idx] / priceSum)
          : gross / items.length;
        const existing = itemMap.get(canonName) ?? { totalRevenue: 0, rentalCount: 0, totalDays: 0 };
        existing.totalRevenue += share;
        existing.rentalCount += 1;
        existing.totalDays += r.duration_days ?? 0;
        itemMap.set(canonName, existing);
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

    function normKey(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    function matchCanon(listingTitle: string): string | null {
      const tNorm = normKey(listingTitle);
      let best: string | null = null;
      let bestScore = 0;
      for (const canon of activeCanonicals) {
        const cNorm = normKey(canon);
        if (tNorm.includes(cNorm) && cNorm.length > bestScore) {
          best = canon;
          bestScore = cNorm.length;
        }
      }
      return best;
    }

    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        const canon = matchCanon(item.item_name);
        if (!canon) continue;
        rentalDaysMap.set(canon, (rentalDaysMap.get(canon) ?? 0) + (r.duration_days ?? 0));
      }
    }

    return activeItems.map((item) => {
        const rentalDays = rentalDaysMap.get(item.name_canonical) ?? 0;
        return {
          itemId: item._id,
          name: item.name_canonical,
          rentalDays,
          idleDays: Math.max(0, days - rentalDays),
          unavailDays: 0,
          utilizationPct: days > 0 ? rentalDays / days : 0,
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
        r.status === "confirmed" &&
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.start_date <= endStr &&
        r.end_date >= today
    );
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    // Build hold counts using fuzzy canonical name matching
    // (Hygglo item_name is the full listing title; items table uses short canonical names)
    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // Build a normalized lookup map: simplified key -> canonical name
    function normalize(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    // Match a Hygglo listing title to a canonical item name
    function matchCanonical(listingTitle: string, canonicalNames: string[]): string | null {
      const titleNorm = normalize(listingTitle);
      // Score each canonical name: how many of its tokens appear in the listing title
      let best: string | null = null;
      let bestScore = 0;
      for (const canon of canonicalNames) {
        const canonNorm = normalize(canon);
        // If the canonical name (normalized) appears in the listing title, it is a match
        if (titleNorm.includes(canonNorm) && canonNorm.length > bestScore) {
          best = canon;
          bestScore = canonNorm.length;
        }
      }
      return best;
    }

    const canonicalNames = activeItems.map((i) => i.name_canonical);

    const holdCounts = new Map<string, number>();
    const nextAvailMap = new Map<string, string>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        const canon = matchCanonical(item.item_name, canonicalNames);
        if (!canon) continue;
        holdCounts.set(canon, (holdCounts.get(canon) ?? 0) + 1);
        const existing = nextAvailMap.get(canon);
        if (!existing || (r.end_date && r.end_date > existing)) {
          nextAvailMap.set(canon, r.end_date ?? endStr);
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
    const sellCanonicals = activeGroups.map((i) => i.name_canonical);

    function normSell(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    function matchSellCanon(listingTitle: string): string | null {
      const tNorm = normSell(listingTitle);
      let best: string | null = null;
      let bestScore = 0;
      for (const canon of sellCanonicals) {
        const cNorm = normSell(canon);
        if (tNorm.includes(cNorm) && cNorm.length > bestScore) {
          best = canon;
          bestScore = cNorm.length;
        }
      }
      return best;
    }

    // Build rental-days per canonical name from reservation items[] with fuzzy matching
    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        const canon = matchSellCanon(item.item_name);
        if (!canon) continue;
        rentalDaysMap.set(canon, (rentalDaysMap.get(canon) ?? 0) + (r.duration_days ?? 0));
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
        const utilizationPct = rentalDays / LOOKBACK_DAYS;
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

// B-3: availability check for dashboard chat tool
export const checkAvailability = query({
  args: {
    item_name: v.string(),
    start_date: v.string(),
    end_date: v.string(),
  },
  handler: async (ctx, { item_name, start_date, end_date }) => {
    function norm(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    const q = norm(item_name);

    // Resolve canonical item
    const allItems = await ctx.db.query("items").collect();
    let best: typeof allItems[0] | null = null;
    let bestScore = 0;
    for (const i of allItems) {
      if (i.status !== "active" || i.is_marketing_only) continue;
      const cn = norm(i.name_canonical);
      const score = cn === q ? 3 : cn.includes(q) ? 2 : q.includes(cn) && cn.length > 3 ? 1 : 0;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (!best) return { ok: false as const, error: "item_not_found" as const };

    const item = best;
    const qty_total = item.qty;

    // Count overlapping confirmed reservations
    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q2) => q2.gte("start_date", start_date))
      .collect();
    const overlapRes = reservations.filter((r) => {
      if (r.status !== "confirmed" && r.status !== "pending_review") return false;
      if (!r.start_date || !r.end_date) return false;
      if (r.start_date > end_date) return false;
      if (r.end_date < start_date) return false;
      return (r.items ?? []).some((ri) => norm(ri.item_name).includes(norm(item.name_canonical)) || norm(item.name_canonical).includes(norm(ri.item_name).slice(0, 6)));
    });

    // Count calendar_holds in range
    const allHolds = await ctx.db.query("calendar_holds").collect();
    const overlapHolds = allHolds.filter((h) => {
      if (!h.date) return false;
      if (h.date < start_date || h.date > end_date) return false;
      if (h.status !== "confirmed") return false;
      return h.item_id === item._id;
    });

    const qty_held_in_window = overlapRes.length + overlapHolds.length;
    const available = qty_held_in_window < qty_total;

    // Next free date if unavailable
    let next_free_date: string | null = null;
    if (!available) {
      const latestEnd = overlapRes
        .map((r) => r.end_date ?? "")
        .sort()
        .reverse()[0];
      if (latestEnd) {
        const d = new Date(latestEnd);
        d.setDate(d.getDate() + 1);
        next_free_date = d.toISOString().slice(0, 10);
      }
    }

    return {
      ok: true as const,
      item: item.name_canonical,
      available,
      qty_total,
      qty_held_in_window,
      next_free_date_if_unavailable: next_free_date,
    };
  },
});

// B-3: compatibility check for dashboard chat tool
export const checkCompat = query({
  args: { itemA: v.string(), itemB: v.string() },
  handler: async (ctx, { itemA, itemB }) => {
    function norm(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    const allItems = await ctx.db.query("items").collect();
    function resolveItem(name: string) {
      const q = norm(name);
      let best: (typeof allItems)[0] | null = null;
      let bestScore = 0;
      for (const i of allItems) {
        const cn = norm(i.name_canonical);
        const score = cn === q ? 3 : cn.includes(q) ? 2 : q.includes(cn) && cn.length > 3 ? 1 : 0;
        if (score > bestScore) { best = i; bestScore = score; }
      }
      return best;
    }
    const a = resolveItem(itemA);
    const b = resolveItem(itemB);
    if (!a || !b) {
      const missing = [!a ? itemA : null, !b ? itemB : null].filter(Boolean).join(", ");
      return { compatible: false as const, reason: "item_not_found", evidence: [] as string[], missing };
    }
    const evidence: string[] = [];
    const compatA = a.compatibility;
    const compatB = b.compatibility;
    const bNorm = norm(b.name_canonical);
    const aNorm = norm(a.name_canonical);
    function listContains(list: string[] | undefined, target: string): boolean {
      if (!list) return false;
      return list.some((s) => norm(s).includes(target) || target.includes(norm(s).slice(0, 5)));
    }
    let compatible = false;
    if (compatA) {
      for (const [field, list] of Object.entries(compatA) as [string, string[] | undefined][]) {
        if (field === "included_with_rental") continue;
        if (listContains(list, bNorm)) {
          compatible = true;
          evidence.push(a.name_canonical + " lists " + b.name_canonical + " in compatibility." + field);
        }
      }
    }
    if (compatB) {
      for (const [field, list] of Object.entries(compatB) as [string, string[] | undefined][]) {
        if (field === "included_with_rental") continue;
        if (listContains(list, aNorm)) {
          compatible = true;
          evidence.push(b.name_canonical + " lists " + a.name_canonical + " in compatibility." + field);
        }
      }
    }
    if (a.lens_mount && b.lens_mount) {
      if (a.lens_mount === b.lens_mount) {
        compatible = true;
        evidence.push("Shared lens mount: " + a.lens_mount);
      } else {
        evidence.push("Mount mismatch: " + a.name_canonical + "=" + a.lens_mount + " vs " + b.name_canonical + "=" + b.lens_mount);
      }
    }
    if (a.battery_type && b.battery_type) {
      if (a.battery_type === b.battery_type) {
        compatible = true;
        evidence.push("Shared battery type: " + a.battery_type);
      } else {
        evidence.push("Battery mismatch: " + a.name_canonical + "=" + a.battery_type + " vs " + b.name_canonical + "=" + b.battery_type);
      }
    }
    if (a.card_type && b.card_type && a.card_type === b.card_type) {
      compatible = true;
      evidence.push("Shared card type: " + a.card_type);
    }
    const reason = compatible
      ? "Compatible — " + (evidence[0] ?? "shared spec found")
      : evidence.length > 0
        ? "Incompatible — " + evidence[0]
        : "No compatibility data found for this item pair";
    return { compatible, reason, evidence };
  },
});