import { resolvedMarketingOnly } from "./lib/power_listing_identity";
import { createBundleMappingContext } from "./lib/bundle_mapping";
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

import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import { action, mutation, query, internalAction, internalMutation, internalQuery, internalQueryOf, requireOwner } from "./owner_functions";
import { v } from "convex/values";
import { resolveListingComponents } from "./lib/listing_inventory";

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
  description: v.optional(v.string()),
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
        // A failed detail read must not erase the last verified contents.
        // An explicitly empty provider description does clear older text.
        ...(p.description !== undefined ? {description:p.description,descriptionSyncedAt:now} : {}),
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
        // Keep a manual choice stable when the Hygglo catalogue refreshes.
        isMarketingOnlyOverride: existing?.isMarketingOnlyOverride,
        marketingOnlyUpdatedAt: existing?.marketingOnlyUpdatedAt,
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

/** Privileged read used only after storefront service authentication. */
export const __service_listForStorefront = internalQueryOf(list);

/** One source snapshot for catalogue identity, declared kit coverage and exact
 * physical pools. A fuzzy primary match alone never certifies a complete kit. */
export const __service_catalogueForStorefront = internalQuery({
  args: { accountSlug: v.literal("dbcinema") },
  handler: async (ctx, { accountSlug }) => {
    const [products, inventory, overrides, listings] = await Promise.all([
      ctx.db.query("hygglo_products").withIndex("by_account", q => q.eq("accountSlug", accountSlug)).collect(),
      ctx.db.query("items").collect(),
      ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", accountSlug)).collect(),
      ctx.db.query("online_listings").withIndex("by_account_product", q => q.eq("account_slug", accountSlug)).collect(),
    ]);
    // Preserve the same first indexed row selected by loadListingInventory.
    const mapping = new Map<number, typeof overrides[number]>();
    const descriptions = new Map<number, typeof listings[number]>();
    for (const row of overrides) if (!mapping.has(row.product_id)) mapping.set(row.product_id, row);
    for (const row of listings) if (!descriptions.has(row.product_id)) descriptions.set(row.product_id, row);
    const byId = new Map(inventory.map(i => [String(i._id), i]));
    const context=createBundleMappingContext(inventory);
    return await Promise.all(products.map(async product => {
      const resolved = resolveListingComponents(inventory,
        mapping.get(product.productId)?.components.map(c => ({item_id:String(c.item_id),qty:c.qty})),
        product.masterItemId ? String(product.masterItemId) : undefined, 1,
        product.description ?? descriptions.get(product.productId)?.description,context,product.name);
      const components = resolved.components.filter(c => c.stock_required && byId.has(c.item_id)).map(c => {
        const item = byId.get(c.item_id)!;
        const active = item.status === "active" && item.is_marketing_only === false;
        const quantityOwned = active && Number.isSafeInteger(item.qty) && item.qty >= 0 ? item.qty : 0;
        const value = item.replacement_cost_gbp;
        return { masterItemId:c.item_id, name:item.name_canonical, qty:c.units_per_listing,
          quantityOwned, active, replacementCost:typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0 };
      });
      const classifiedMarketing=resolvedMarketingOnly(product,resolved,inventory);
      const complete = resolved.complete && components.length > 0 && components.every(c => Number.isSafeInteger(c.qty) && c.qty > 0);
      // Match the public bridge projection here, before serializing rich private descriptions.
      const {productId,name,isPublished,isMarketingOnly,valuation,minimumRentalDays,prices,images,unavailableDates,listings,masterItemId}=product;
      // Copy identity follows actual seller wording, not repaired stock links.
      // Only the digest crosses the service bridge; descriptions stay private.
      const sourceDescription=product.description??descriptions.get(product.productId)?.description??null;
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([1,accountSlug,productId,name??"",sourceDescription])));
      const copySourceFingerprint="v1:"+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
      return {
        productId,name,isPublished,copySourceFingerprint,
        isMarketingOnly:classifiedMarketing,
        marketingOnlyMode:product.isMarketingOnlyOverride === undefined ? "automatic" as const : "manual" as const,
        marketingOnlyUpdatedAt:product.marketingOnlyUpdatedAt ?? 0,
        valuation,minimumRentalDays,prices,images,unavailableDates,listings,masterItemId,
        stockMapping:{version:1,complete,owned:classifiedMarketing?false:resolved.owned,components} };
    }));
  },
});

const marketingChange = v.object({
  productId: v.number(),
  marketingOnly: v.union(v.boolean(), v.null()),
  expectedUpdatedAt: v.optional(v.number()),
});

/** Owner-only, paginated view of every imported DB Cinema listing. */
export const adminMarketingListings = query({
  args: {
    accountSlug: v.literal("dbcinema"),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, { accountSlug, paginationOpts, search }) => {
    await requireOwner(ctx, true);
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 50) {
      throw new Error("Listing pages are limited to 50 rows.");
    }
    const text = search?.trim();
    const page = text
      ? await ctx.db.query("hygglo_products")
          .withSearchIndex("search_name", (q) => q.search("name", text).eq("accountSlug", accountSlug))
          .paginate(paginationOpts)
      : await ctx.db.query("hygglo_products")
          .withIndex("by_account", (q) => q.eq("accountSlug", accountSlug))
          .order("desc")
          .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.map((product) => ({
        productId: product.productId,
        name: product.name ?? `Hygglo listing ${product.productId}`,
        isPublished: product.isPublished ?? false,
        marketingOnly: product.isMarketingOnlyOverride ?? product.isMarketingOnly,
        source: product.isMarketingOnlyOverride === undefined ? "automatic" as const : "manual" as const,
        updatedAt: product.marketingOnlyUpdatedAt ?? 0,
        masterItemId: product.masterItemId ? String(product.masterItemId) : null,
        matchScore: product.matchScore ?? null,
        image: product.images?.find((entry) => entry.fullSizeUrl || entry.thumbnailUrl)?.fullSizeUrl
          ?? product.images?.find((entry) => entry.thumbnailUrl)?.thumbnailUrl ?? null,
        publicUrl: product.publicUrl ?? product.listings?.find((entry) => entry.publicUrl)?.publicUrl ?? null,
      })),
    };
  },
});

/** Atomic, conflict-checked edit of per-listing marketing-only tags. */
export const __saveMarketingOverrides = internalMutation({
  args: {
    accountSlug: v.literal("dbcinema"),
    changes: v.array(marketingChange),
  },
  handler: async (ctx, { accountSlug, changes }) => {
    if (changes.length > 50 || new Set(changes.map((change) => change.productId)).size !== changes.length) {
      throw new Error("Save up to 50 distinct listings at a time.");
    }
    const rows = await Promise.all(changes.map(async (change) => {
      if (!Number.isSafeInteger(change.productId) || change.productId < 1) throw new Error("Invalid listing ID.");
      const product = await ctx.db.query("hygglo_products")
        .withIndex("by_account_product", (q) => q.eq("accountSlug", accountSlug).eq("productId", change.productId))
        .first();
      if (!product) throw new Error(`Listing ${change.productId} is no longer in the imported catalogue.`);
      if ((product.marketingOnlyUpdatedAt ?? 0) !== (change.expectedUpdatedAt ?? 0)) {
        throw new Error("A listing tag changed in another session. Refresh the page and review it again.");
      }
      return { product, change };
    }));
    const at = rows.reduce((value, row) => Math.max(value, (row.product.marketingOnlyUpdatedAt ?? 0) + 1), Date.now());
    for (const { product, change } of rows) {
      await ctx.db.patch(product._id, {
        isMarketingOnlyOverride: change.marketingOnly === null ? undefined : change.marketingOnly,
        marketingOnlyUpdatedAt: at,
      });
    }
    // Existing caches must not retain an Available badge after an operator changes a tag.
    if(rows.length)for(const account of ["all","all:pending"]){
      const cache=await ctx.db.query("mv_reply_queue").withIndex("by_account",q=>q.eq("account",account)).first();
      if(cache)await ctx.db.delete(cache._id);
    }
    return rows.map(({ product, change }) => ({
      productId: product.productId,
      marketingOnly: change.marketingOnly ?? product.isMarketingOnly,
      mode: change.marketingOnly === null ? "automatic" as const : "manual" as const,
      updatedAt: at,
    }));
  },
});

/** Pushes a saved owner change to the customer site's reactive listing records. */
export const __pushMarketingOverrides = internalAction({
  args: { changes: v.array(v.object({ productId: v.number(), marketingOnly: v.boolean(), mode: v.union(v.literal("automatic"), v.literal("manual")), updatedAt: v.number() })) },
  handler: async (_ctx, { changes }) => {
    if (!changes.length) return { updated: 0, missing: 0 };
    const secret = process.env.DBCINEMA_WEBHOOK_SECRET;
    const endpoint = process.env.DBCINEMA_MARKETING_SYNC_URL;
    if (!secret || !endpoint) throw new Error("Live DB Cinema tag sync is not configured.");
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error("Live DB Cinema tag sync URL is invalid."); }
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.convex\.site$/.test(url.hostname) ||
        url.username || url.password || url.port || url.search || url.hash ||
        url.pathname !== "/dbcinema/manager-marketing-tags") {
      throw new Error("Live DB Cinema tag sync URL is invalid.");
    }
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: { "content-type": "application/json", "x-dbcinema-sync-token": secret },
      body: JSON.stringify({ protocolVersion: 1, changes }),
    });
    if (!response.ok) throw new Error(`Live DB Cinema tag sync failed (HTTP ${response.status}).`);
    const receipt = await response.json() as { protocolVersion?: number; acknowledged?: number; missing?: number; stale?: number };
    if (receipt.protocolVersion !== 1 || receipt.acknowledged !== changes.length ||
        receipt.missing !== 0 || receipt.stale !== 0) {
      throw new Error("Live DB Cinema tag sync returned an incomplete receipt.");
    }
    return { updated: receipt.acknowledged, missing: receipt.missing };
  },
});

/** Save locally first, then wait for the customer site to confirm its update. */
export const adminSaveMarketingTags = action({
  args: { changes: v.array(marketingChange) },
  handler: async (ctx, { changes }): Promise<
    { saved: number; storefrontSynced: true; storefrontUpdated: number } |
    { saved: number; storefrontSynced: false; message: string }
  > => {
    await requireOwner(ctx, true);
    const saved: Array<{ productId: number; marketingOnly: boolean; mode: "automatic" | "manual"; updatedAt: number }> = await ctx.runMutation(internal.hygglo_products.__saveMarketingOverrides, {
      accountSlug: "dbcinema",
      changes,
    });
    try {
      const receipt: { updated: number; missing: number } = await ctx.runAction(internal.hygglo_products.__pushMarketingOverrides, {
        changes: saved,
      });
      return { saved: saved.length, storefrontSynced: true, storefrontUpdated: receipt.updated };
    } catch (error) {
      return {
        saved: saved.length,
        storefrontSynced: false,
        message: error instanceof Error ? error.message : "The website did not confirm the tag update.",
      };
    }
  },
});
