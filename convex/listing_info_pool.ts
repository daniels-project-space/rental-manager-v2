/**
 * Listing Info Pool — V8 query/mutation surface (2026-05-24).
 *
 * Successor to listing_short_names. One row per (account_slug, product_id)
 * carrying source-grounded bundle decomposition (display name, primary
 * item, components with source_spans, attribution shares, per-field manual
 * override). See docs/listing-info-pool-plan.md for design.
 *
 * Split layout (mirrors listing_short_names):
 *   - V8 runtime (this file): cache reads/writes + manual override surface.
 *   - listing_info_pool_actions.ts ("use node"): LLM derivation + backfills.
 */

import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

// ── Validators shared with the action module ───────────────────────────────

const sourceKindV = v.union(
  v.literal("primary"),
  v.literal("bundled_required"),
  v.literal("bundled_optional"),
  v.literal("comparison_reference"),
  v.literal("standard_included"),
);

const derivationMethodV = v.union(
  v.literal("text"),
  v.literal("text+attrs"),
  v.literal("manual"),
  v.literal("passthrough_fallback"),
);

const bundleComponentV = v.object({
  item_id: v.optional(v.id("items")),
  item_name_canonical: v.optional(v.string()),
  qty: v.number(),
  confidence: v.number(),
  source_kind: sourceKindV,
  source_span: v.optional(v.string()),
});

const attributionShareV = v.object({
  item_id: v.optional(v.id("items")),
  item_name_canonical: v.optional(v.string()),
  share_pct: v.number(),
  weight_method: v.string(),
});

// ── SHA-256 helper (Convex V8 runtime exposes globalThis.crypto.subtle) ───
async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export { sha256Hex as _sha256Hex };

// ── Effective-value resolver ───────────────────────────────────────────────
//
// Manual override always wins over LLM derivation, per-field. Callers (display
// reader, attribution, double-booking, etc.) should always read via this
// helper so the precedence is enforced in one place.

export type EffectivePoolView = {
  account_slug: string;
  product_id: number;
  short_name: string;
  bundle_summary: string | null;
  display_name: string;
  primary_item_id: Id<"items"> | null;
  primary_item_name_canonical: string | null;
  bundle_components: Array<{
    item_id: Id<"items"> | null;
    item_name_canonical: string | null;
    qty: number;
    confidence: number;
    source_kind:
      | "primary"
      | "bundled_required"
      | "bundled_optional"
      | "comparison_reference"
      | "standard_included";
    source_span: string | null;
  }>;
  canonical_bundle_signature: string;
  derivation_method: string;
  derivation_confidence: number;
  needs_review: boolean;
  review_reasons: string[];
  is_manually_overridden: boolean;
};

export function effectiveView(row: Doc<"listing_info_pool">): EffectivePoolView {
  const mo = row.manual_override;
  // bundle_components precedence: manual override resolves item_ids only —
  // re-emit as full components for downstream consumers.
  let componentsOut: EffectivePoolView["bundle_components"];
  if (mo?.bundle_components && mo.bundle_components.length > 0) {
    componentsOut = mo.bundle_components.map((c) => ({
      item_id: c.item_id,
      item_name_canonical: null,
      qty: c.qty,
      confidence: 1.0,
      source_kind: "primary" as const,
      source_span: null,
    }));
  } else {
    componentsOut = row.bundle_components.map((c) => ({
      item_id: c.item_id ?? null,
      item_name_canonical: c.item_name_canonical ?? null,
      qty: c.qty,
      confidence: c.confidence,
      source_kind: c.source_kind,
      source_span: c.source_span ?? null,
    }));
  }
  const shortName = mo?.short_name ?? row.short_name;
  const bundleSummary =
    mo?.bundle_summary !== undefined ? mo.bundle_summary : (row.bundle_summary ?? null);
  const display = bundleSummary
    ? `${shortName} ${bundleSummary}`.replace(/\s+/g, " ").trim()
    : shortName;
  return {
    account_slug: row.account_slug,
    product_id: row.product_id,
    short_name: shortName,
    bundle_summary: bundleSummary,
    display_name: mo ? display : row.display_name,
    primary_item_id: row.primary_item_id ?? null,
    primary_item_name_canonical: row.primary_item_name_canonical ?? null,
    bundle_components: componentsOut,
    canonical_bundle_signature: row.canonical_bundle_signature,
    derivation_method: row.derivation_method,
    derivation_confidence: row.derivation_confidence,
    needs_review: row.needs_review,
    review_reasons: row.review_reasons,
    is_manually_overridden: !!mo,
  };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** Look up the pool row for a single (account, product). Internal so the
 *  Node-side action can read its own cache without exposing all fields to
 *  the public API. */
export const get = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    return await ctx.db
      .query("listing_info_pool")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
  },
});

/** Public effective-view single read (used by admin UI / CLI / drawers). */
export const getEffective = query({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    const row = await ctx.db
      .query("listing_info_pool")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    return row ? effectiveView(row) : null;
  },
});

/** Bulk effective-view lookup used by dashboard query path. Returns a map
 *  keyed by `${account_slug}#${product_id}`. */
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
    const out: Record<string, EffectivePoolView> = {};
    for (const k of keys) {
      const row = await ctx.db
        .query("listing_info_pool")
        .withIndex("by_account_product", (q) =>
          q.eq("account_slug", k.account_slug).eq("product_id", k.product_id),
        )
        .unique();
      if (row) {
        out[`${k.account_slug}#${k.product_id}`] = effectiveView(row);
      }
    }
    return out;
  },
});

/** All cached rows (light projection) — used by the Node action to decide
 *  what to re-derive without N round-trips. */
export const getAllCached = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("listing_info_pool").collect();
    return all.map((r) => ({
      account_slug: r.account_slug,
      product_id: r.product_id,
      source_title_hash: r.source_title_hash,
      derivation_method: r.derivation_method,
      derivation_confidence: r.derivation_confidence,
      needs_review: r.needs_review,
    }));
  },
});

/** Rows currently flagged for human review. Admin UI fetches this. */
export const listNeedsReview = query({
  args: { account_slug: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, { account_slug, limit }) => {
    const lim = Math.max(1, Math.min(limit ?? 100, 500));
    const rows = await ctx.db
      .query("listing_info_pool")
      .withIndex("by_needs_review", (q) => q.eq("needs_review", true))
      .take(lim * 4);
    const filtered = account_slug ? rows.filter((r) => r.account_slug === account_slug) : rows;
    return filtered.slice(0, lim).map(effectiveView);
  },
});

/** Active-rentals derivation candidates. Like
 *  listing_short_names:listActiveDistinctProducts. Text-only; info pool
 *  derivation is title-driven so per-item image surfacing is not needed. */
export const listActiveDistinctProducts = internalQuery({
  args: { since_iso: v.optional(v.string()) },
  handler: async (ctx, { since_iso }) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = since_iso ?? "2024-01-01";
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", from))
      .collect();
    type Tup = {
      account_slug: string;
      product_id: number;
      raw_title: string;
    };
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
        if (seen.has(key)) continue;
        seen.set(key, {
          account_slug: slug,
          product_id: it.product_id,
          raw_title: it.name,
        });
      }
    }
    return Array.from(seen.values());
  },
});

/** Single-product raw title lookup — used by deriveOne when called outside
 *  a poll context. Scans ALL reservations so product_ids that only appear
 *  in a single historical rental are still resolvable. Text-only. */
export const lookupRawForProduct = internalQuery({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", "2024-01-01"))
      .collect();
    let raw_title: string | null = null;
    let mostRecentEnd: string = "";
    for (const r of rows) {
      if (r.account_slug !== account_slug) continue;
      const items = (r as any).hygglo_items as
        | Array<{ name?: string; product_id?: number }>
        | undefined;
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        if (it.product_id !== product_id) continue;
        const endDate = (r as any).return_date ?? r.end_date ?? "";
        // Prefer the title from the most recent reservation that touches this
        // product_id (Hygglo titles drift; latest is most representative).
        if (it.name && endDate >= mostRecentEnd) {
          raw_title = it.name;
          mostRecentEnd = endDate;
        }
      }
    }
    return { raw_title };
  },
});

/** Active items snapshot (inventory the LLM is allowed to choose from).
 *  Internal — exposes just the columns needed for canonical resolution. */
export const listActiveInventory = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("items").collect();
    return all
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({
        item_id: i._id,
        name_canonical: i.name_canonical,
        kind: i.kind ?? null,
        aliases: i.aliases ?? [],
        included_with_rental: i.compatibility?.included_with_rental ?? [],
        replacement_cost_gbp: i.replacement_cost_gbp ?? null,
      }));
  },
});

// ── Writes ─────────────────────────────────────────────────────────────────

/** Upsert a full derivation result. Called by the Node-side action. */
export const upsert = internalMutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),

    source_title: v.string(),
    source_title_hash: v.string(),
    source_description: v.optional(v.string()),
    source_description_hash: v.optional(v.string()),
    // DEPRECATED 2026-05-24: vision pass removed. Optional so already-persisted
    // rows remain valid; new writes pass an empty array (or omit).
    source_image_urls: v.optional(v.array(v.string())),
    source_image_phash_blob: v.optional(v.string()),
    derivation_method: derivationMethodV,

    short_name: v.string(),
    bundle_summary: v.optional(v.string()),
    display_name: v.string(),

    primary_item_id: v.optional(v.id("items")),
    primary_item_name_canonical: v.optional(v.string()),
    primary_item_confidence: v.number(),

    bundle_components: v.array(bundleComponentV),
    canonical_bundle_signature: v.string(),
    attribution_shares: v.array(attributionShareV),

    derivation_confidence: v.number(),
    needs_review: v.boolean(),
    review_reasons: v.array(v.string()),

    llm_raw_response: v.optional(v.string()),
    llm_model_id: v.optional(v.string()),
    llm_cost_usd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listing_info_pool")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", args.account_slug).eq("product_id", args.product_id),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      // Manual override field is preserved across re-derivations.
      const patch = {
        ...args,
        derived_at: now,
        updated_at: now,
      };
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("listing_info_pool", {
      ...args,
      derived_at: now,
      updated_at: now,
    });
  },
});

/** Per-field manual override. Each field is optional and only the supplied
 *  ones are stored — caller can fix bundle_summary alone without touching
 *  short_name or components. */
export const setManualOverride = mutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    short_name: v.optional(v.string()),
    bundle_summary: v.optional(v.string()),
    bundle_components: v.optional(v.array(v.object({
      item_id: v.id("items"),
      qty: v.number(),
    }))),
    set_by: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("listing_info_pool")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", args.account_slug).eq("product_id", args.product_id),
      )
      .unique();
    if (!row) {
      throw new Error(
        `setManualOverride: no pool row for ${args.account_slug}#${args.product_id} — derive first`,
      );
    }
    const now = Date.now();
    const prior = row.manual_override ?? null;
    const next = {
      short_name: args.short_name ?? prior?.short_name,
      bundle_summary: args.bundle_summary ?? prior?.bundle_summary,
      bundle_components: args.bundle_components ?? prior?.bundle_components,
      set_by: args.set_by,
      set_at: now,
      note: args.note ?? prior?.note,
    };
    await ctx.db.patch(row._id, {
      manual_override: next,
      updated_at: now,
    });
    return row._id;
  },
});

/** Drop the manual override entirely; derived values take over again. */
export const clearManualOverride = mutation({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    const row = await ctx.db
      .query("listing_info_pool")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { manual_override: undefined, updated_at: Date.now() });
    return row._id;
  },
});

/** Null the source_title_hash so the next derivation is forced. Public —
 *  Daniel can call from convex CLI to retrigger a single row. The action is
 *  separately scheduled by the caller. */
export const forceReDerive = mutation({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, { account_slug, product_id }) => {
    const row = await ctx.db
      .query("listing_info_pool")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", account_slug).eq("product_id", product_id),
      )
      .unique();
    if (!row) return { ok: false, reason: "no_row" as const };
    await ctx.db.patch(row._id, {
      source_title_hash: "",
      updated_at: Date.now(),
    });
    return { ok: true as const, id: row._id };
  },
});
