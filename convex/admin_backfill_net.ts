/**
 * Admin backfill: corrects net_to_owner_gbp on reservations that were
 * imported from V1's `rental` table (one price per rental) but should have
 * been sourced from V1's `booking` table (sum of per-item line nets).
 *
 * Called by scripts/historical/backfill-net-from-v1-bookings.mjs.
 *
 * Safety: only PATCHES net_to_owner_gbp and gross_paid_gbp; never deletes
 * rows. For rentals V2 is missing entirely, use `insertFromV1` to seed.
 */
import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const patchNetByV1RentalId = mutation({
  args: {
    v1_rental_id: v.string(),
    correct_net_to_owner_gbp: v.number(),
    correct_gross_paid_gbp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("reservations")
      .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", args.v1_rental_id))
      .first();
    if (!row) return { action: "not_found" as const };
    const oldNet = row.net_to_owner_gbp ?? 0;
    const newNet = args.correct_net_to_owner_gbp;
    if (Math.abs(oldNet - newNet) < 0.005) {
      return { action: "unchanged" as const, oldNet, newNet: oldNet };
    }
    // SAFETY: only ever increase net. The Hygglo poller writes the final payout
    // amount which can be higher than V1's per-line sum (currency conversion,
    // fees adjusted post-completion). Never reduce — that destroys real revenue.
    if (newNet < oldNet) {
      return { action: "refused_would_reduce" as const, oldNet, newNet };
    }
    await ctx.db.patch(row._id, {
      net_to_owner_gbp: newNet,
      ...(args.correct_gross_paid_gbp !== undefined &&
        args.correct_gross_paid_gbp > (row.gross_paid_gbp ?? 0) && {
          gross_paid_gbp: args.correct_gross_paid_gbp,
        }),
    });
    return {
      action: "patched" as const,
      oldNet,
      newNet: args.correct_net_to_owner_gbp,
      delta: args.correct_net_to_owner_gbp - oldNet,
    };
  },
});

export const insertMissingFromV1 = mutation({
  args: {
    v1_rental_id: v.string(),
    hygglo_order_id: v.optional(v.string()),
    account_slug: v.string(),
    start_date: v.string(),  // "YYYY-MM-DD"
    end_date: v.string(),    // "YYYY-MM-DD"
    pickup_date: v.optional(v.string()),
    net_to_owner_gbp: v.number(),
    gross_paid_gbp: v.optional(v.number()),
    item_names: v.array(v.string()),
    renter_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Refuse if already present (idempotent).
    const existing = await ctx.db
      .query("reservations")
      .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", args.v1_rental_id))
      .first();
    if (existing) return { action: "already_exists" as const, id: existing._id };

    const id = await ctx.db.insert("reservations", {
      account_slug: args.account_slug,
      v1_rental_id: args.v1_rental_id,
      hygglo_order_id: args.hygglo_order_id,
      start_date: args.start_date,
      end_date: args.end_date,
      pickup_date: args.pickup_date ?? args.start_date,
      net_to_owner_gbp: args.net_to_owner_gbp,
      gross_paid_gbp: args.gross_paid_gbp,
      currency: "GBP",
      status: "completed",
      booking_status: "REVIEWED",
      order_step: "REVIEWED",
      is_obsolete: false,
      items: args.item_names.map((name) => ({ item_name: name })),
      renter_name: args.renter_name,
      created_at: Date.now(),
    });
    return { action: "inserted" as const, id };
  },
});
