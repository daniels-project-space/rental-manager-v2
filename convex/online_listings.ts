/**
 * Online-listings cache (2026-07-03) — the searchable inventory behind the
 * Reply-Inbox "Add items" picker.
 *
 * A slim, purpose-built mirror of each account's LIVE Hygglo listings (product
 * id + name + image + day price + published state). Populated by the "Rescan
 * listings" button in Settings (convex/online_listings_actions.rescan). Kept
 * deliberately separate from the daily `hygglo_products` catalog cache so this
 * feature stays additive and never touches the poll / catalog-sync path.
 *
 * Queries + the upsert mutation live here (V8 runtime); the rescan ACTION (which
 * calls Hygglo) lives in online_listings_actions.ts ("use node").
 */
import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/** All cached listings for one account, newest-name-first is not important —
 *  the picker sorts/filters client-side. Published-only by default. */
export const list = query({
  args: {
    account_slug: v.string(),
    include_unpublished: v.optional(v.boolean()),
  },
  handler: async (ctx, { account_slug, include_unpublished }) => {
    const rows = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const filtered = include_unpublished
      ? rows
      : rows.filter((r) => r.is_published);
    return filtered
      .map((r) => ({
        product_id: r.product_id,
        name: r.name,
        image: r.image ?? null,
        daily_price: r.daily_price ?? null,
        is_published: r.is_published,
        public_url: r.public_url ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Real listing facts (price + description) for a set of product ids in one
 *  account — feeds the draft's authoritative FACTS. */
export const factsForProducts = query({
  args: { account_slug: v.string(), product_ids: v.array(v.number()) },
  handler: async (ctx, { account_slug, product_ids }) => {
    const out: Array<{
      product_id: number;
      name: string;
      daily_price: number | null;
      description: string | null;
    }> = [];
    for (const pid of product_ids.slice(0, 6)) {
      const row = await ctx.db
        .query("online_listings")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", account_slug).eq("product_id", pid),
        )
        .unique();
      if (row)
        out.push({
          product_id: pid,
          name: row.name,
          daily_price: row.daily_price ?? null,
          description: row.description ?? null,
        });
    }
    return out;
  },
});

/** Lazily backfill a listing's real description (fetched from the detail
 *  endpoint by the draft path — the rescan list endpoint omits it). */
export const setDescription = internalMutation({
  args: { account_slug: v.string(), product_id: v.number(), description: v.string() },
  handler: async (ctx, { account_slug, product_id, description }) => {
    const row = await ctx.db
      .query("online_listings")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    if (row) await ctx.db.patch(row._id, { description: description.slice(0, 600) });
    return { ok: !!row };
  },
});

/** Last-rescan metadata per account (for the Settings button caption). */
export const syncMeta = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("online_listings_sync").collect();
    return rows.map((r) => ({
      account_slug: r.account_slug,
      last_rescan_at: r.last_rescan_at,
      count: r.count,
    }));
  },
});

/**
 * Replace the cached listing set for one account (delete-then-insert so
 * listings removed on Hygglo drop out too). Called only by the rescan action.
 */
export const replaceForAccount = internalMutation({
  args: {
    account_slug: v.string(),
    listings: v.array(
      v.object({
        product_id: v.number(),
        name: v.string(),
        image: v.optional(v.string()),
        daily_price: v.optional(v.number()),
        is_published: v.boolean(),
        public_url: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { account_slug, listings }) => {
    const existing = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    const now = Date.now();
    for (const l of listings) {
      await ctx.db.insert("online_listings", {
        account_slug,
        product_id: l.product_id,
        name: l.name,
        image: l.image,
        daily_price: l.daily_price,
        is_published: l.is_published,
        public_url: l.public_url,
        description: l.description,
        updated_at: now,
      });
    }
    // Upsert the per-account sync marker.
    const meta = await ctx.db
      .query("online_listings_sync")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .unique();
    if (meta) await ctx.db.patch(meta._id, { last_rescan_at: now, count: listings.length });
    else
      await ctx.db.insert("online_listings_sync", {
        account_slug,
        last_rescan_at: now,
        count: listings.length,
      });
    return { stored: listings.length };
  },
});
