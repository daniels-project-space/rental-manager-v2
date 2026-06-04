/**
 * convex/competitor_intel — competitor-intel persistence + read.
 *
 * Additive, PII-safe. The aggregated competitor sample (one row per distinct
 * item name, merged across the sampled vendors) is written wholesale by the
 * one-time ingest script via the `replaceAll` mutation, and read by the
 * dashboard widget via `getTopItems`.
 *
 * NEVER stores reviewer names or review text — only item/date/rating/price
 * aggregates (UK GDPR-safe, non-personal). See `src/hygglo-core/competitors.ts`
 * for the PII firewall at the fetch boundary.
 *
 * Not wired into the poll path; nothing here runs on a cron.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** One aggregated competitor item (input shape for `replaceAll`). */
const itemArg = v.object({
  itemName: v.string(),
  vendorIds: v.array(v.string()),
  rentalCount: v.number(),
  lastRentedAt: v.string(),
  avgRating: v.optional(v.number()),
  dailyPriceGbp: v.optional(v.number()),
  estRevenueGbp: v.number(),
});

/**
 * Clear + insert the full aggregated competitor-intel set, and write the
 * singleton meta row. Idempotent: every run replaces the previous sample.
 */
export const replaceAll = mutation({
  args: {
    items: v.array(itemArg),
    meta: v.object({
      reviewsSampled: v.number(),
      vendorsCount: v.number(),
      unmatchedPriceCount: v.number(),
    }),
  },
  returns: v.object({
    itemCount: v.number(),
    totalEstRevenueGbp: v.number(),
    totalRentalsSampled: v.number(),
    syncedAt: v.number(),
  }),
  handler: async (ctx, { items, meta }) => {
    const syncedAt = Date.now();

    // Clear previous rows (small table — one bounded sample).
    const existing = await ctx.db.query("competitor_intel").collect();
    for (const row of existing) await ctx.db.delete(row._id);

    let totalEstRevenueGbp = 0;
    let totalRentalsSampled = 0;
    for (const it of items) {
      totalEstRevenueGbp += it.estRevenueGbp;
      totalRentalsSampled += it.rentalCount;
      await ctx.db.insert("competitor_intel", { ...it, syncedAt });
    }

    // Upsert the singleton meta row (key="latest").
    const metaRows = await ctx.db.query("competitor_intel_meta").collect();
    for (const m of metaRows) await ctx.db.delete(m._id);
    await ctx.db.insert("competitor_intel_meta", {
      key: "latest",
      reviewsSampled: meta.reviewsSampled,
      vendorsCount: meta.vendorsCount,
      itemCount: items.length,
      totalEstRevenueGbp,
      totalRentalsSampled,
      unmatchedPriceCount: meta.unmatchedPriceCount,
      syncedAt,
    });

    return {
      itemCount: items.length,
      totalEstRevenueGbp,
      totalRentalsSampled,
      syncedAt,
    };
  },
});

/**
 * Read the competitor-intel sample, sorted by estimated revenue (desc), with
 * headline totals. `limit` caps the returned items (default 50). PII-safe.
 */
export const getTopItems = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("competitor_intel").collect();
    rows.sort((a, b) => {
      if (b.estRevenueGbp !== a.estRevenueGbp)
        return b.estRevenueGbp - a.estRevenueGbp;
      return b.rentalCount - a.rentalCount;
    });
    const capped = rows.slice(0, limit ?? 50);

    const metaRow = await ctx.db
      .query("competitor_intel_meta")
      .withIndex("by_key", (q) => q.eq("key", "latest"))
      .first();

    const items = capped.map((r) => ({
      itemName: r.itemName,
      vendorIds: r.vendorIds,
      rentalCount: r.rentalCount,
      lastRentedAt: r.lastRentedAt,
      avgRating: r.avgRating ?? null,
      dailyPriceGbp: r.dailyPriceGbp ?? null,
      estRevenueGbp: r.estRevenueGbp,
    }));

    return {
      items,
      totalEstRevenueGbp: metaRow?.totalEstRevenueGbp ?? 0,
      totalRentalsSampled: metaRow?.totalRentalsSampled ?? 0,
      itemCount: metaRow?.itemCount ?? rows.length,
      reviewsSampled: metaRow?.reviewsSampled ?? 0,
      vendorsCount: metaRow?.vendorsCount ?? 0,
      unmatchedPriceCount: metaRow?.unmatchedPriceCount ?? 0,
      syncedAt: metaRow?.syncedAt ?? null,
    };
  },
});
