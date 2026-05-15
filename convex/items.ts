import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { isConfirmedWithDates, isPaidWithV1Legacy } from "./lib/reservations/predicates";

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

    // Fetch pricing for weighted split
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map(pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]));

    // LLM-resolved items: revenue attributed strictly to inventory items
    // returned by item_resolver, never substring matched. Multi-item bundles
    // split gross by pricing_catalog weights (equal split if no prices).
    const itemMap = new Map<string, { totalRevenue: number; rentalCount: number; totalDays: number }>();
    for (const r of reservations) {
      const resolved = (r as { resolved_items?: Array<{ item_name_canonical: string }> }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      const gross = r.gross_paid_gbp ?? 0;
      const days = r.duration_days ?? 0;
      const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
      const priceSum = prices.reduce((a, b) => a + b, 0);
      resolved.forEach((x, idx) => {
        const share = priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
        const existing = itemMap.get(x.item_name_canonical) ?? { totalRevenue: 0, rentalCount: 0, totalDays: 0 };
        existing.totalRevenue += share;
        existing.rentalCount += 1;
        existing.totalDays += days;
        itemMap.set(x.item_name_canonical, existing);
      });
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
    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      const resolved = (r as { resolved_items?: Array<{ item_name_canonical: string }> }).resolved_items ?? [];
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
// v2 algorithm: indexed calendar_holds reads + reservation cross-check (transition safety)
// NOTE: 1-hour buffer is deferred — day-level model; same-day return + pickup is
// impossible in a binary day-level system. Buffer deferred to future time-of-day task.
export const checkAvailability = query({
  args: {
    item_name: v.string(),
    start_date: v.string(),
    end_date: v.string(),
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { item_name, start_date, end_date, account_slug }) => {
    function norm(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    const q = norm(item_name);

    // ── Step 1: Resolve item ──────────────────────────────────────────────
    // Case-insensitive match on name_canonical; fallback to aliases[].
    // NOTE: items table has no account_slug column (items are shared across accounts
    // in v2 schema). account_slug is echoed in output only for caller context.
    const allItems = await ctx.db.query("items").collect();
    let best: typeof allItems[0] | null = null;
    let bestScore = 0;
    for (const i of allItems) {
      if (i.status !== "active" || i.is_marketing_only) continue;
      const cn = norm(i.name_canonical);
      let score = cn === q ? 3 : cn.includes(q) ? 2 : q.includes(cn) && cn.length > 3 ? 1 : 0;
      if (score === 0) {
        // Alias fallback: any alias that matches bumps score to 1
        const aliasHit = (i.aliases ?? []).some((a) => {
          const an = norm(a);
          return an === q || an.includes(q) || (q.includes(an) && an.length > 3);
        });
        if (aliasHit) score = 1;
      }
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (!best) return { ok: false as const, error: "Item not found" as const, item_name };

    const item = best;
    const qty_total = item.qty ?? 1;

    // ── Step 2: Generate inclusive date range (YYYY-MM-DD strings) ───────
    const dates: string[] = [];
    const cursor = new Date(start_date + "T00:00:00Z");
    const endD = new Date(end_date + "T00:00:00Z");
    while (cursor <= endD) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // ── Step 3: calendar_holds per date — indexed reads ───────────────────
    // status ∈ {"confirmed","completed"} mirrors PAID_ORDER_STEPS derivation.
    const HOLD_STATUSES = new Set(["confirmed", "completed"]);
    const holdCountByDate = new Map<string, number>();
    for (const date of dates) {
      const holds = await ctx.db
        .query("calendar_holds")
        .withIndex("by_item_date", (q2) =>
          q2.eq("item_id", item._id).eq("date", date)
        )
        .collect();
      const filtered = holds.filter((h) => h.status && HOLD_STATUSES.has(h.status));
      holdCountByDate.set(date, filtered.reduce((sum, h) => sum + (h.qty_held ?? 1), 0));
    }

    // ── Step 4: owner_unavailability overlap ──────────────────────────────
    // Index by_item_date on ["item_id","start_date"]. Fetch rows starting ≤ end_date,
    // then filter to those whose end_date ≥ start_date for true overlap.
    const unavailRows = await ctx.db
      .query("owner_unavailability")
      .withIndex("by_item_date", (q2) =>
        q2.eq("item_id", item._id).lte("start_date", end_date)
      )
      .collect();
    const ownerUnavailDates = new Set<string>();
    for (const row of unavailRows) {
      if (row.end_date < start_date) continue;
      for (const date of dates) {
        if (date >= row.start_date && date <= row.end_date) {
          ownerUnavailDates.add(date);
        }
      }
    }

    // ── Step 5: Reservation cross-check (transition safety) ──────────────
    // Counts active reservations referencing this specific item via LLM-
    // resolved item_id (no fuzzy match — A7 II vs A7 III stays distinct).
    // Used to keep counts correct during the brief window when
    // calendar_holds lag reservations.
    const itemIdStr = item._id as string;
    const allReservations = await ctx.db.query("reservations").collect();
    const resCountByDate = new Map<string, number>();
    for (const r of allReservations) {
      if (!r.start_date || !r.end_date) continue;
      if (r.start_date > end_date || r.end_date < start_date) continue;
      if (!isPaidWithV1Legacy(r as any)) continue;
      const resolved = readResolverItems(r);
      const match = resolved.find((x) => x.item_id === itemIdStr);
      if (!match) continue;
      for (const date of dates) {
        if (date >= r.start_date && date <= r.end_date) {
          resCountByDate.set(date, (resCountByDate.get(date) ?? 0) + match.qty);
        }
      }
    }

    // ── Step 6: Compute peak held (Math.max hold vs res per date) ─────────
    const heldByDate = new Map<string, number>();
    for (const date of dates) {
      heldByDate.set(date, Math.max(holdCountByDate.get(date) ?? 0, resCountByDate.get(date) ?? 0));
    }

    const peak_held = Math.max(...Array.from(heldByDate.values()), 0);
    const available = peak_held < qty_total;
    const blocked_dates = dates.filter((d) => (heldByDate.get(d) ?? 0) >= qty_total);
    const owner_unavailable_dates = Array.from(ownerUnavailDates).sort();

    return {
      ok: true as const,
      item: {
        id: item._id,
        name: item.name_canonical,
        // items table has no account_slug; echoing caller's preference for context only
        account_slug: account_slug ?? null,
        qty_total,
      },
      available,
      peak_held,
      blocked_dates,
      owner_unavailable_dates,
      date_range: { start_date, end_date },
      source: "calendar_holds+reservations" as const,
    };
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

export const upsertAliases = mutation({
  args: {
    item_id: v.id("items"),
    aliases: v.array(v.string()),
  },
  handler: async (ctx, { item_id, aliases }) => {
    const existing = await ctx.db.get(item_id);
    if (!existing) throw new Error(`Item ${item_id} not found`);
    const merged = Array.from(new Set([...(existing.aliases ?? []), ...aliases]))
      .filter(a => a && a.trim().length > 0)
      .map(a => a.trim());
    await ctx.db.patch(item_id, { aliases: merged });
    return { item_id, alias_count: merged.length };
  },
});

/**
 * Admin mutation: populate image_url on an item from a reservation's photos_urls.
 * Matches by item name or alias (case-insensitive). Skips if image_url already set.
 * Picks first /products/ URL, or first URL if none contain /products/.
 * Also callable as a standalone admin tool from the dashboard or scripts.
 */
export const populateImageFromReservation = mutation({
  args: {
    item_name: v.string(),
    photos_urls: v.array(v.string()),
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { item_name, photos_urls }) => {
    const items = await ctx.db.query("items").collect();
    const lowerName = item_name.toLowerCase();
    const item = items.find(
      (i) =>
        i.name_canonical?.toLowerCase() === lowerName ||
        (i.aliases ?? []).some((a) => a.toLowerCase() === lowerName),
    );
    if (!item) return { found: false, item_name };
    if (item.image_url) return { found: true, skipped_already_set: true, item_id: item._id };
    const candidate = photos_urls.find((u) => u.includes("/products/")) ?? photos_urls[0];
    if (!candidate) return { found: true, skipped_no_url: true, item_id: item._id };
    await ctx.db.patch(item._id, { image_url: candidate });
    return { found: true, set: true, item_id: item._id, url: candidate };
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


/**
 * Backfill items.image_url using LLM-resolved item references on reservations.
 * For each item with image_url unset, walks reservations whose resolved_items
 * point to it and uses the first non-empty photos_urls[0] / first /products/
 * URL as the canonical image. No fuzzy matching.
 */
export const backfillImagesFromResolved = mutation({
  args: {},
  handler: async (ctx) => {
    const allItems = await ctx.db.query("items").collect();
    const targets = allItems.filter((i) => !i.image_url);
    if (targets.length === 0) return { total: 0, patched: 0 };

    const allReservations = await ctx.db.query("reservations").collect();
    // index reservations by resolved item_id
    const resByItemId = new Map<string, typeof allReservations>();
    for (const r of allReservations) {
      const resolved = (r as { resolved_items?: Array<{ item_id: string }> }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      if (!r.photos_urls || r.photos_urls.length === 0) continue;
      for (const x of resolved) {
        const list = resByItemId.get(x.item_id) ?? [];
        list.push(r);
        resByItemId.set(x.item_id, list);
      }
    }

    let patched = 0;
    for (const item of targets) {
      const matchingRes = resByItemId.get(item._id as string);
      if (!matchingRes || matchingRes.length === 0) continue;
      // Prefer a /products/ URL (CDN canonical), else first URL.
      let chosen: string | undefined;
      for (const r of matchingRes) {
        const urls = r.photos_urls ?? [];
        const product = urls.find((u: string) => u.includes("/products/"));
        if (product) { chosen = product; break; }
      }
      if (!chosen) {
        const first = matchingRes.find((r) => (r.photos_urls ?? []).length > 0);
        chosen = first?.photos_urls?.[0];
      }
      if (!chosen) continue;
      await ctx.db.patch(item._id, { image_url: chosen, updated_at: Date.now() });
      patched++;
    }
    return { total: targets.length, patched };
  },
});

/**
 * Fuzzy backfill for items whose image_url is still null AFTER the
 * resolver-based backfill ran. Walks every reservation, scores each one's
 * `items[].item_name` against the unresolved inventory canon + aliases
 * (case-insensitive substring match, min 5 chars), and patches the first
 * /products/ photo URL it finds.
 *
 * Use when the LLM resolver hasn't reached an item yet — manual cron catch-up.
 */
export const backfillImagesFuzzy = mutation({
  args: {},
  handler: async (ctx) => {
    const allItems = await ctx.db.query("items").collect();
    const targets = allItems.filter((i) => !i.image_url);
    if (targets.length === 0) return { total: 0, patched: 0, scanned: 0 };

    const allReservations = await ctx.db.query("reservations").collect();
    const reservationsWithPhotos = allReservations.filter(
      (r) => (r.photos_urls?.length ?? 0) > 0,
    );

    let patched = 0;
    let scanned = 0;
    for (const item of targets) {
      scanned++;
      const canon = (item.name_canonical ?? "").toLowerCase().trim();
      const aliases = (item.aliases ?? []).map((a) => a.toLowerCase().trim());
      if (canon.length < 5) continue;

      const matchPhotos = (r: typeof allReservations[number]): string | null => {
        const titles = (r.items ?? []).map((i) => (i.item_name ?? "").toLowerCase());
        const hit = titles.some((t) => {
          if (!t || t.length < 5) return false;
          if (t === canon || t.includes(canon) || canon.includes(t)) return true;
          for (const a of aliases) {
            if (a.length < 5) continue;
            if (t === a || t.includes(a) || a.includes(t)) return true;
          }
          return false;
        });
        if (!hit) return null;
        const urls = r.photos_urls ?? [];
        return urls.find((u: string) => u.includes("/products/")) ?? urls[0] ?? null;
      };

      let chosen: string | null = null;
      for (const r of reservationsWithPhotos) {
        chosen = matchPhotos(r);
        if (chosen) break;
      }
      if (!chosen) continue;
      await ctx.db.patch(item._id, { image_url: chosen, updated_at: Date.now() });
      patched++;
    }
    return { total: targets.length, patched, scanned };
  },
});

// ─── Item Schedule (with time-of-day awareness) ─────────────────────────────
//  Used by the chat agent to answer questions like "is the FX3 free today
//  after 7pm?" and "when is the BMPCC next available?". Walks confirmed
//  reservations whose date range overlaps [from, to], pulls the LLM-extracted
//  pickup_time / return_time strings, and builds a per-day timeline with
//  free intervals computed in HH:MM.
// ────────────────────────────────────────────────────────────────────────────

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveItem<T extends { name_canonical?: string; aliases?: string[]; status?: string; is_marketing_only?: boolean }>(
  items: T[],
  itemName: string,
): T | null {
  const q = normName(itemName);
  let best: T | null = null;
  let bestScore = 0;
  for (const i of items) {
    if (i.status !== "active" || i.is_marketing_only) continue;
    const cn = normName(i.name_canonical ?? "");
    let score = cn === q ? 3 : cn.includes(q) ? 2 : q.includes(cn) && cn.length > 3 ? 1 : 0;
    if (score === 0) {
      const aliasHit = (i.aliases ?? []).some((a) => {
        const an = normName(a);
        return an === q || an.includes(q) || (q.includes(an) && an.length > 3);
      });
      if (aliasHit) score = 1;
    }
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

function addDateIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmt12(t: string | null | undefined): string | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

/**
 * Per-item daily schedule with intra-day free-window inference.
 *
 * Returns one entry per day in [fromDate, toDate]:
 *   { date, status: "free" | "partial" | "fully_booked", blocks: [{startTime, endTime, renterName}],
 *     freeAfter, freeUntil, nextAvailableAt }
 *
 * "Available after 7 PM" answers are produced by the agent reading `freeAfter`.
 */
export const getItemSchedule = query({
  args: {
    item_name: v.string(),
    from_date: v.string(),                  // YYYY-MM-DD inclusive
    to_date: v.string(),                    // YYYY-MM-DD inclusive
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { item_name, from_date, to_date, account_slug }) => {
    const allItems = await ctx.db.query("items").collect();
    const item = resolveItem(allItems, item_name);
    if (!item) return { ok: false as const, error: "Item not found" as const, item_name };

    // Reservations whose date range overlaps [from_date, to_date]
    const allRes = await ctx.db.query("reservations").collect();
    type Rich = typeof allRes[number] & {
      pickup_time?: string;
      return_time?: string;
      renter_name?: string;
      resolved_items?: Array<{ item_id: string; item_name_canonical: string }>;
    };

    // Match via resolved_items (strict id) — falls back to canonical/alias fuzz.
    // Capture locals so the inner function sees narrowed (non-null) types.
    const itemId = item._id;
    const canon = normName(item.name_canonical);
    const aliasNorms = (item.aliases ?? []).map(normName);
    function rentalMentionsItem(r: Rich): boolean {
      if (r.resolved_items?.some((x) => x.item_id === itemId)) return true;
      // Fallback: substring match on raw Hygglo titles.
      return (r.items ?? []).some((ri) => {
        const rn = normName(ri.item_name);
        if (rn.includes(canon) || (canon.includes(rn) && rn.length > 3)) return true;
        return aliasNorms.some((an) => rn.includes(an) || (an.includes(rn) && rn.length > 3));
      });
    }

    const matched = allRes.filter((r) => {
      const rr = r as Rich;
      if (!rr.start_date || !rr.end_date) return false;
      if (rr.start_date > to_date || rr.end_date < from_date) return false;
      if (!isPaidWithV1Legacy(rr as any)) return false;
      if (account_slug && rr.account_slug !== account_slug) return false;
      return rentalMentionsItem(rr);
    }) as Rich[];

    // Build renter name map for any rentals missing renter_name denorm.
    const renterIds = [...new Set(matched.filter((r) => r.renter_id && !r.renter_name).map((r) => r.renter_id as string))];
    const renterMap = new Map<string, string>();
    await Promise.all(
      renterIds.map(async (rid) => {
        const renter = (await ctx.db.get(rid as never)) as { display_name?: string } | null;
        if (renter) renterMap.set(rid, renter.display_name ?? "?");
      }),
    );
    function renterOf(r: Rich): string {
      return r.renter_name ?? (r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?");
    }

    // Walk each day and assemble intra-day intervals.
    const days: Array<{
      date: string;
      status: "free" | "partial" | "fully_booked";
      blocks: Array<{ startTime: string | null; endTime: string | null; startTime12: string | null; endTime12: string | null; renterName: string; reservationId: string }>;
      freeAfter: string | null;
      freeUntil: string | null;
      nextAvailableAt: string | null;
      summary: string;
    }> = [];

    const qty_total = item.qty ?? 1;
    let cursor = from_date;
    while (cursor <= to_date) {
      const dayRentals = matched.filter((r) => cursor >= (r.start_date as string) && cursor <= (r.end_date as string));
      const peakHeld = dayRentals.length; // each rental counts as 1 unit held
      const blocks: typeof days[number]["blocks"] = [];
      let freeAfter: string | null = null;
      let freeUntil: string | null = null;

      for (const r of dayRentals) {
        const isFirstDay = cursor === r.start_date;
        const isLastDay = cursor === r.end_date;
        // Block window for this rental on this day:
        // - first day starts at pickup_time, otherwise 00:00
        // - last day ends at return_time, otherwise 23:59
        const startTime = isFirstDay ? r.pickup_time ?? null : "00:00";
        const endTime = isLastDay ? r.return_time ?? null : "23:59";
        blocks.push({
          startTime,
          endTime,
          startTime12: fmt12(startTime),
          endTime12: fmt12(endTime),
          renterName: renterOf(r),
          reservationId: r._id,
        });
      }

      // Compute free windows ONLY if there's spare capacity (peakHeld < qty_total)
      // OR all blocks on this day are at the edges (single block w/ known start/end times).
      // Simplification: if qty_total > 1 and not fully held, it's available all day.
      let status: "free" | "partial" | "fully_booked";
      if (peakHeld === 0) {
        status = "free";
        freeAfter = "00:00";
        freeUntil = "23:59";
      } else if (peakHeld < qty_total) {
        status = "partial";
        freeAfter = "00:00";
        freeUntil = "23:59";
      } else {
        // All units held. See if the last unit returns within the day → free after.
        const lastUnitReleases = dayRentals
          .filter((r) => r.end_date === cursor && r.return_time)
          .map((r) => r.return_time as string)
          .sort()
          .pop();
        const firstUnitStarts = dayRentals
          .filter((r) => r.start_date === cursor && r.pickup_time)
          .map((r) => r.pickup_time as string)
          .sort()[0];
        if (lastUnitReleases && (!firstUnitStarts || lastUnitReleases < firstUnitStarts)) {
          // Free between lastUnitReleases and (firstUnitStarts || 23:59)
          status = "partial";
          freeAfter = lastUnitReleases;
          freeUntil = firstUnitStarts ?? "23:59";
        } else if (firstUnitStarts && !lastUnitReleases) {
          // Free until firstUnitStarts
          status = "partial";
          freeAfter = "00:00";
          freeUntil = firstUnitStarts;
        } else {
          status = "fully_booked";
        }
      }

      const summary = (() => {
        if (status === "free") return "Free all day";
        if (status === "fully_booked") return `Fully booked (${peakHeld}/${qty_total})`;
        if (freeAfter && freeUntil && freeAfter !== "00:00" && freeUntil !== "23:59")
          return `Free between ${fmt12(freeAfter)} – ${fmt12(freeUntil)}`;
        if (freeAfter && freeAfter !== "00:00") return `Free after ${fmt12(freeAfter)}`;
        if (freeUntil && freeUntil !== "23:59") return `Free until ${fmt12(freeUntil)}`;
        return `Partially held (${peakHeld}/${qty_total} units out)`;
      })();

      days.push({
        date: cursor,
        status,
        blocks,
        freeAfter,
        freeUntil,
        nextAvailableAt: null, // populated below
        summary,
      });
      cursor = addDateIso(cursor, 1);
    }

    // Compute "nextAvailableAt" — first time after now when the item is free
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    let nextAvailableAt: string | null = null;
    for (const d of days) {
      if (d.status === "free" || d.status === "partial") {
        if (d.date > todayIso) {
          nextAvailableAt = `${d.date} ${d.freeAfter ? fmt12(d.freeAfter) ?? "" : ""}`.trim();
          break;
        }
        if (d.date === todayIso && d.freeAfter) {
          const hm = d.freeAfter.match(/^(\d{1,2}):(\d{2})/);
          if (hm) {
            const slot = new Date(now);
            slot.setHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
            if (slot > now) {
              nextAvailableAt = `today ${fmt12(d.freeAfter)}`;
              break;
            }
          }
        }
      }
    }

    return {
      ok: true as const,
      item: {
        id: item._id,
        name: item.name_canonical,
        qty_total,
      },
      from_date,
      to_date,
      nextAvailableAt,
      days,
      source: "reservations+items (with pickup_time / return_time)" as const,
    };
  },
});

// ─── Per-item monthly earnings ──────────────────────────────────────────────
//  Replaces the single-bucket stub on data.revenue.getItemEarningsHistory.
//  Returns up to `months` worth of per-month gross/net/count buckets, using
//  the same pricing-weighted revenue split as getItemRevenueRanking.
// ────────────────────────────────────────────────────────────────────────────

export const getItemMonthlyEarnings = query({
  args: {
    item_name: v.string(),
    months: v.optional(v.number()),         // default 12
    account_slug: v.optional(v.string()),
  },
  handler: async (ctx, { item_name, months, account_slug }) => {
    const n = months ?? 12;
    const allItems = await ctx.db.query("items").collect();
    const item = resolveItem(allItems, item_name);
    if (!item) return { ok: false as const, error: "Item not found" as const, item_name };

    // Window: last N calendar months
    const today = new Date();
    const fromDate = new Date(today.getFullYear(), today.getMonth() - (n - 1), 1)
      .toISOString()
      .slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", fromDate))
      .collect();
    if (account_slug) {
      reservations = reservations.filter((r) => r.account_slug === account_slug);
    }
    reservations = reservations.filter((r) => isPaidWithV1Legacy(r as any));

    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    // Init 12 month buckets
    type Bucket = { month: string; grossGbp: number; netGbp: number; rentalCount: number; totalDays: number };
    const buckets = new Map<string, Bucket>();
    for (let i = 0; i < n; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() - (n - 1 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, { month: key, grossGbp: 0, netGbp: 0, rentalCount: 0, totalDays: 0 });
    }

    for (const r of reservations) {
      const resolved = (r as { resolved_items?: Array<{ item_id: string; item_name_canonical: string }> }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      const hit = resolved.find((x) => x.item_id === item._id);
      if (!hit) continue;

      const eff = (r.pickup_date ?? r.start_date) as string | undefined;
      if (!eff) continue;
      const key = eff.slice(0, 7);
      const bucket = buckets.get(key);
      if (!bucket) continue; // outside window

      const gross = r.gross_paid_gbp ?? 0;
      const net = r.net_to_owner_gbp ?? 0;
      const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
      const priceSum = prices.reduce((a, b) => a + b, 0);
      const myPrice = priceByCanonical.get(hit.item_name_canonical) ?? 0;
      const share = priceSum > 0 ? myPrice / priceSum : 1 / resolved.length;

      bucket.grossGbp += gross * share;
      bucket.netGbp += net * share;
      bucket.rentalCount += 1;
      bucket.totalDays += r.duration_days ?? 0;
    }

    const monthly = Array.from(buckets.values()).map((b) => ({
      ...b,
      grossGbp: Math.round(b.grossGbp * 100) / 100,
      netGbp: Math.round(b.netGbp * 100) / 100,
    }));

    const totals = monthly.reduce(
      (acc, b) => ({
        grossGbp: acc.grossGbp + b.grossGbp,
        netGbp: acc.netGbp + b.netGbp,
        rentalCount: acc.rentalCount + b.rentalCount,
        totalDays: acc.totalDays + b.totalDays,
      }),
      { grossGbp: 0, netGbp: 0, rentalCount: 0, totalDays: 0 },
    );

    return {
      ok: true as const,
      item: { id: item._id, name: item.name_canonical },
      months: n,
      window: { from: fromDate, to: today.toISOString().slice(0, 10) },
      monthly,
      totals: {
        grossGbp: Math.round(totals.grossGbp * 100) / 100,
        netGbp: Math.round(totals.netGbp * 100) / 100,
        rentalCount: totals.rentalCount,
        totalDays: totals.totalDays,
      },
      source: "reservations.resolved_items + pricing_catalog" as const,
    };
  },
});

// ─── Acquisition cost write + audit ─────────────────────────────────────────

/**
 * Set acquisition cost (and optionally acquired_at) for an item by name or id.
 * Used by the chat agent when Leo says "I paid £4200 for the FX3" so future
 * payback/ROI tools have data to work with.
 */
export const setItemAcquisition = mutation({
  args: {
    item_name: v.optional(v.string()),
    item_id: v.optional(v.id("items")),
    cost_gbp: v.number(),
    acquired_at: v.optional(v.number()),         // unix ms; omit if unknown
    replacement_cost_gbp: v.optional(v.number()),
  },
  handler: async (ctx, { item_name, item_id, cost_gbp, acquired_at, replacement_cost_gbp }) => {
    if (!item_id && !item_name) {
      return { ok: false as const, error: "Provide item_id or item_name" };
    }
    let target: Doc<"items"> | null = null;
    if (item_id) {
      target = await ctx.db.get(item_id);
    } else {
      const all = await ctx.db.query("items").collect();
      target = resolveItem(all, item_name!) as Doc<"items"> | null;
    }
    if (!target) return { ok: false as const, error: "Item not found" };

    const patch: Partial<Doc<"items">> = { acquisition_cost_gbp: cost_gbp };
    if (acquired_at !== undefined) patch.acquired_at = acquired_at;
    if (replacement_cost_gbp !== undefined) patch.replacement_cost_gbp = replacement_cost_gbp;
    patch.updated_at = Date.now();
    await ctx.db.patch(target._id, patch);
    return {
      ok: true as const,
      item: { id: target._id, name: target.name_canonical },
      patched: patch,
    };
  },
});

/**
 * Audit: list active items missing acquisition_cost_gbp. Helps the chat agent
 * say "you have 14 items without a recorded cost — want me to walk through them?"
 */
export const listItemsMissingAcquisition = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("items").collect();
    const missing = all
      .filter((i) => i.status === "active" && !i.is_marketing_only && (i.acquisition_cost_gbp ?? 0) === 0)
      .map((i) => ({
        itemId: i._id,
        name: i.name_canonical,
        qty: i.qty,
        kind: i.kind,
        replacementCostGbp: i.replacement_cost_gbp ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const totalActive = all.filter((i) => i.status === "active" && !i.is_marketing_only).length;
    return {
      missingCount: missing.length,
      totalActive,
      coveragePct: totalActive > 0 ? Math.round(((totalActive - missing.length) / totalActive) * 100) : 0,
      items: missing,
    };
  },
});

// ─── Per-item payback / break-even ──────────────────────────────────────────

/**
 * Payback status: cumulative lifetime gross vs acquisition cost.
 * - Pass item_name for one item, or omit for top N (default 20) all-items view.
 * - Returns acquisition cost, total earnings, paid_back_pct, last rental,
 *   monthsOwned, monthlyAvg, projectedPaybackDate (when not yet paid back).
 */
export const getItemPayback = query({
  args: {
    item_name: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { item_name, limit }) => {
    const allItems = await ctx.db.query("items").collect();
    const active = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // Pre-compute per-item gross from resolved_items.
    const reservations = await ctx.db.query("reservations").collect();
    const grossByItemId = new Map<string, { gross: number; lastDate: string }>();
    for (const r of reservations) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const resolved = (r as { resolved_items?: Array<{ item_id: string }> }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      const eff = (r as { pickup_date?: string }).pickup_date ?? r.start_date;
      if (!eff) continue;
      const share = (r.gross_paid_gbp ?? 0) / resolved.length;
      for (const x of resolved) {
        const cur = grossByItemId.get(x.item_id) ?? { gross: 0, lastDate: "" };
        cur.gross += share;
        if (eff > cur.lastDate) cur.lastDate = eff;
        grossByItemId.set(x.item_id, cur);
      }
    }

    function buildRow(i: typeof allItems[number]) {
      const stats = grossByItemId.get(i._id) ?? { gross: 0, lastDate: "" };
      const acquired = (i as { acquired_at?: number }).acquired_at ?? i.created_at;
      const monthsOwned = Math.max(1, (Date.now() - acquired) / (1000 * 60 * 60 * 24 * 30));
      const cost = i.acquisition_cost_gbp ?? null;
      const paidBackPct = cost && cost > 0 ? (stats.gross / cost) * 100 : null;
      const monthlyAvg = stats.gross / monthsOwned;
      let projectedPaybackMonths: number | null = null;
      let status: "paid_back" | "on_track" | "slow" | "unknown_cost" = "unknown_cost";
      if (cost && cost > 0) {
        if (stats.gross >= cost) {
          status = "paid_back";
        } else if (monthlyAvg > 0) {
          projectedPaybackMonths = (cost - stats.gross) / monthlyAvg;
          status = projectedPaybackMonths <= 24 ? "on_track" : "slow";
        } else {
          status = "slow";
        }
      }
      return {
        itemId: i._id,
        name: i.name_canonical,
        qty: i.qty,
        acquisitionCostGbp: cost,
        lifetimeGrossGbp: Math.round(stats.gross * 100) / 100,
        paidBackPct: paidBackPct === null ? null : Math.round(paidBackPct * 10) / 10,
        monthsOwned: Math.round(monthsOwned * 10) / 10,
        monthlyAvgGbp: Math.round(monthlyAvg * 100) / 100,
        projectedPaybackMonths:
          projectedPaybackMonths === null ? null : Math.round(projectedPaybackMonths * 10) / 10,
        lastRentalDate: stats.lastDate || null,
        status,
      };
    }

    if (item_name) {
      const it = resolveItem(active, item_name);
      if (!it) return { ok: false as const, error: "Item not found", item_name };
      return { ok: true as const, mode: "single" as const, item: buildRow(it) };
    }

    const rows = active
      .map(buildRow)
      .sort((a, b) => {
        // Items missing cost go to the bottom so the useful rows come first.
        if (a.acquisitionCostGbp === null && b.acquisitionCostGbp !== null) return 1;
        if (b.acquisitionCostGbp === null && a.acquisitionCostGbp !== null) return -1;
        return (b.paidBackPct ?? -1) - (a.paidBackPct ?? -1);
      })
      .slice(0, limit ?? 20);
    return { ok: true as const, mode: "ranked" as const, rows };
  },
});

// ─── Kit affinity (co-rental pairs) ─────────────────────────────────────────

/**
 * Most-co-rented items with the target item. Helps suggest bundles + flag
 * forgotten accessories.
 * Returns: { item, pairs: [{itemId, name, coOccurrences, supportPct, lastSeen}] }
 *  - supportPct = co_count / total_rentals_of_target
 */
export const getKitAffinity = query({
  args: {
    item_name: v.string(),
    min_support: v.optional(v.number()),         // min co-occurrence (default 2)
    days: v.optional(v.number()),                // lookback; default 365
  },
  handler: async (ctx, { item_name, min_support, days }) => {
    const minSupport = min_support ?? 2;
    const lookbackDays = days ?? 365;

    const allItems = await ctx.db.query("items").collect();
    const target = resolveItem(allItems.filter((i) => i.status === "active" && !i.is_marketing_only), item_name);
    if (!target) return { ok: false as const, error: "Item not found", item_name };

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();

    const itemById = new Map<string, typeof allItems[number]>();
    for (const i of allItems) itemById.set(i._id as string, i);

    let totalRentalsOfTarget = 0;
    const coCount = new Map<string, { count: number; lastSeen: string }>();
    for (const r of reservations) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const resolved = (r as { resolved_items?: Array<{ item_id: string }> }).resolved_items ?? [];
      const ids = resolved.map((x) => x.item_id);
      if (!ids.includes(target._id as string)) continue;
      totalRentalsOfTarget++;
      const eff = (r as { pickup_date?: string }).pickup_date ?? r.start_date ?? "";
      for (const otherId of ids) {
        if (otherId === target._id) continue;
        const cur = coCount.get(otherId) ?? { count: 0, lastSeen: "" };
        cur.count++;
        if (eff > cur.lastSeen) cur.lastSeen = eff;
        coCount.set(otherId, cur);
      }
    }

    const pairs = Array.from(coCount.entries())
      .filter(([, v]) => v.count >= minSupport)
      .map(([id, v]) => {
        const it = itemById.get(id);
        return {
          itemId: id,
          name: it?.name_canonical ?? id,
          kind: it?.kind ?? null,
          coOccurrences: v.count,
          supportPct:
            totalRentalsOfTarget > 0 ? Math.round((v.count / totalRentalsOfTarget) * 1000) / 10 : 0,
          lastSeen: v.lastSeen || null,
        };
      })
      .sort((a, b) => b.coOccurrences - a.coOccurrences);

    return {
      ok: true as const,
      item: { id: target._id, name: target.name_canonical },
      totalRentalsOfTarget,
      lookbackDays,
      pairs,
    };
  },
});

// ─── Dust collectors (high-value idle items) ────────────────────────────────

/**
 * Items not rented in the last `idle_days` window, sorted by acquisition cost
 * descending (high-cost dust first). Backs sell-recommender narrative.
 */
export const getDustCollectors = query({
  args: {
    idle_days: v.optional(v.number()),           // default 60
    min_cost_gbp: v.optional(v.number()),        // default 200 to focus on real money
  },
  handler: async (ctx, { idle_days, min_cost_gbp }) => {
    const idleDays = idle_days ?? 60;
    const minCost = min_cost_gbp ?? 200;

    const allItems = await ctx.db.query("items").collect();
    const active = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - idleDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Find last-rental date per item (using resolved_items strict match).
    const reservations = await ctx.db.query("reservations").collect();
    const lastRentalByItemId = new Map<string, string>();
    for (const r of reservations) {
      if (!isPaidWithV1Legacy(r as any)) continue;
      const eff = (r as { pickup_date?: string }).pickup_date ?? r.start_date;
      if (!eff) continue;
      const resolved = (r as { resolved_items?: Array<{ item_id: string }> }).resolved_items ?? [];
      for (const x of resolved) {
        const cur = lastRentalByItemId.get(x.item_id) ?? "";
        if (eff > cur) lastRentalByItemId.set(x.item_id, eff);
      }
    }

    const dust = active
      .map((i) => {
        const cost = i.acquisition_cost_gbp ?? 0;
        const last = lastRentalByItemId.get(i._id as string) ?? "";
        const isIdle = !last || last < cutoffStr;
        return {
          itemId: i._id,
          name: i.name_canonical,
          qty: i.qty,
          acquisitionCostGbp: cost || null,
          replacementCostGbp: i.replacement_cost_gbp ?? null,
          lastRentalDate: last || null,
          idle: isIdle,
        };
      })
      .filter((r) => r.idle && (r.acquisitionCostGbp ?? 0) >= minCost)
      .sort((a, b) => (b.acquisitionCostGbp ?? 0) - (a.acquisitionCostGbp ?? 0));

    const totalDustCostGbp = dust.reduce((s, r) => s + (r.acquisitionCostGbp ?? 0), 0);
    return {
      ok: true as const,
      idleDays,
      minCostGbp: minCost,
      count: dust.length,
      totalDustCostGbp: Math.round(totalDustCostGbp),
      items: dust,
    };
  },
});

// ─── Damage / claim history per item ────────────────────────────────────────

export const getItemDamageHistory = query({
  args: {
    item_name: v.optional(v.string()),
    days: v.optional(v.number()),                 // default 365
    limit: v.optional(v.number()),                // top N when listing all
  },
  handler: async (ctx, { item_name, days, limit }) => {
    const lookbackDays = days ?? 365;
    const cutoff = Date.now() - lookbackDays * 86400 * 1000;
    const claims = await ctx.db.query("insurance_claims").collect();
    const recent = claims.filter(
      (c) => new Date(c.claim_date + "T00:00:00Z").getTime() >= cutoff,
    );

    const allItems = await ctx.db.query("items").collect();
    if (item_name) {
      const it = resolveItem(allItems, item_name);
      if (!it) return { ok: false as const, error: "Item not found", item_name };
      const myClaims = recent.filter(
        (c) =>
          c.item_id === it._id ||
          (c.item_name_canonical &&
            normName(c.item_name_canonical) === normName(it.name_canonical)),
      );
      const totalGbp = myClaims.reduce((s, c) => s + (c.amount_gbp ?? 0), 0);
      return {
        ok: true as const,
        mode: "single" as const,
        item: { id: it._id, name: it.name_canonical },
        lookbackDays,
        claimCount: myClaims.length,
        totalGbp: Math.round(totalGbp * 100) / 100,
        openCount: myClaims.filter((c) => c.status === "open").length,
        settledCount: myClaims.filter((c) => c.status === "settled").length,
        deniedCount: myClaims.filter((c) => c.status === "denied").length,
        claims: myClaims
          .map((c) => ({
            claimId: c._id,
            date: c.claim_date,
            amountGbp: c.amount_gbp,
            status: c.status,
            description: c.description ?? null,
          }))
          .sort((a, b) => b.date.localeCompare(a.date)),
      };
    }

    // Top items by total claim £ in window.
    const byItemId = new Map<string, { count: number; totalGbp: number; name: string }>();
    const byCanonName = new Map<string, { count: number; totalGbp: number }>();
    for (const c of recent) {
      const amt = c.amount_gbp ?? 0;
      if (c.item_id) {
        const it = allItems.find((i) => i._id === c.item_id);
        const cur = byItemId.get(c.item_id) ?? {
          count: 0,
          totalGbp: 0,
          name: it?.name_canonical ?? "(unknown)",
        };
        cur.count++;
        cur.totalGbp += amt;
        byItemId.set(c.item_id, cur);
      } else if (c.item_name_canonical) {
        const key = c.item_name_canonical;
        const cur = byCanonName.get(key) ?? { count: 0, totalGbp: 0 };
        cur.count++;
        cur.totalGbp += amt;
        byCanonName.set(key, cur);
      }
    }
    const rows = [
      ...Array.from(byItemId.values()).map((v) => ({
        name: v.name,
        claimCount: v.count,
        totalGbp: Math.round(v.totalGbp * 100) / 100,
      })),
      ...Array.from(byCanonName.entries()).map(([name, v]) => ({
        name,
        claimCount: v.count,
        totalGbp: Math.round(v.totalGbp * 100) / 100,
      })),
    ].sort((a, b) => b.totalGbp - a.totalGbp).slice(0, limit ?? 20);

    return {
      ok: true as const,
      mode: "ranked" as const,
      lookbackDays,
      totalClaims: recent.length,
      totalGbp: Math.round(recent.reduce((s, c) => s + (c.amount_gbp ?? 0), 0) * 100) / 100,
      rows,
    };
  },
});
