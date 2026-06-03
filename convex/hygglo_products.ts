/**
 * convex/hygglo_products — the marketing-listings layer (Phase 3, ADDITIVE).
 *
 * Mutations + queries over the `hygglo_products` table: a read-only mirror of
 * the Hygglo catalog (GET /v2/my/products), synced by the `catalog-sync`
 * Trigger task. This layer is data-ingest ONLY — nothing here is wired into a
 * dashboard widget yet, and nothing here touches `items`, `bundles` or the
 * poll path.
 *
 *   - upsertProductsBatch : idempotent by (accountSlug, productId).
 *   - list                : read rows (optionally scoped to one account).
 *   - getByMasterItem     : read rows linked to a given master `items` row.
 *
 * Rows carry `masterItemId` when the catalog product fuzzy-matched a master
 * inventory row; otherwise `isMarketingOnly: true`.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Shared arg validators (mirror the schema field shapes) ────────────────

const priceArg = v.object({
  id: v.optional(v.number()),
  productId: v.optional(v.number()),
  pricePerDay: v.optional(v.number()),
  days: v.optional(v.number()),
  price: v.optional(v.number()),
});

const imageArg = v.object({
  id: v.optional(v.number()),
  thumbnailUrl: v.optional(v.string()),
  fullSizeUrl: v.optional(v.string()),
  filename: v.optional(v.string()),
  rotation: v.optional(v.number()),
  productId: v.optional(v.number()),
});

const listingArg = v.object({
  id: v.optional(v.number()),
  slug: v.optional(v.string()),
  productId: v.optional(v.number()),
  publicUrl: v.optional(v.string()),
  location: v.optional(v.any()),
});

const productArg = v.object({
  accountSlug: v.string(),
  productId: v.number(),
  name: v.optional(v.string()),
  isPublished: v.optional(v.boolean()),
  valuation: v.optional(v.number()),
  minimumRentalDays: v.optional(v.number()),
  prices: v.optional(v.array(priceArg)),
  images: v.optional(v.array(imageArg)),
  unavailableDates: v.optional(v.array(v.any())),
  listings: v.optional(v.array(listingArg)),
  publicUrl: v.optional(v.string()),
  masterItemId: v.optional(v.id("items")),
  isMarketingOnly: v.boolean(),
  matchScore: v.optional(v.number()),
});

// ── Mutations ─────────────────────────────────────────────────────────────

/**
 * Idempotent batch upsert keyed by (accountSlug, productId). Existing rows are
 * patched in place (preserving _id and _creationTime); new rows are inserted.
 * `lastSyncedAt` is stamped server-side so callers can't skew it. Returns
 * per-batch insert/update counts.
 *
 * Convex cost rule (CLAUDE.md): one mutation per sync run per chunk, not one
 * mutation per product. The catalog-sync task chunks at 50.
 */
export const upsertProductsBatch = mutation({
  args: { products: v.array(productArg) },
  handler: async (ctx, { products }): Promise<{ inserted: number; updated: number }> => {
    let inserted = 0;
    let updated = 0;
    const now = Date.now();

    for (const p of products) {
      const existing = await ctx.db
        .query("hygglo_products")
        .withIndex("by_account_product", (q) =>
          q.eq("accountSlug", p.accountSlug).eq("productId", p.productId),
        )
        .first();

      const row = {
        accountSlug: p.accountSlug,
        productId: p.productId,
        name: p.name,
        isPublished: p.isPublished,
        valuation: p.valuation,
        minimumRentalDays: p.minimumRentalDays,
        prices: p.prices,
        images: p.images,
        unavailableDates: p.unavailableDates,
        listings: p.listings,
        publicUrl: p.publicUrl,
        masterItemId: p.masterItemId,
        isMarketingOnly: p.isMarketingOnly,
        matchScore: p.matchScore,
        lastSyncedAt: now,
      };

      if (existing) {
        await ctx.db.patch(existing._id, row);
        updated++;
      } else {
        await ctx.db.insert("hygglo_products", row);
        inserted++;
      }
    }

    return { inserted, updated };
  },
});

// ── Queries ───────────────────────────────────────────────────────────────

/**
 * List marketing-listing rows. Optionally scope to a single account slug
 * (indexed). With no arg, returns every row (collect — the catalog is ~220
 * rows total, well within a single read).
 */
export const list = query({
  args: { accountSlug: v.optional(v.string()) },
  handler: async (ctx, { accountSlug }) => {
    if (accountSlug !== undefined) {
      return await ctx.db
        .query("hygglo_products")
        .withIndex("by_account", (q) => q.eq("accountSlug", accountSlug))
        .collect();
    }
    return await ctx.db.query("hygglo_products").collect();
  },
});

/**
 * Return all marketing-listing rows linked to a given master `items` row.
 * Indexed by masterItemId.
 */
export const getByMasterItem = query({
  args: { masterItemId: v.id("items") },
  handler: async (ctx, { masterItemId }) => {
    return await ctx.db
      .query("hygglo_products")
      .withIndex("by_master_item", (q) => q.eq("masterItemId", masterItemId))
      .collect();
  },
});
