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
    for (const item of allItems.filter((i) => i.status === "active" && !i.is_marketing_only)) {
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

      // No listing photos
      const photo = await ctx.db
        .query("listing_photos")
        .collect()
        .then((rows) =>
          rows.find((p) =>
            p.items.some((i) => i.item_name === item.name_canonical)
          )
        );
      if (!photo) {
        issues.push({
          severity: "warning",
          type: "missing_photo",
          description: `No listing photo for "${item.name_canonical}"`,
          entityId: item._id,
        });
      }
    }

    // --- Reservation scan ---
    let reservations = await ctx.db.query("reservations").collect();
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
