/**
 * Listing short-name derivation (2026-05-23).
 *
 * Hygglo per-item names embedded in `reservations.hygglo_items[i].name`
 * are SEO-stuffed paragraphs ("2x JBL PartyBox Club 120 Speakers |
 * Portable Bluetooth Party Speaker Pair + Bass Boost + ..."). This
 * module derives a short canonical form ("2x JBL Club 120 Speakers")
 * via DeepSeek-v4-flash and caches it per (account_slug, product_id).
 *
 * Layout:
 *   - V8 runtime: cache reads/writes (queries + mutations).
 *   - listing_short_names_actions.ts ("use node"): LLM call + backfill.
 *
 * Splitting keeps the dashboard query path free of "use node" imports.
 */

import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// SHA-256 hex helper (Convex V8 runtime exposes globalThis.crypto.subtle).
async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { sha256Hex as _sha256Hex };

/** Look up cached short_name for a single (account, product). */
export const get = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    return await ctx.db
      .query("listing_short_names")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
  },
});

/** Bulk lookup used by dashboard query. Returns Map JSON {key: short_name}.
 *  key format: `${account_slug}#${product_id}`. */
export const lookupBulk = query({
  args: {
    keys: v.array(
      v.object({
        account_slug: v.string(),
        product_id: v.number(),
      }),
    ),
  },
  handler: async (ctx, { keys }) => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const row = await ctx.db
        .query("listing_short_names")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", k.account_slug).eq("product_id", k.product_id),
        )
        .unique();
      if (row) out[`${k.account_slug}#${k.product_id}`] = row.short_name;
    }
    return out;
  },
});

/** Upsert a derivation result. Called from the Node-side action after the
 *  LLM has returned. */
export const upsert = internalMutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    raw_title: v.string(),
    raw_title_hash: v.string(),
    short_name: v.string(),
    derivation_method: v.string(),
  },
  handler: async (
    ctx,
    { account_slug, product_id, raw_title, raw_title_hash, short_name, derivation_method },
  ) => {
    const existing = await ctx.db
      .query("listing_short_names")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        raw_title,
        raw_title_hash,
        short_name,
        derivation_method,
        updated_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("listing_short_names", {
      account_slug,
      product_id,
      raw_title,
      raw_title_hash,
      short_name,
      derivation_method,
      derived_at: now,
      updated_at: now,
    });
  },
});

/** Distinct (account_slug, product_id, raw_title) tuples found in currently
 *  active reservations. Used by the backfill action to know which listings
 *  need a short_name. Only confirmed/pending bookings whose end_date is in
 *  the future (or today) qualify - "active" in the user-facing sense. */
export const listActiveDistinctProducts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    // Index range from today onward - bounded read.
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", "2024-01-01"))
      .collect();
    type Tup = { account_slug: string; product_id: number; raw_title: string };
    const seen = new Map<string, Tup>();
    for (const r of rows) {
      const status = r.status;
      if (status !== "confirmed" && status !== "pending_review") continue;
      const endDate = (r as any).return_date ?? r.end_date;
      if (!endDate || endDate < today) continue;
      const slug = r.account_slug;
      const items = (r as any).hygglo_items as
        | Array<{ name?: string; product_id?: number; type?: string }>
        | undefined;
      if (!slug || !Array.isArray(items)) continue;
      for (const it of items) {
        if (!it || it.type === "INSURANCE") continue;
        if (typeof it.product_id !== "number") continue;
        if (!it.name) continue;
        const key = `${slug}#${it.product_id}`;
        if (!seen.has(key)) {
          seen.set(key, { account_slug: slug, product_id: it.product_id, raw_title: it.name });
        }
      }
    }
    return Array.from(seen.values());
  },
});

/** Existing cache rows keyed by `${account_slug}#${product_id}` so the
 *  backfill action can decide which need (re-)derivation. */
export const getAllCached = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("listing_short_names").collect();
    return all.map((r) => ({
      account_slug: r.account_slug,
      product_id: r.product_id,
      raw_title_hash: r.raw_title_hash,
      short_name: r.short_name,
    }));
  },
});

/** Public-ish helper for manual overrides (admin use). */
export const setManualShortName = mutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    short_name: v.string(),
    raw_title: v.optional(v.string()),
  },
  handler: async (ctx, { account_slug, product_id, short_name, raw_title }) => {
    const existing = await ctx.db
      .query("listing_short_names")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    const now = Date.now();
    const title = raw_title ?? existing?.raw_title ?? "";
    const hash = await sha256Hex(title);
    if (existing) {
      await ctx.db.patch(existing._id, {
        short_name,
        derivation_method: "manual",
        raw_title: title,
        raw_title_hash: hash,
        updated_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("listing_short_names", {
      account_slug,
      product_id,
      raw_title: title,
      raw_title_hash: hash,
      short_name,
      derivation_method: "manual",
      derived_at: now,
      updated_at: now,
    });
  },
});
