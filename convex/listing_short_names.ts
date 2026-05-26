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

/**
 * Pass 14a (2026-05-26): mirror of the deterministic extractor from
 * listing_short_names_actions.ts. Moved here so the V8 runtime can run
 * the derivation inline inside a mutation instead of spawning a Node
 * action per item. Pure JS — no LLM, no I/O. Kept byte-identical to the
 * Node-side version so existing rows produce identical short_names.
 */
const MARKETING_FLUFF_RE: RegExp[] = [
  /\bportable\b/gi,
  /\bpremium\b/gi,
  /\bpro\s*quality\b/gi,
  /\bprofessional\b/gi,
  /\bfull\s+frame\b/gi,
  /\bfull-frame\b/gi,
  /\bmirrorless\b/gi,
  /\bcinema\s*camera\b/gi,
  /\bvideo\b/gi,
  /\bphotography\b/gi,
  /\bbluetooth\b/gi,
  /\b4k\d*p?\b/gi,
  /\b\d+mp\b/gi,
  /\bpair\b/gi,
  /\bset\b/gi,
  /\bbundle\b/gi,
  /\bkit\b/gi,
  /\blight\s+show\b/gi,
  /\brgb\b/gi,
  /\bbass\s+boost\b/gi,
  /\bweighs?\s+\d+(?:\.\d+)?\s*kg\b/gi,
  /\b\d+-section\b/gi,
];

function deriveShortName(rawTitle: string): string {
  if (!rawTitle) return "";
  let s = rawTitle;
  s = s.split("|")[0];
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.split("+")[0];
  for (const re of MARKETING_FLUFF_RE) s = s.replace(re, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 60) s = s.slice(0, 60).trimEnd();
  return s;
}

export { deriveShortName as _deriveShortName };

/** Look up cached short_name for a single (account, product).
 *
 *  Pass 14a (2026-05-26): kept as a compatibility shim for the legacy
 *  per-item action path (listing_short_names_actions.deriveOne). The new
 *  hot path is upsertShortNamesBatch which does its lookups inline in
 *  one mutation transaction instead of N action+query roundtrips. */
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

/**
 * Pass 14a (2026-05-26): batched derive + upsert. Replaces the per-item
 * `scheduleShortNameDerivation` → `deriveOne` action chain that was
 * costing ~216K function calls/day (~750 items × 288 polls/day).
 *
 * Each input tuple either hits the cache (raw_title_hash unchanged →
 * no write) or computes the deterministic short_name inline and patches
 * the row. ONE mutation per poll cycle vs ~750 actions. The deterministic
 * extractor is pure regex — runs in V8 runtime with zero LLM cost.
 *
 * Hash collision handling: cache hit when raw_title_hash matches.
 * Different raw_title => recompute (rare; only when Hygglo title shifts).
 */
export const upsertShortNamesBatch = internalMutation({
  args: {
    items: v.array(
      v.object({
        account_slug: v.string(),
        product_id: v.number(),
        raw_title: v.string(),
      }),
    ),
  },
  handler: async (ctx, { items }): Promise<{ checked: number; derived: number; cached: number }> => {
    if (items.length === 0) return { checked: 0, derived: 0, cached: 0 };

    let derived = 0;
    let cached = 0;
    const now = Date.now();
    // De-dupe within the batch first (the caller may send the same
    // product_id multiple times if it appears across orders in one poll).
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.account_slug}#${item.product_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const hash = await sha256Hex(item.raw_title);
      const existing = await ctx.db
        .query("listing_short_names")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", item.account_slug).eq("product_id", item.product_id),
        )
        .unique();
      if (existing && existing.raw_title_hash === hash) {
        cached++;
        continue;
      }
      const shortName = deriveShortName(item.raw_title) || item.raw_title.slice(0, 60).trim();
      if (existing) {
        await ctx.db.patch(existing._id, {
          raw_title: item.raw_title,
          raw_title_hash: hash,
          short_name: shortName,
          derivation_method: "deterministic",
          updated_at: now,
        });
      } else {
        await ctx.db.insert("listing_short_names", {
          account_slug: item.account_slug,
          product_id: item.product_id,
          raw_title: item.raw_title,
          raw_title_hash: hash,
          short_name: shortName,
          derivation_method: "deterministic",
          derived_at: now,
          updated_at: now,
        });
      }
      derived++;
    }
    return { checked: seen.size, derived, cached };
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
