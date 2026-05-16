/**
 * Data-access layer for the listing_resolver action.
 *
 * The listing_resolver itself runs in Node (`"use node"`) so it can call the
 * @ai-sdk/xai grok-4-fast model. Convex queries and mutations cannot live in
 * a "use node" file, so they live here in a regular Convex module.
 *
 * Tables touched:
 *   - listing_resolution (one row per Hygglo listing × account)
 *
 * Account scoping: every query/mutation filters by hygglo_account because v2
 * supports multiple Hygglo seller accounts (leo, dbcinema, …) where v1 was
 * single-account.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

/**
 * Tier 1 — Catalog lookup.
 *
 * Returns the previously resolved items for a listing if a resolution row
 * exists and its status is "resolved". Otherwise returns null and the caller
 * falls through to the next tier. Account-scoped: a leo resolution never
 * leaks to a dbcinema listing.
 */
export const lookupCatalog = internalQuery({
  args: {
    hygglo_listing_id: v.string(),
    hygglo_account: v.string(),
  },
  handler: async (ctx, { hygglo_listing_id, hygglo_account }) => {
    const row = await ctx.db
      .query("listing_resolution")
      .withIndex("by_listing_id", (q) => q.eq("hygglo_listing_id", hygglo_listing_id))
      .filter((q) => q.eq(q.field("hygglo_account"), hygglo_account))
      .first();
    if (!row) return null;
    if (row.status !== "resolved") return null;
    if (!row.resolved_items || row.resolved_items.length === 0) return null;
    return {
      _id: row._id,
      resolved_items: row.resolved_items,
    };
  },
});

/**
 * Upsert the resolution row for a Hygglo listing × account pair.
 *
 * Identity is the (hygglo_account, hygglo_listing_id) tuple. If a row already
 * exists we patch in place so reviewer fields and creation time are preserved.
 * Otherwise insert a new row.
 */
export const upsertListingResolution = internalMutation({
  args: {
    hygglo_listing_id: v.string(),
    hygglo_account: v.string(),
    hygglo_title: v.string(),
    hygglo_description: v.optional(v.string()),
    hygglo_detail_payload: v.optional(v.any()),
    resolved_items: v.array(
      v.object({
        item_name: v.string(),
        qty: v.number(),
        confidence: v.number(),
        source: v.union(
          v.literal("catalog"),
          v.literal("photo_ref"),
          v.literal("pattern"),
          v.literal("detail_api"),
          v.literal("ai"),
          v.literal("fuzzy"),
          v.literal("manual"),
        ),
      }),
    ),
    status: v.union(
      v.literal("resolved"),
      v.literal("pending_review"),
      v.literal("unresolved"),
    ),
    candidates: v.optional(
      v.array(
        v.object({
          item_name: v.string(),
          score: v.number(),
          reason: v.string(),
        }),
      ),
    ),
    image_url: v.optional(v.string()),
    attempted_tiers: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listing_resolution")
      .withIndex("by_listing_id", (q) => q.eq("hygglo_listing_id", args.hygglo_listing_id))
      .filter((q) => q.eq(q.field("hygglo_account"), args.hygglo_account))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        hygglo_title: args.hygglo_title,
        hygglo_description: args.hygglo_description,
        hygglo_detail_payload: args.hygglo_detail_payload,
        resolved_items: args.resolved_items,
        status: args.status,
        candidates: args.candidates,
        image_url: args.image_url ?? existing.image_url,
        attempted_tiers: args.attempted_tiers,
      });
      return existing._id;
    }

    return await ctx.db.insert("listing_resolution", {
      hygglo_listing_id: args.hygglo_listing_id,
      hygglo_account: args.hygglo_account,
      hygglo_title: args.hygglo_title,
      hygglo_description: args.hygglo_description,
      hygglo_detail_payload: args.hygglo_detail_payload,
      resolved_items: args.resolved_items,
      status: args.status,
      candidates: args.candidates,
      image_url: args.image_url,
      attempted_tiers: args.attempted_tiers,
    });
  },
});

/**
 * Mark a pending_review row as resolved with a human-chosen items list.
 * Used by the Daniel review queue UI (Tier 7 follow-up).
 */
export const markReviewed = internalMutation({
  args: {
    hygglo_listing_id: v.string(),
    hygglo_account: v.string(),
    resolved_items: v.array(
      v.object({
        item_name: v.string(),
        qty: v.number(),
        confidence: v.number(),
        source: v.union(
          v.literal("catalog"),
          v.literal("photo_ref"),
          v.literal("pattern"),
          v.literal("detail_api"),
          v.literal("ai"),
          v.literal("fuzzy"),
          v.literal("manual"),
        ),
      }),
    ),
    reviewed_by: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("listing_resolution")
      .withIndex("by_listing_id", (q) => q.eq("hygglo_listing_id", args.hygglo_listing_id))
      .filter((q) => q.eq(q.field("hygglo_account"), args.hygglo_account))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      resolved_items: args.resolved_items,
      status: "resolved",
      reviewed_at: Date.now(),
      reviewed_by: args.reviewed_by,
    });
    return row._id;
  },
});

/**
 * List all listings currently parked in the review queue for an account.
 * Powers the Daniel-facing review-queue widget.
 */
export const listPendingReview = internalQuery({
  args: {
    hygglo_account: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { hygglo_account, limit }) => {
    const cap = Math.min(Math.max(1, limit ?? 50), 200);
    const rows = await ctx.db
      .query("listing_resolution")
      .withIndex("by_account_status", (q) =>
        q.eq("hygglo_account", hygglo_account).eq("status", "pending_review"),
      )
      .take(cap);
    return rows.map((r) => ({
      _id: r._id,
      hygglo_listing_id: r.hygglo_listing_id,
      hygglo_title: r.hygglo_title,
      candidates: r.candidates ?? [],
      attempted_tiers: r.attempted_tiers,
    }));
  },
});
