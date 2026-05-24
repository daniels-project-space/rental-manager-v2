/**
 * Listing Info Pool — V8 query/mutation surface (2026-05-24).
 *
 * Successor to listing_short_names. One row per (account_slug, product_id)
 * carrying source-grounded bundle decomposition (display name, primary
 * item, components with source_spans, attribution shares, per-field manual
 * override). See docs/listing-info-pool-plan.md for design.
 *
 * Runtime split (2026-05-24):
 *   - V8 (this file): cache reads/writes, manual override surface, and
 *     PUBLIC admin_* surface consumed by the Trigger.dev derive task
 *     (src/trigger/derive-listing-info-pool.ts).
 *   - LLM derivation: lives on Trigger.dev. The Convex action that used
 *     to do this (convex/listing_info_pool_actions.ts) was deleted —
 *     CLAUDE.md mandates no Convex actions for LLM work.
 */

import { query, mutation } from "./_generated/server";
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

// Note: the internal queries previously here (listActiveDistinctProducts,
// lookupRawForProduct, listActiveInventory, get, getAllCached) were used
// only by the deleted convex/listing_info_pool_actions.ts. Their batch +
// inventory + title-lookup roles are now consolidated into
// admin_getDerivationBatch (defined further down) — a single round-trip
// the Trigger.dev derive task calls per batch.

// ── Writes ─────────────────────────────────────────────────────────────────

// Canonical write surface for derivation results: `admin_upsertDerivation`
// (defined further down in the admin_* section). The previous
// internalMutation `upsert` was removed when the Convex action that called
// it was migrated to Trigger.dev — the Trigger task calls
// admin_upsertDerivation directly via ConvexHttpClient.

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
 *  Daniel can call from convex CLI to retrigger a single row. The Trigger.dev
 *  `derive-listing-info-pool` cron (every 30 min) picks the row up on its next
 *  tick and re-derives. UI callers that want low latency should also fire
 *  `tasks.trigger("derive-listing-info-pool-on-demand", { targets:[...], force:true })`
 *  via /api/listing-info-pool/derive — the mutation itself only marks the row. */
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

// ── Public admin_* surface — consumed by Trigger.dev derive task ──────────
//
// Why public (not internal):
//   ConvexHttpClient called from Trigger.dev tasks cannot invoke internal
//   functions without an admin key. Wrapping the existing internal* surface
//   in `admin_*` public queries/mutations keeps the auth model simple
//   (read-from-anywhere, write-via-named-path) and matches the resolver
//   convention in convex/item_resolver_queries.ts.
//
// The Trigger task uses two RPCs per run:
//   admin_getDerivationBatch  — returns work queue + inventory snapshot
//   admin_upsertDerivation    — writes a single derivation result
//
// The work queue logic mirrors the old action's backfillActive:
//   1. Listings with at least one active/upcoming reservation (last 60d)
//      that have no pool row, OR whose source_title_hash changed.
//   2. Existing pool rows with empty source_title_hash ("" — set by
//      forceReDerive) — manual re-derive targets.

type InventoryRow = {
  item_id: string;
  name_canonical: string;
  kind: string | null;
  aliases: string[];
  included_with_rental: string[];
  replacement_cost_gbp: number | null;
};

type DerivationTargetOut = {
  account_slug: string;
  product_id: number;
  raw_title: string;
};

/** Build the inventory snapshot the Trigger task uses for canonical
 *  resolution. Inlined here (rather than a shared helper) so the type of
 *  `ctx` is inferred from the surrounding query/mutation handler — the
 *  ctx shape differs subtly between V8 readers and writers. */
function projectInventoryRows(all: Array<Doc<"items">>): InventoryRow[] {
  return all
    .filter((i) => i.status === "active" && !i.is_marketing_only)
    .map((i) => ({
      item_id: i._id as string,
      name_canonical: i.name_canonical,
      kind: i.kind ?? null,
      aliases: i.aliases ?? [],
      included_with_rental: i.compatibility?.included_with_rental ?? [],
      replacement_cost_gbp: i.replacement_cost_gbp ?? null,
    }));
}

/**
 * Public batch fetcher consumed by the Trigger.dev derive task.
 *
 * Args:
 *   limit    — max candidates to return (cron path; default 20).
 *   targets  — when supplied (on-demand path), only these are returned
 *              (joined with raw_title from reservations if not provided).
 *   force    — when true, candidates with up-to-date hashes are STILL
 *              returned. Default false (cache hit semantics).
 *
 * Output shape is whatever the Trigger task needs in one round-trip:
 *   { targets: DerivationTargetOut[], inventory: InventoryRow[] }
 */
export const admin_getDerivationBatch = query({
  args: {
    limit: v.optional(v.number()),
    targets: v.optional(v.array(v.object({
      account_slug: v.string(),
      product_id: v.number(),
      raw_title: v.optional(v.string()),
    }))),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { limit, targets: requestedTargets, force },
  ): Promise<{ targets: DerivationTargetOut[]; inventory: InventoryRow[] }> => {
    const cap = Math.max(1, Math.min(limit ?? 20, 100));
    const wantForce = !!force;
    const inventory = projectInventoryRows(await ctx.db.query("items").collect());

    // Existing pool rows — cheap projection used both for the on-demand
    // path (skip cache hits) and the cron path (skip already-derived).
    const allPool = await ctx.db.query("listing_info_pool").collect();
    const poolByKey = new Map<string, { hash: string }>();
    for (const r of allPool) {
      poolByKey.set(`${r.account_slug}#${r.product_id}`, {
        hash: r.source_title_hash,
      });
    }

    // ── On-demand path ─────────────────────────────────────────────────
    // Used by poll-hygglo + UI re-derive button. Caller knows the exact
    // (account_slug, product_id) tuples and (usually) the raw_title. When
    // raw_title is missing we look it up by scanning recent reservations.
    if (requestedTargets && requestedTargets.length > 0) {
      const out: DerivationTargetOut[] = [];
      // Look up missing titles by scanning recent reservations.
      const needsTitleLookup = requestedTargets.filter((t) => !t.raw_title);
      const titleMap = new Map<string, string>();
      if (needsTitleLookup.length > 0) {
        const recent = await ctx.db
          .query("reservations")
          .withIndex("by_start_date", (q) => q.gte("start_date", "2024-01-01"))
          .collect();
        const wantedKeys = new Set(
          needsTitleLookup.map((t) => `${t.account_slug}#${t.product_id}`),
        );
        const mostRecentEnd = new Map<string, string>();
        for (const r of recent) {
          const items = (r as any).hygglo_items as
            | Array<{ name?: string; product_id?: number }>
            | undefined;
          if (!Array.isArray(items)) continue;
          for (const it of items) {
            if (typeof it.product_id !== "number" || !it.name) continue;
            const key = `${r.account_slug}#${it.product_id}`;
            if (!wantedKeys.has(key)) continue;
            const endDate = (r as any).return_date ?? r.end_date ?? "";
            if (endDate >= (mostRecentEnd.get(key) ?? "")) {
              titleMap.set(key, it.name);
              mostRecentEnd.set(key, endDate);
            }
          }
        }
      }
      // On-demand callers pass an explicit target list, so we don't
      // filter by cache-hit here — the Trigger task re-hashes the title
      // and short-circuits the LLM call when the computed hash matches
      // the stored source_title_hash. `force` is honoured upstream
      // (Trigger task) and downstream (cron path below). Keeping this
      // query hash-free saves V8 cycles.
      for (const t of requestedTargets) {
        const key = `${t.account_slug}#${t.product_id}`;
        const title = t.raw_title ?? titleMap.get(key);
        if (!title) continue; // can't derive without a title; silently skip
        out.push({
          account_slug: t.account_slug,
          product_id: t.product_id,
          raw_title: title,
        });
        if (out.length >= cap) break;
      }
      return { targets: out, inventory };
    }

    // ── Cron path ──────────────────────────────────────────────────────
    // Scan recent reservations to find active distinct (account, product_id)
    // pairs, then return the ones either missing or with empty hash
    // (forceReDerive marker). Mirrors the old listActiveDistinctProducts +
    // hash check from backfillActive.
    const today = new Date().toISOString().slice(0, 10);
    const sinceIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", sinceIso))
      .collect();

    type Tup = { account_slug: string; product_id: number; raw_title: string };
    const seen = new Map<string, Tup>();
    for (const r of rows) {
      if (r.status !== "confirmed" && r.status !== "pending_review") continue;
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
        seen.set(key, { account_slug: slug, product_id: it.product_id, raw_title: it.name });
      }
    }

    const candidates: DerivationTargetOut[] = [];
    for (const t of seen.values()) {
      const key = `${t.account_slug}#${t.product_id}`;
      const existing = poolByKey.get(key);
      // Pick up rows that are missing, marked for re-derive (empty hash),
      // or any active listing if force is set.
      const include =
        wantForce ||
        !existing ||
        !existing.hash ||
        existing.hash.length === 0;
      if (!include) continue;
      candidates.push(t);
      if (candidates.length >= cap) break;
    }

    return { targets: candidates, inventory };
  },
});

/**
 * Public wrapper around the internal upsert mutation. Used by the Trigger
 * derive task to persist a derivation result. Forwards args verbatim to
 * the internal upsert handler — no business logic change.
 */
export const admin_upsertDerivation = mutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),

    source_title: v.string(),
    source_title_hash: v.string(),
    source_description: v.optional(v.string()),
    source_description_hash: v.optional(v.string()),
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
      await ctx.db.patch(existing._id, {
        ...args,
        derived_at: now,
        updated_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("listing_info_pool", {
      ...args,
      derived_at: now,
      updated_at: now,
    });
  },
});
