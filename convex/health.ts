import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * W20 Health & Scanner - system health + data quality issues
 */
export const getHealthReport = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const settings = await ctx.db.query("settings").first();

    const issues: Array<{
      severity: "error" | "warning";
      type: string;
      description: string;
      entityId: string;
    }> = [];

    // --- Item scan ---
    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // Hoisted listing_photos load: previously fetched inside the per-item loop
    // (N×M reads). One collect + Set lookup is O(rows + items).
    const allPhotos = await ctx.db.query("listing_photos").collect();
    const photoNames = new Set<string>();
    for (const p of allPhotos) {
      for (const it of p.items ?? []) photoNames.add(it.item_name);
    }

    for (const item of activeItems) {
      // No pricing entry
      const priceRow = await ctx.db
        .query("pricing_catalog")
        .withIndex("by_name", (q) => q.eq("item_name_canonical", item.name_canonical))
        .first();
      if (!priceRow) {
        issues.push({
          severity: "warning",
          type: "missing_pricing",
          description: `No pricing entry for "${item.name_canonical}"`,
          entityId: item._id,
        });
      }
      if (!photoNames.has(item.name_canonical)) {
        issues.push({
          severity: "warning",
          type: "missing_photo",
          description: `No listing photo for "${item.name_canonical}"`,
          entityId: item._id,
        });
      }
    }

    // --- Reservation scan ---
    // Health checks only care about recent confirmed bookings — older rows
    // are immutable history. 365-day cutoff drops ~1500 → ~250 reads.
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    for (const r of reservations.filter((r) => r.status === "confirmed")) {
      if (!r.renter_id) {
        issues.push({
          severity: "warning",
          type: "missing_renter",
          description: `Reservation ${r._id} has no renter link`,
          entityId: r._id,
        });
      }
      if (!r.end_date) {
        issues.push({
          severity: "error",
          type: "missing_end_date",
          description: `Confirmed reservation ${r._id} has no end date`,
          entityId: r._id,
        });
      }
    }

    return {
      syncStatus: settings?.ALLOW_HYGGLO_SEND ? "live" : "read_only",
      readOnlyMode: settings?.read_only_mode ?? true,
      pollingIntervalMs: settings?.polling_interval_ms ?? null,
      issues,
    };
  },
});
