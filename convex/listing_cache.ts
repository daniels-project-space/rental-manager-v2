/**
 * Listing-resolution cache + brand-integrity gate.
 *
 * The cache is keyed by a deterministic hash of the reservation's items[]
 * titles. Two reservations referencing the same Hygglo listing share the
 * same hash, so we only pay for the LLM call on the first one.
 *
 * Used by item_resolver.resolveReservation (text path) — check cache first.
 *
 * Brand integrity gate (KNOWN_BRANDS) rejects cross-brand AI matches —
 * if the title primary brand is Canon and a resolved item is "Sony GM
 * 24-70", strip it.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation, mutation, query } from "./_generated/server";

/** Stable hash for a sorted, normalised list of item-name strings.
 *  Convex actions+queries+mutations all need the same fn — kept inline so
 *  no shared import dance. */
export function titleHash(items: Array<{ item_name: string }>): string {
  const norm = items
    .map((i) => i.item_name.toLowerCase().replace(/\s+/g, " ").trim())
    .sort()
    .join("|");
  // Cheap synchronous hash (FNV-1a 32-bit, 8-hex). Collision risk negligible
  // at our scale; we tag sample_title so admin can disambiguate visually.
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0") + "_" + norm.length;
}

// ─── Brand integrity gate ────────────────────────────────────────────
// Brands recognised by the gate. Order matters for the longest-token-first
// strategy below — multi-word brands first.
export const KNOWN_BRANDS: Array<{ token: string; canonical: string }> = [
  { token: "blackmagic", canonical: "Blackmagic" },
  { token: "bmpcc", canonical: "Blackmagic" },
  { token: "smallrig", canonical: "SmallRig" },
  { token: "hollyland", canonical: "Hollyland" },
  { token: "viewsonic", canonical: "ViewSonic" },
  { token: "manfrotto", canonical: "Manfrotto" },
  { token: "atomos", canonical: "Atomos" },
  { token: "sennheiser", canonical: "Sennheiser" },
  { token: "yongnuo", canonical: "Yongnuo" },
  { token: "nanlite", canonical: "Nanlite" },
  { token: "aputure", canonical: "Aputure" },
  { token: "godox", canonical: "Godox" },
  { token: "anker", canonical: "Anker" },
  { token: "ecoflow", canonical: "EcoFlow" },
  { token: "jackery", canonical: "Jackery" },
  { token: "blazar", canonical: "Blazar" },
  { token: "zhiyun", canonical: "Zhiyun" },
  { token: "tilta", canonical: "Tilta" },
  { token: "pioneer", canonical: "Pioneer" },
  { token: "rode", canonical: "Rode" },
  { token: "jbl", canonical: "JBL" },
  { token: "mackie", canonical: "Mackie" },
  { token: "sony", canonical: "Sony" },
  { token: "canon", canonical: "Canon" },
  { token: "nikon", canonical: "Nikon" },
  { token: "panasonic", canonical: "Panasonic" },
  { token: "fujifilm", canonical: "Fujifilm" },
  { token: "fuji", canonical: "Fujifilm" },
  { token: "dji", canonical: "DJI" },
  { token: "gvm", canonical: "GVM" },
];

/** Extract every recognisable brand from a string. */
export function brandsIn(text: string): Set<string> {
  const lc = text.toLowerCase();
  const found = new Set<string>();
  for (const b of KNOWN_BRANDS) {
    // word-boundary match (handles "Sony" but not "sonys" / "sonyc")
    const re = new RegExp("\\b" + b.token + "\\b", "i");
    if (re.test(lc)) found.add(b.canonical);
  }
  return found;
}

/** Pick the primary brand for a title — the leftmost recognised brand
 *  in the original casing, falling back to the first found. */
export function primaryBrand(title: string): string | null {
  const lc = title.toLowerCase();
  let bestIdx = Infinity;
  let best: string | null = null;
  for (const b of KNOWN_BRANDS) {
    const i = lc.search(new RegExp("\\b" + b.token + "\\b", "i"));
    if (i >= 0 && i < bestIdx) {
      bestIdx = i;
      best = b.canonical;
    }
  }
  return best;
}

/** Returns true if itemName carries a different brand than primaryBrand. */
export function brandMismatch(primary: string, itemName: string): boolean {
  if (!primary) return false;
  const itemBrands = brandsIn(itemName);
  if (itemBrands.size === 0) return false;
  if (itemBrands.has(primary)) return false;
  // Item has explicit brand(s) and none match the title's primary → reject.
  return true;
}

// ─── Cache reads / writes ────────────────────────────────────────────

export const lookupByHash = internalQuery({
  args: { title_hash: v.string() },
  handler: async (ctx, { title_hash }) => {
    const row = await ctx.db
      .query("listing_resolutions")
      .withIndex("by_title_hash", (q) => q.eq("title_hash", title_hash))
      .first();
    if (!row) return null;
    return {
      title_hash: row.title_hash,
      resolved_items: row.resolved_items,
      expanded_items: row.expanded_items,
      resolution_method: row.resolution_method,
      hit_count: row.hit_count,
    };
  },
});

/** Phase 15.1: primary cache lookup keyed by (account_slug, hygglo_listing_id).
 *  Survives Hygglo title edits (which used to invalidate title_hash entries). */
export const lookupByListing = internalQuery({
  args: {
    account_slug: v.string(),
    hygglo_listing_id: v.string(),
  },
  handler: async (ctx, { account_slug, hygglo_listing_id }) => {
    const row = await ctx.db
      .query("listing_resolutions")
      .withIndex("by_account_listing", (q) =>
        q.eq("account_slug", account_slug).eq("hygglo_listing_id", hygglo_listing_id),
      )
      .first();
    if (!row) return null;
    return {
      title_hash: row.title_hash,
      resolved_items: row.resolved_items,
      expanded_items: row.expanded_items,
      resolution_method: row.resolution_method,
      hit_count: row.hit_count,
    };
  },
});

/** Phase 15.1: public listing-id cache lookup for the Trigger.dev task.
 *  Modelled as a mutation because we bump hit_count to surface real reuse. */
export const adminLookupByListing = mutation({
  args: { account_slug: v.string(), hygglo_listing_id: v.string() },
  handler: async (ctx, { account_slug, hygglo_listing_id }) => {
    const row = await ctx.db
      .query("listing_resolutions")
      .withIndex("by_account_listing", (q) =>
        q.eq("account_slug", account_slug).eq("hygglo_listing_id", hygglo_listing_id),
      )
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      hit_count: (row.hit_count ?? 0) + 1,
      last_used_at: Date.now(),
    });
    return {
      resolved_items: row.resolved_items,
      expanded_items: row.expanded_items,
      resolution_method: row.resolution_method,
    };
  },
});

/** Phase 15.1: public write-through used by the Trigger.dev task. */
export const adminUpsertResolution = mutation({
  args: {
    title_hash: v.string(),
    account_slug: v.optional(v.string()),
    hygglo_listing_id: v.optional(v.string()),
    sample_title: v.string(),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
    })),
    expanded_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),
    })),
    resolution_method: v.string(),
  },
  handler: async (ctx, args) => {
    const slug = args.account_slug;
    const listingId = args.hygglo_listing_id;
    let existing = (slug && listingId)
      ? await ctx.db
          .query("listing_resolutions")
          .withIndex("by_account_listing", (q) =>
            q.eq("account_slug", slug).eq("hygglo_listing_id", listingId),
          )
          .first()
      : null;
    if (!existing) {
      existing = await ctx.db
        .query("listing_resolutions")
        .withIndex("by_title_hash", (q) => q.eq("title_hash", args.title_hash))
        .first();
    }
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        sample_title: args.sample_title,
        resolved_items: args.resolved_items,
        expanded_items: args.expanded_items,
        resolution_method: args.resolution_method,
        account_slug: args.account_slug ?? existing.account_slug,
        hygglo_listing_id: args.hygglo_listing_id ?? existing.hygglo_listing_id,
        title_hash: args.title_hash,
        last_used_at: now,
      });
      return { action: "updated" as const };
    }
    await ctx.db.insert("listing_resolutions", {
      title_hash: args.title_hash,
      account_slug: args.account_slug,
      hygglo_listing_id: args.hygglo_listing_id,
      sample_title: args.sample_title,
      resolved_items: args.resolved_items,
      expanded_items: args.expanded_items,
      resolution_method: args.resolution_method,
      hit_count: 0,
      last_used_at: now,
      created_at: now,
    });
    return { action: "inserted" as const };
  },
});

/** Phase 15.1: increment hit counter via listing-id row. */
export const incrementHitByListing = internalMutation({
  args: { account_slug: v.string(), hygglo_listing_id: v.string() },
  handler: async (ctx, { account_slug, hygglo_listing_id }) => {
    const existing = await ctx.db
      .query("listing_resolutions")
      .withIndex("by_account_listing", (q) =>
        q.eq("account_slug", account_slug).eq("hygglo_listing_id", hygglo_listing_id),
      )
      .first();
    if (!existing) return { ok: false };
    await ctx.db.patch(existing._id, {
      hit_count: (existing.hit_count ?? 0) + 1,
      last_used_at: Date.now(),
    });
    return { ok: true };
  },
});

export const upsertResolution = internalMutation({
  args: {
    title_hash: v.string(),
    account_slug: v.optional(v.string()),
    hygglo_listing_id: v.optional(v.string()),
    sample_title: v.string(),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
    })),
    expanded_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),
    })),
    resolution_method: v.string(),
  },
  handler: async (ctx, args) => {
    // Prefer listing-id key match when both provided; fall back to title_hash.
    const slug = args.account_slug;
    const listingId = args.hygglo_listing_id;
    let existing = (slug && listingId)
      ? await ctx.db
          .query("listing_resolutions")
          .withIndex("by_account_listing", (q) =>
            q.eq("account_slug", slug).eq("hygglo_listing_id", listingId),
          )
          .first()
      : null;
    if (!existing) {
      existing = await ctx.db
        .query("listing_resolutions")
        .withIndex("by_title_hash", (q) => q.eq("title_hash", args.title_hash))
        .first();
    }
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        sample_title: args.sample_title,
        resolved_items: args.resolved_items,
        expanded_items: args.expanded_items,
        resolution_method: args.resolution_method,
        account_slug: args.account_slug ?? existing.account_slug,
        hygglo_listing_id: args.hygglo_listing_id ?? existing.hygglo_listing_id,
        title_hash: args.title_hash,
        last_used_at: now,
      });
      return { action: "updated" as const, id: existing._id };
    }
    const id = await ctx.db.insert("listing_resolutions", {
      title_hash: args.title_hash,
      account_slug: args.account_slug,
      hygglo_listing_id: args.hygglo_listing_id,
      sample_title: args.sample_title,
      resolved_items: args.resolved_items,
      expanded_items: args.expanded_items,
      resolution_method: args.resolution_method,
      hit_count: 0,
      last_used_at: now,
      created_at: now,
    });
    return { action: "inserted" as const, id };
  },
});

export const incrementHit = internalMutation({
  args: { title_hash: v.string() },
  handler: async (ctx, { title_hash }) => {
    const existing = await ctx.db
      .query("listing_resolutions")
      .withIndex("by_title_hash", (q) => q.eq("title_hash", title_hash))
      .first();
    if (!existing) return { ok: false };
    await ctx.db.patch(existing._id, {
      hit_count: (existing.hit_count ?? 0) + 1,
      last_used_at: Date.now(),
    });
    return { ok: true };
  },
});

/** One-shot backfill from existing reservations. Walks every row with
 *  resolved_items + expanded_items and writes the corresponding cache row. */
export const backfillFromReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("reservations").collect();
    let wrote = 0;
    const seen = new Set<string>();
    for (const r of all) {
      if (!r.items || r.items.length === 0) continue;
      const resolved = (r as { resolved_items?: Array<{ item_id: string; item_name_canonical: string; confidence: number; qty?: number }> }).resolved_items;
      const expanded = (r as { expanded_items?: Array<{ item_id: string; item_name_canonical: string; qty: number; via_bundle?: string }> }).expanded_items;
      if (!resolved || resolved.length === 0) continue;
      const hash = titleHash(r.items);
      if (seen.has(hash)) continue;
      seen.add(hash);
      const exp = expanded ?? resolved.map((x) => ({
        item_id: x.item_id,
        item_name_canonical: x.item_name_canonical,
        qty: x.qty ?? 1,
      }));
      const method = (r as { resolution_method?: string }).resolution_method ?? "llm";
      const existing = await ctx.db
        .query("listing_resolutions")
        .withIndex("by_title_hash", (q) => q.eq("title_hash", hash))
        .first();
      const now = Date.now();
      if (existing) {
        // Prefer vision-augmented over text-only.
        if (existing.resolution_method === "llm+vision" && method === "llm") continue;
        await ctx.db.patch(existing._id, {
          sample_title: r.items[0].item_name.slice(0, 200),
          resolved_items: resolved as Array<{
            item_id: import("./_generated/dataModel").Id<"items">;
            item_name_canonical: string;
            confidence: number;
            qty?: number;
          }>,
          expanded_items: exp as Array<{
            item_id: import("./_generated/dataModel").Id<"items">;
            item_name_canonical: string;
            qty: number;
            via_bundle?: import("./_generated/dataModel").Id<"bundles">;
          }>,
          resolution_method: method,
          last_used_at: now,
        });
      } else {
        await ctx.db.insert("listing_resolutions", {
          title_hash: hash,
          sample_title: r.items[0].item_name.slice(0, 200),
          resolved_items: resolved as Array<{
            item_id: import("./_generated/dataModel").Id<"items">;
            item_name_canonical: string;
            confidence: number;
            qty?: number;
          }>,
          expanded_items: exp as Array<{
            item_id: import("./_generated/dataModel").Id<"items">;
            item_name_canonical: string;
            qty: number;
            via_bundle?: import("./_generated/dataModel").Id<"bundles">;
          }>,
          resolution_method: method,
          hit_count: 0,
          last_used_at: now,
          created_at: now,
        });
      }
      wrote++;
    }
    return { total: all.length, unique_listings: seen.size, wrote };
  },
});


// ── Manual overrides — highest-priority tier ─────────────────────────

export const lookupOverride = internalQuery({
  args: { title_hash: v.string() },
  handler: async (ctx, { title_hash }) => {
    const row = await ctx.db
      .query("listing_overrides")
      .withIndex("by_title_hash", (q) => q.eq("title_hash", title_hash))
      .first();
    if (!row) return null;
    return {
      title_hash: row.title_hash,
      items: row.items,
      note: row.note,
    };
  },
});

/** Owner-facing mutation: set an override for a Hygglo listing.
 *  Pass the items[] from a sample reservation (so the hash matches what
 *  the resolver computes) and the canonical items the listing actually
 *  contains. */
export const setListingOverride = mutation({
  args: {
    title_hash: v.string(),
    sample_title: v.string(),
    items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
    })),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listing_overrides")
      .withIndex("by_title_hash", (q) => q.eq("title_hash", args.title_hash))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        sample_title: args.sample_title,
        items: args.items,
        note: args.note,
        set_at: Date.now(),
      });
      return { action: "updated" as const, id: existing._id };
    }
    const id = await ctx.db.insert("listing_overrides", {
      title_hash: args.title_hash,
      sample_title: args.sample_title,
      items: args.items,
      note: args.note,
      set_at: Date.now(),
    });
    return { action: "inserted" as const, id };
  },
});

export const removeListingOverride = mutation({
  args: { title_hash: v.string() },
  handler: async (ctx, { title_hash }) => {
    const existing = await ctx.db
      .query("listing_overrides")
      .withIndex("by_title_hash", (q) => q.eq("title_hash", title_hash))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return { ok: true };
  },
});

/** Helper for an admin UI: compute a title_hash from raw items input. */
export const computeTitleHash = mutation({
  args: { items: v.array(v.object({ item_name: v.string() })) },
  handler: async (_ctx, { items }) => {
    return { title_hash: titleHash(items) };
  },
});
