/**
 * Lost-revenue queries (Wave 2.5).
 *
 * Ports three V1 methods from `/home/ubuntu/rental-manager/src/lost-revenue/lost-revenue.service.ts`:
 *   - getUnmatchedDemand          (V1:635)
 *   - getSubstitutionPatterns     (V1:959 getSubstitutionAnalysis)
 *   - getPurchaseRecommendations  (V1:1171)
 *
 * V1 backed onto `lost_revenue_record` (rich: `unmatched_items[]`,
 * `lost_revenue`, `blocked_items`, `renter_info`). V2 only has the simpler
 * `denial_records` table (one denial = one item name). We adapt accordingly
 * and surface caveats in the data layer.
 *
 * Business constants (mirrored from src/mastra/data/constants.ts):
 *   - OWNER_SHARE = 0.64
 *   - V1 default rental-length assumption for ROI projections: see
 *     getRevenuePotential — V1 uses monthly extrapolation (lostRevenue / 6
 *     months). For purchase recommendations we mirror the V1 "monthly
 *     revenue potential" projection.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";

const OWNER_SHARE = 0.64;
/** V1 assumption for converting daily rate → average rental length when no
 *  reservation history exists. V1 short rentals average ~3 days. */
const ASSUMED_AVG_RENTAL_DAYS = 3;
/** ROI projection window for purchase recommendations. */
const ROI_WINDOW_DAYS = 365;
/** Sliding window for substitution detection — V1 uses 14 days
 *  (lost-revenue.service.ts:989: `ABS(start_date - lr.start_date) < 14 days`). */
const SUBSTITUTION_WINDOW_MS = 14 * 86400 * 1000;

function normItem(s: string | undefined | null): string {
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Port of V1 getUnmatchedDemand (lost-revenue.service.ts:635).
 *
 * V1 logic: iterate `lost_revenue_record.unmatched_items[]`, group by
 * normalised item name, count frequency, sum lost_revenue, filter to items
 * with >=2 requests, sort by totalRevenue desc, top-30.
 *
 * V2 mapping: `denial_records.item_name` is already a single normalised item.
 * Group by item_name, count, surface the most recent created_at, and estimate
 * lost £ from `estimated_value` when present (fallback: leave at 0 — the
 * data-layer fn enriches with pricing_catalog).
 */
export const getUnmatchedDemand = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
    minRequestCount: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days, minRequestCount, limit }) => {
    const windowDays = days ?? 180; // V1 default period '6m'
    const cutoff = Date.now() - windowDays * 86400 * 1000;
    const minCount = minRequestCount ?? 2; // V1 parity: `requestCount >= 2`
    const take = limit ?? 30;

    let accountId: import("./_generated/dataModel").Id<"accounts"> | undefined;
    if (accountSlug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
        .first();
      accountId = acc?._id;
    }

    const rows = await ctx.db.query("denial_records").collect();

    type Agg = {
      displayName: string;
      requestCount: number;
      lastRequestedAt: number;
      totalLostGbpEst: number;
    };
    const byItem = new Map<string, Agg>();
    for (const r of rows) {
      if (r.created_at < cutoff) continue;
      if (accountId && r.account_id !== accountId) continue;
      const name = r.item_name;
      if (!name) continue;
      const key = normItem(name);
      if (!key) continue;
      const cur = byItem.get(key) ?? {
        displayName: name,
        requestCount: 0,
        lastRequestedAt: 0,
        totalLostGbpEst: 0,
      };
      cur.requestCount++;
      if (r.created_at > cur.lastRequestedAt) cur.lastRequestedAt = r.created_at;
      if (typeof r.estimated_value === "number") cur.totalLostGbpEst += r.estimated_value;
      byItem.set(key, cur);
    }

    const out = Array.from(byItem.values())
      .filter((a) => a.requestCount >= minCount)
      .map((a) => ({
        itemName: a.displayName,
        requestCount: a.requestCount,
        lastRequestedAt: a.lastRequestedAt,
        totalLostGbpEst: Math.round(a.totalLostGbpEst * 100) / 100,
      }))
      .sort((a, b) => b.requestCount - a.requestCount || b.totalLostGbpEst - a.totalLostGbpEst)
      .slice(0, take);

    return {
      windowDays,
      minRequestCount: minCount,
      items: out,
      totalDenials: rows.length,
    };
  },
});

/**
 * Port of V1 getSubstitutionAnalysis (lost-revenue.service.ts:959).
 *
 * V1 logic: SQL join lost_revenue_record × rental on same renter_info,
 * within 14-day window, where denial_type in ('unavailable','owner_denied',
 * 'timeout'). Build (requestedItem → actualItem) frequency map.
 *
 * V2 mapping: denial_records has NO `renter_id` (schema gap — TODO Wave 3).
 * We approximate by joining denial_records × reservations on time-window
 * only (same 14-day window). This gives "items rented near in time to a
 * denial", which is a weaker signal than V1's same-renter join, but the
 * only one available without a schema extension.
 *
 * Caveat surfaced to caller — see data layer.
 */
export const getSubstitutionPatterns = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days, limit }) => {
    const windowDays = days ?? 180;
    const cutoff = Date.now() - windowDays * 86400 * 1000;
    const take = limit ?? 20;

    let accountId: import("./_generated/dataModel").Id<"accounts"> | undefined;
    if (accountSlug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
        .first();
      accountId = acc?._id;
    }

    const denials = (await ctx.db.query("denial_records").collect()).filter((r) => {
      if (r.created_at < cutoff) return false;
      if (accountId && r.account_id !== accountId) return false;
      return !!r.item_name;
    });

    // Pull reservations in same window (use ISO YYYY-MM-DD cutoff).
    const cutoffIso = new Date(cutoff).toISOString().slice(0, 10);
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffIso))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    // Mirror V1: only consider completed/ongoing/upcoming rentals as substitutes.
    reservations = reservations.filter(
      (r) =>
        r.status === "confirmed" ||
        r.status === "completed" ||
        r.status === "ongoing" ||
        r.status === "upcoming",
    );

    // Build pair counts: (requested → substituted_with).
    const pairs = new Map<string, { requested: string; substitutedWith: string; count: number }>();
    for (const d of denials) {
      const reqName = d.item_name!;
      const reqKey = normItem(reqName);
      // Find reservations whose start_date is within ±14d of the denial.
      for (const res of reservations) {
        if (!res.start_date) continue;
        const resTs = Date.parse(res.start_date);
        if (Number.isNaN(resTs)) continue;
        if (Math.abs(resTs - d.created_at) > SUBSTITUTION_WINDOW_MS) continue;
        const items = res.items ?? [];
        for (const it of items) {
          const actName = it.item_name;
          if (!actName) continue;
          if (normItem(actName) === reqKey) continue; // same item ≠ substitution
          const key = `${reqKey}|||${normItem(actName)}`;
          const cur = pairs.get(key) ?? {
            requested: reqName,
            substitutedWith: actName,
            count: 0,
          };
          cur.count++;
          pairs.set(key, cur);
        }
      }
    }

    const out = Array.from(pairs.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, take);

    return {
      windowDays,
      substitutions: out,
      denialsConsidered: denials.length,
      reservationsConsidered: reservations.length,
    };
  },
});

/**
 * Port of V1 getPurchaseRecommendations (lost-revenue.service.ts:1171).
 *
 * V1 logic: cross-references getRevenuePotential() + getMarketingOnlyDemand()
 * + getTimeGapAnalysis() and emits three buckets (BUY NOW / EXPAND STOCK /
 * CONVERT MARKETING). The full V1 fan-out requires getRevenuePotential
 * (utilization, stock-blocking) which we do not yet have in Convex.
 *
 * V2 Wave 2.5 scope: implement the **BUY NOW** bucket — the highest-signal
 * piece. Cross-join unmatched demand × pricing_catalog (daily rate) × ROI
 * window to project annual revenue per item we don't own.
 *
 * projectedAnnualGbp = requestCount * dailyRate * AVG_RENTAL_DAYS * OWNER_SHARE
 *                    * (ROI_WINDOW_DAYS / windowDays)
 *   — i.e. extrapolate the observed request frequency over a year and convert
 *   gross rate to owner take-home (× 0.64).
 *
 * Recommendation tiers:
 *   - 'strong-buy'  : projectedAnnualGbp >= 500
 *   - 'consider'    : projectedAnnualGbp >= 150
 *   - 'monitor'     : everything else
 */
export const getPurchaseRecommendations = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days, limit }) => {
    const windowDays = days ?? 180;
    const cutoff = Date.now() - windowDays * 86400 * 1000;
    const take = limit ?? 10;

    let accountId: import("./_generated/dataModel").Id<"accounts"> | undefined;
    if (accountSlug) {
      const acc = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
        .first();
      accountId = acc?._id;
    }

    // 1) Aggregate unmatched demand (same logic as getUnmatchedDemand, inline).
    const denialRows = await ctx.db.query("denial_records").collect();
    const byItem = new Map<
      string,
      { displayName: string; requestCount: number; totalLostGbpEst: number }
    >();
    for (const r of denialRows) {
      if (r.created_at < cutoff) continue;
      if (accountId && r.account_id !== accountId) continue;
      if (!r.item_name) continue;
      const key = normItem(r.item_name);
      const cur = byItem.get(key) ?? {
        displayName: r.item_name,
        requestCount: 0,
        totalLostGbpEst: 0,
      };
      cur.requestCount++;
      if (typeof r.estimated_value === "number") cur.totalLostGbpEst += r.estimated_value;
      byItem.set(key, cur);
    }

    // 2) Filter to items NOT in current inventory (V1 BUY NOW: currentStock == 0).
    const items = await ctx.db.query("items").collect();
    const ownedKeys = new Set<string>();
    for (const it of items) {
      if (it.qty > 0 && !it.is_marketing_only && it.status === "active") {
        ownedKeys.add(normItem(it.name_canonical));
        if (it.aliases) for (const a of it.aliases) ownedKeys.add(normItem(a));
      }
    }

    // 3) Cross-join with pricing_catalog for daily rate.
    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const pricingByKey = new Map<string, { dailyRate: number }>();
    for (const p of pricingRows) {
      const rate = (p.daily_price_min + p.daily_price_max) / 2;
      pricingByKey.set(normItem(p.item_name_canonical), { dailyRate: rate });
    }

    const recs: Array<{
      itemName: string;
      requestCount: number;
      dailyRateGbp: number | null;
      avgRentalDays: number;
      projectedAnnualGbp: number;
      recommendation: "strong-buy" | "consider" | "monitor";
    }> = [];

    for (const [key, agg] of byItem) {
      if (agg.requestCount < 2) continue;
      if (ownedKeys.has(key)) continue;
      const pricing = pricingByKey.get(key);
      const dailyRate = pricing?.dailyRate ?? null;
      // If no pricing row, fall back to estimated_value / requestCount as a per-rental £ figure
      let projectedAnnualGbp = 0;
      if (dailyRate !== null) {
        const scaler = ROI_WINDOW_DAYS / windowDays;
        projectedAnnualGbp =
          agg.requestCount * dailyRate * ASSUMED_AVG_RENTAL_DAYS * OWNER_SHARE * scaler;
      } else if (agg.totalLostGbpEst > 0) {
        projectedAnnualGbp = agg.totalLostGbpEst * (ROI_WINDOW_DAYS / windowDays) * OWNER_SHARE;
      }
      projectedAnnualGbp = Math.round(projectedAnnualGbp);

      const recommendation: "strong-buy" | "consider" | "monitor" =
        projectedAnnualGbp >= 500 ? "strong-buy" : projectedAnnualGbp >= 150 ? "consider" : "monitor";

      recs.push({
        itemName: agg.displayName,
        requestCount: agg.requestCount,
        dailyRateGbp: dailyRate,
        avgRentalDays: ASSUMED_AVG_RENTAL_DAYS,
        projectedAnnualGbp,
        recommendation,
      });
    }

    recs.sort((a, b) => b.projectedAnnualGbp - a.projectedAnnualGbp);

    return {
      windowDays,
      ownerShare: OWNER_SHARE,
      assumedAvgRentalDays: ASSUMED_AVG_RENTAL_DAYS,
      recommendations: recs.slice(0, take),
      itemsConsidered: byItem.size,
      itemsAlreadyOwned: ownedKeys.size,
    };
  },
});
