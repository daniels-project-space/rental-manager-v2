/**
 * convex/ported_listings — "Ported Listings" feature (Phase 2, Wave 0, ADDITIVE).
 *
 * Surfaces dbcinema catalog products that are MISSING on the leo account and
 * tracks the state of porting each one's listing image into R2. Read-only over
 * `hygglo_products`; writes only to the additive `ported_listings` /
 * `ported_listings_config` tables. Nothing here touches the poll path, items,
 * bundles, or any existing behaviour.
 *
 *   - diff      : compute which dbcinema products are absent on leo.
 *   - list      : read all ported_listings rows (newest first).
 *   - upsert    : idempotent upsert of a ported_listings row by productId.
 *   - getConfig : read the per-account gradient/style profile doc.
 *   - setConfig : write the per-account gradient/style profile doc.
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Canonical comparison key for a product title: lowercase, trimmed,
 * collapsed whitespace, punctuation stripped. Used so that e.g.
 * "Canon EOS R5 (Body)" and "canon eos r5 body" compare equal.
 */
function normalizeName(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // strip punctuation
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

/** First usable image URL for a catalog product (full size preferred). */
function firstImageUrl(
  images:
    | Array<{ thumbnailUrl?: string; fullSizeUrl?: string }>
    | undefined,
): string {
  if (!images) return "";
  for (const img of images) {
    const url = img.fullSizeUrl ?? img.thumbnailUrl;
    if (url) return url;
  }
  return "";
}

/**
 * Compute dbcinema products that have no counterpart on leo.
 *
 * A dbcinema product is MISSING on leo iff:
 *   - its masterItemId (when present) is NOT in leo's masterItemId set, AND
 *   - its normalizedName is NOT in leo's normalized-name set.
 */
export const diff = query({
  args: {
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const from = args.from ?? "dbcinema";
    const to = args.to ?? "leo";

    const fromProducts = await ctx.db
      .query("hygglo_products")
      .withIndex("by_account", (q) => q.eq("accountSlug", from))
      .collect();
    const toProducts = await ctx.db
      .query("hygglo_products")
      .withIndex("by_account", (q) => q.eq("accountSlug", to))
      .collect();

    const toMasterIds = new Set<string>();
    const toNames = new Set<string>();
    for (const p of toProducts) {
      if (p.masterItemId) toMasterIds.add(String(p.masterItemId));
      const n = normalizeName(p.name);
      if (n) toNames.add(n);
    }

    const missing = [];
    for (const p of fromProducts) {
      const masterId = p.masterItemId ? String(p.masterItemId) : undefined;
      const matchedByMaster =
        masterId !== undefined && toMasterIds.has(masterId);
      const norm = normalizeName(p.name);
      const matchedByName = norm !== "" && toNames.has(norm);
      if (matchedByMaster || matchedByName) continue;
      missing.push({
        productId: String(p.productId),
        name: p.name ?? "",
        dbImageUrl: firstImageUrl(p.images),
        masterItemId: masterId,
      });
    }

    return {
      missing,
      counts: {
        dbTotal: fromProducts.length,
        leoTotal: toProducts.length,
        missingCount: missing.length,
      },
    };
  },
});

/** All ported_listings rows, newest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("ported_listings").collect();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Idempotent upsert of a ported_listings row, keyed by productId. */
export const upsert = mutation({
  args: {
    productId: v.string(),
    accountSlug: v.optional(v.string()),
    name: v.optional(v.string()),
    dbImageUrl: v.optional(v.string()),
    masterItemId: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("pending"), v.literal("ported"), v.literal("error")),
    ),
    portedR2Key: v.optional(v.string()),
    portedUrl: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("ported_listings")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .first();

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (args.accountSlug !== undefined) patch.accountSlug = args.accountSlug;
      if (args.name !== undefined) patch.name = args.name;
      if (args.dbImageUrl !== undefined) patch.dbImageUrl = args.dbImageUrl;
      if (args.masterItemId !== undefined)
        patch.masterItemId = args.masterItemId;
      if (args.status !== undefined) patch.status = args.status;
      if (args.portedR2Key !== undefined) patch.portedR2Key = args.portedR2Key;
      if (args.portedUrl !== undefined) patch.portedUrl = args.portedUrl;
      if (args.error !== undefined) patch.error = args.error;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("ported_listings", {
      productId: args.productId,
      accountSlug: args.accountSlug ?? "",
      name: args.name ?? "",
      dbImageUrl: args.dbImageUrl ?? "",
      masterItemId: args.masterItemId,
      status: args.status ?? "pending",
      portedR2Key: args.portedR2Key,
      portedUrl: args.portedUrl,
      error: args.error,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Read the per-account gradient/style profile doc (defaults to key "leo"). */
export const getConfig = query({
  args: { key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const key = args.key ?? "leo";
    return await ctx.db
      .query("ported_listings_config")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
  },
});

/** Upsert the per-account gradient/style profile doc (defaults to key "leo"). */
export const setConfig = mutation({
  args: {
    key: v.optional(v.string()),
    gradientProfile: v.any(),
    swatches: v.array(v.string()),
    orientation: v.optional(v.string()),
    leoSampleCount: v.optional(v.number()),
    detectedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const key = args.key ?? "leo";
    const existing = await ctx.db
      .query("ported_listings_config")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();

    const doc = {
      key,
      gradientProfile: args.gradientProfile,
      swatches: args.swatches,
      orientation: args.orientation,
      leoSampleCount: args.leoSampleCount,
      detectedAt: args.detectedAt ?? Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return await ctx.db.insert("ported_listings_config", doc);
  },
});
