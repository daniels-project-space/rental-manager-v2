/**
 * Internal queries/mutations supporting the item_resolver action.
 * Kept in a separate module so the action (which runs in Node) doesn't
 * mix server-only code with internal Convex helpers.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation, mutation, query } from "./_generated/server";
// Phase W3b — dual-write to reservation_vision side table.
import { mirrorResolvedItemsToVisionTable } from "./reservation_vision";
import { titleHash } from "./listing_cache";

export const getReservationForResolve = internalQuery({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }) => {
    const r = await ctx.db.get(reservation_id);
    if (!r) return null;
    return {
      _id: r._id,
      items: r.items ?? [],
      // v1 imports came in with items=[] but a rich `notes` field carrying
      // the listing description (e.g. "Sony fx3 + 24-70mm + tripod + rode").
      // The resolver uses this as a fallback title when items[] is empty so
      // historical revenue can still be attributed to specific inventory.
      notes: (r as any).notes ?? null,
      hygglo_order_id: r.hygglo_order_id ?? null,
      hygglo_listing_id: (r as any).hygglo_listing_id ?? null,
      photos_urls: (r as any).photos_urls ?? [],
      resolved_items: (r as any).resolved_items ?? undefined,
      resolution_input_hash: (r as any).resolution_input_hash ?? undefined,
      // Deterministic product_id tier (2026-08-18). ONLY hygglo_items carries
      // product_id — items[] does not (0/25 on live bookings) — and the
      // resolution maps are keyed by account_slug + product_id.
      account_slug: (r as any).account_slug ?? null,
      hygglo_items: ((r as any).hygglo_items ?? []) as Array<{
        product_id?: number;
        name?: string;
      }>,
    };
  },
});

/**
 * Deterministic listing → inventory resolution for one account.
 *
 * Same tables that drive calendar_holds since 2026-08-18, so the two halves of
 * the system (holds vs reservations.expanded_items) resolve identically. Only
 * these tables are authoritative — no fuzzy/LLM step — because token matching
 * is what mapped a "Cinema Tripod Stand" listing onto the C-stand.
 */
export const getResolutionMapsForAccount = internalQuery({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const index = await ctx.db
      .query("hygglo_product_index")
      .withIndex("by_account_product", (q) => q.eq("account_slug", account_slug))
      .collect();
    const overrides = await ctx.db
      .query("listing_resolution_override")
      .withIndex("by_account_product", (q) => q.eq("account_slug", account_slug))
      .collect();
    const items = await ctx.db.query("items").collect();
    const nameOf = new Map(items.map((i) => [String(i._id), i.name_canonical]));
    return {
      index: index.map((r) => ({
        product_id: r.product_id,
        item_id: String(r.item_id),
        item_name_canonical: nameOf.get(String(r.item_id)) ?? "",
      })),
      overrides: overrides.map((r) => ({
        product_id: r.product_id,
        components: r.components.map((c) => ({
          item_id: String(c.item_id),
          item_name_canonical: nameOf.get(String(c.item_id)) ?? "",
          qty: c.qty,
        })),
      })),
    };
  },
});

export const getInventoryForResolve = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("items").collect();
    return all
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({
        _id: i._id as string,
        name_canonical: i.name_canonical,
        aliases: i.aliases ?? [],
        kind: i.kind,
        notes: i.notes,
      }));
  },
});

export const setResolution = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
      revenue_gbp: v.optional(v.number()),
    })),
    expanded_items: v.optional(v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),
    }))),
    method: v.string(),
    input_hash: v.string(),
  },
  handler: async (ctx, { reservation_id, resolved_items, expanded_items, method, input_hash }) => {
    const now = Date.now();
    await ctx.db.patch(reservation_id, {
      resolved_items,
      expanded_items,
      resolution_at: now,
      resolution_method: method,
      resolution_input_hash: input_hash,
    });
    // Phase W3b — dual-write to reservation_vision side table.
    await mirrorResolvedItemsToVisionTable(ctx, reservation_id, resolved_items, now);
    return { ok: true };
  },
});

/**
 * Public migration mutation: set renter_name on a v1-imported reservation
 * by v1_rental_id. Used by the v1 Postgres → Convex backfill so top-spender
 * and at-risk-renter queries can aggregate the historical cohort.
 */
export const admin_setRenterNameByV1Id = mutation({
  args: { v1_rental_id: v.string(), renter_name: v.string() },
  handler: async (ctx, { v1_rental_id, renter_name }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", v1_rental_id))
      .collect();
    if (rows.length === 0) return { ok: false, reason: "reservation not found" };
    for (const r of rows) {
      await ctx.db.patch(r._id, { renter_name });
    }
    return { ok: true, patched: rows.length };
  },
});

/**
 * Public migration mutation: write resolved_items for a v1-imported
 * reservation, identified by v1_rental_id. Used by the one-time Python
 * migration that ports v1's per-row revenue attribution
 * (booking.item_name + booking.revenue) into v2's reservation rows so chat
 * answers like "how much has X earned" match v1's numbers verbatim.
 *
 * Public (not internal) so the migration script can call it via HTTP. No
 * auth gate beyond Convex's standard URL-scoped access — this writes only
 * resolved_items / resolution_method metadata, never financial state.
 */
export const admin_setResolutionByV1Id = mutation({
  args: {
    v1_rental_id: v.string(),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
      revenue_gbp: v.optional(v.number()),
    })),
    method: v.optional(v.string()),
  },
  handler: async (ctx, { v1_rental_id, resolved_items, method }) => {
    const rows = await ctx.db
      .query("reservations")
      .withIndex("by_v1_rental_id", (q) => q.eq("v1_rental_id", v1_rental_id))
      .collect();
    if (rows.length === 0) return { ok: false, reason: "reservation not found" };
    let patched = 0;
    for (const r of rows) {
      const hash = resolved_items
        .map((x) => x.item_name_canonical + ":" + (x.qty ?? 1))
        .sort()
        .join("|");
      const now = Date.now();
      await ctx.db.patch(r._id, {
        resolved_items,
        resolution_at: now,
        resolution_method: method ?? "v1_migration",
        resolution_input_hash: "v1:" + hash,
      });
      // Phase W3b — dual-write to reservation_vision side table.
      await mirrorResolvedItemsToVisionTable(ctx, r._id, resolved_items, now);
      patched++;
    }
    return { ok: true, patched };
  },
});

/**
 * Returns up to `limit` reservation IDs that need resolution.
 * "Need" = has items, AND (no resolution OR resolution_input_hash is stale).
 * Stale check is computed inline (cheap — items is small) by hashing items[].
 */
export const listUnresolved = internalQuery({
  args: { limit: v.number(), include_notes_only: v.optional(v.boolean()) },
  handler: async (ctx, { limit, include_notes_only }) => {
    const all = await ctx.db.query("reservations").collect(); // check-patterns:ok — internal/admin resolver batch inputs
    const need: { id: typeof all[number]["_id"]; created: number }[] = [];
    for (const r of all) {
      if (r.is_obsolete) continue;
      const hasItems = (r.items?.length ?? 0) > 0;
      const notes = (r as any).notes as string | undefined;
      const hasNotes = notes !== undefined && notes !== null && notes.trim().length > 0;
      // Default behaviour (poller path): only consider rows with items[].
      // Backfill path passes include_notes_only=true to also pick up v1
      // imports whose listing description sits in `notes`.
      if (!hasItems && !(include_notes_only === true && hasNotes)) continue;

      const currentHash = hasItems
        ? (r.items ?? []).map((i) => i.item_name).sort().join("|")
        : `notes:${(notes ?? "").trim()}`;
      const stored = (r as any).resolution_input_hash;
      const resolved = (r as any).resolved_items;
      if (resolved !== undefined && stored === currentHash) continue;
      need.push({ id: r._id, created: r._creationTime });
    }
    need.sort((a, b) => b.created - a.created);
    return need.slice(0, limit).map((n) => n.id);
  },
});


/** Returns every bundle with its bundle_items joined. Used by the
 *  item_resolver action to expand kit listings into physical components. */
export const getBundlesWithItems = internalQuery({
  args: {},
  handler: async (ctx) => {
    const bundles = await ctx.db.query("bundles").collect();
    const out: Array<{
      bundle_id: string;
      slug: string;
      bundle_name: string;
      items: Array<{ item_id: string | undefined; item_name_canonical: string; qty: number }>;
    }> = [];
    for (const b of bundles) {
      const items = await ctx.db
        .query("bundle_items")
        .withIndex("by_bundle", (q) => q.eq("bundle_id", b._id))
        .collect();
      out.push({
        bundle_id: b._id as string,
        slug: b.slug,
        bundle_name: b.bundle_name,
        items: items.map((i) => ({
          item_id: i.item_id as string | undefined,
          item_name_canonical: i.item_name_canonical,
          qty: i.qty,
        })),
      });
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────
// Trigger.dev orchestration surface.
// The item-resolver action is lifted to src/trigger/resolve-items.ts to
// stop billing Convex action runtime for long Grok calls. The Trigger
// task calls these public queries/mutations via HTTP.
// ───────────────────────────────────────────────────────────────────────

/**
 * Public bundle: returns everything the resolver needs for one batch.
 * Cuts HTTP round-trips per batch from ~5 to 1.
 *
 *   - unresolved: the reservations to process (already hash-skipping fresh ones)
 *   - inventory:  all active inventory items
 *   - bundles:    bundle definitions for expansion
 *   - cache:      pre-fetched cache hits per title_hash (where available)
 *   - overrides:  manual mapping table by title_hash
 */
export const admin_getResolverBatchInputs = query({
  args: {
    limit: v.number(),
    include_notes_only: v.optional(v.boolean()),
    // Phase 18.2 — on-demand mode: only consider these reservation IDs.
    // Used by poll-hygglo to resolve freshly-inserted reservations in seconds
    // instead of waiting up to 60 min for the next cron scan.
    ids: v.optional(v.array(v.id("reservations"))),
  },
  handler: async (ctx, { limit, include_notes_only, ids }) => {
    // Reuse the same logic as listUnresolved.
    // When `ids` is provided, do targeted .get() lookups instead of a full scan.
    const all = ids && ids.length > 0
      ? (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
          (x): x is NonNullable<typeof x> => x !== null,
        )
      : await ctx.db.query("reservations").collect(); // check-patterns:ok — internal/admin resolver batch inputs
    type Item = { item_name: string; qty?: number };
    type Reservation = (typeof all)[number] & {
      items?: Item[];
      notes?: string | null;
      resolution_input_hash?: string;
      resolution_method?: string;
      resolved_items?: unknown;
      hygglo_order_id?: string;
    };
    const need: Array<{
      id: string;
      items: Item[];
      notes: string | null;
      photos_urls: string[];
      account_slug: string | null;
      hygglo_listing_id: string | null;
    }> = [];
    for (const rRaw of all) {
      const r = rRaw as Reservation;
      if (r.is_obsolete) continue;
      const hasItems = (r.items?.length ?? 0) > 0;
      const notes = r.notes;
      const hasNotes =
        notes !== undefined && notes !== null && notes.trim().length > 0;
      if (!hasItems && !(include_notes_only === true && hasNotes)) continue;
      const items: Item[] = hasItems
        ? (r.items as Item[])
        : [{ item_name: (notes as string).trim() }];
      const currentHash = items.map((i) => i.item_name).sort().join("|");
      // Partial deterministic writes protect availability during an LLM outage
      // but must remain eligible for later enrichment.
      if (
        r.resolved_items !== undefined &&
        r.resolution_input_hash === currentHash &&
        r.resolution_method !== "deterministic_partial"
      ) continue;
      need.push({
        id: r._id as string,
        items,
        notes: notes ?? null,
        photos_urls: ((r as { photos_urls?: string[] }).photos_urls ?? []),
        account_slug: ((r as { account_slug?: string | null }).account_slug ?? null),
        // Current poller rows do not persist a separate hygglo_listing_id. The
        // order id is the stable key used by poll-hygglo's listing resolver, so
        // use it as the primary cache identity instead of silently disabling
        // every by-listing lookup for modern reservations.
        hygglo_listing_id:
          ((r as { hygglo_listing_id?: string | null }).hygglo_listing_id ??
            r.hygglo_order_id ??
            null),
      });
      if (need.length >= limit) break;
    }
    const sliced = need.slice(0, limit);

    // Inventory snapshot
    const allItems = await ctx.db.query("items").collect();
    const inventory = allItems
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({
        _id: i._id as string,
        name_canonical: i.name_canonical,
        aliases: i.aliases ?? [],
        kind: i.kind,
        notes: i.notes,
      }));

    // Bundle definitions (joined with bundle_items)
    const bundleDocs = await ctx.db.query("bundles").collect();
    const allBundleItems = await ctx.db.query("bundle_items").collect();
    const itemById = new Map(allItems.map((i) => [i._id as string, i]));
    const bundles = bundleDocs.map((b) => {
      const its = allBundleItems
        .filter((bi) => bi.bundle_id === b._id)
        .map((bi) => {
          const item = bi.item_id ? itemById.get(bi.item_id as string) : null;
          return {
            item_id: item?._id as string | undefined,
            item_name_canonical: item?.name_canonical ?? "",
            qty: bi.qty,
          };
        })
        .filter((x) => x.item_id);
      return {
        bundle_id: b._id as string,
        bundle_name: b.bundle_name,
        items: its,
      };
    });

    // Phase 18.3 — prefetch the existing title-hash cache in the same bundled
    // query. Modern reservations have historically had hygglo_listing_id=null,
    // so the Trigger worker's by-listing-only cache path missed hundreds of
    // known-good prior resolutions and fell through to the LLM. Indexed reads
    // are bounded by the resolver batch size (15). Empty historical results are
    // omitted so an old failed attempt never counts as a successful cache hit.
    const cacheEntries = await Promise.all(
      sliced.map(async (r) => {
        const hash = titleHash(r.items);
        const row = await ctx.db
          .query("listing_resolutions")
          .withIndex("by_title_hash", (q) => q.eq("title_hash", hash))
          .first();
        if (
          !row ||
          row.resolved_items.length === 0 ||
          row.resolution_method === "deterministic_partial"
        ) return null;
        return [
          hash,
          {
            resolved_items: row.resolved_items,
            expanded_items: row.expanded_items,
            resolution_method: row.resolution_method,
          },
        ] as const;
      }),
    );
    const cache_by_title_hash = Object.fromEntries(
      cacheEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    );

    return {
      unresolved: sliced,
      inventory,
      bundles,
      cache_by_title_hash,
    };
  },
});

/**
 * Public batch-write mutation: persists resolution results for multiple
 * reservations in one call. Each result includes resolved_items + expanded_items
 * + method + input_hash, exactly mirroring the original action's writes.
 */
export const admin_resolveBatchWrite = mutation({
  args: {
    results: v.array(v.object({
      reservation_id: v.id("reservations"),
      resolved_items: v.array(v.object({
        item_id: v.id("items"),
        item_name_canonical: v.string(),
        confidence: v.number(),
        qty: v.optional(v.number()),
        revenue_gbp: v.optional(v.number()),
      })),
      expanded_items: v.optional(v.array(v.object({
        item_id: v.id("items"),
        item_name_canonical: v.string(),
        qty: v.number(),
        via_bundle: v.optional(v.id("bundles")),
      }))),
      method: v.string(),
      input_hash: v.string(),
    })),
  },
  handler: async (ctx, { results }) => {
    let patched = 0;
    for (const r of results) {
      const now = Date.now();
      await ctx.db.patch(r.reservation_id, {
        resolved_items: r.resolved_items,
        expanded_items: r.expanded_items,
        resolution_at: now,
        resolution_method: r.method,
        resolution_input_hash: r.input_hash,
      });
      // Phase W3b — dual-write to reservation_vision side table.
      await mirrorResolvedItemsToVisionTable(ctx, r.reservation_id, r.resolved_items, now);
      patched++;
    }
    return { ok: true, patched };
  },
});

// ───────────────────────────────────────────────────────────────────────
// Vision-resolver Trigger.dev orchestration surface.
// Lifted to src/trigger/vision-resolve.ts. Single bundled query +
// per-call merge mutation. Vision Grok holds Convex actions open the
// longest of any LLM call (~8-15s per call) — biggest action-runtime
// saver after the text resolver.
// ───────────────────────────────────────────────────────────────────────

export const admin_getVisionBatchInputs = query({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    // Mirrors listNeedingVision selection logic.
    const KIT_RE = /(kit|set|complete|full|bundle|package|cinematic|production)|\+/i;
    const all = await ctx.db.query("reservations").collect(); // check-patterns:ok — internal/admin resolver batch inputs
    type Row = (typeof all)[number] & {
      items?: Array<{ item_name: string }>;
      photos_urls?: string[];
      resolved_items?: Array<{
        item_id: string;
        item_name_canonical: string;
        confidence: number;
        qty?: number;
        revenue_gbp?: number;
      }>;
      resolution_at?: number;
      resolution_method?: string | null;
      resolution_input_hash?: string;
    };
    const candidates: Array<{ row: Row; ts: number }> = [];
    for (const r of all as Row[]) {
      if (r.is_obsolete) continue;
      if (!r.hygglo_order_id) continue;
      if ((r.photos_urls?.length ?? 0) === 0) continue;
      if ((r.resolution_method ?? null) !== "llm") continue;
      const title = (r.items ?? []).map((i) => i.item_name).join(" + ");
      if (!KIT_RE.test(title)) continue;
      candidates.push({ row: r, ts: r.resolution_at ?? r._creationTime });
    }
    candidates.sort((a, b) => b.ts - a.ts);
    const picks = candidates.slice(0, limit);

    // Inventory + bundles (shared with text resolver — same source of truth)
    const allItems = await ctx.db.query("items").collect();
    const inventory = allItems
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({
        _id: i._id as string,
        name_canonical: i.name_canonical,
        aliases: i.aliases ?? [],
        kind: i.kind,
        notes: i.notes,
      }));
    const bundleDocs = await ctx.db.query("bundles").collect();
    const allBundleItems = await ctx.db.query("bundle_items").collect();
    const itemById = new Map(allItems.map((i) => [i._id as string, i]));
    const bundles = bundleDocs.map((b) => {
      const its = allBundleItems
        .filter((bi) => bi.bundle_id === b._id)
        .map((bi) => {
          const item = bi.item_id ? itemById.get(bi.item_id as string) : null;
          return {
            item_id: item?._id as string | undefined,
            item_name_canonical: item?.name_canonical ?? "",
            qty: bi.qty,
          };
        })
        .filter((x) => x.item_id);
      return { bundle_id: b._id as string, bundle_name: b.bundle_name, items: its };
    });

    const work = picks.map(({ row }) => ({
      id: row._id as string,
      photos_urls: (row.photos_urls ?? []).slice(0, 6), // cost cap mirrors action
      title: (row.items ?? []).map((i) => i.item_name).join(" + "),
      already_resolved: (row.resolved_items ?? []).map((x) => ({
        item_id: x.item_id,
        item_name_canonical: x.item_name_canonical,
        confidence: x.confidence,
        qty: x.qty ?? 1,
      })),
      resolution_input_hash: row.resolution_input_hash ?? "",
    }));

    return { candidates: work, inventory, bundles };
  },
});

/**
 * Single-reservation merge: append vision-detected items into resolved_items,
 * re-expand bundles, persist with method="llm+vision". One mutation per
 * Trigger run (called inside the batch loop). Public — same access scope
 * as admin_resolveBatchWrite.
 */
export const admin_writeVisionAugmentation = mutation({
  args: {
    reservation_id: v.id("reservations"),
    resolved_items: v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      confidence: v.number(),
      qty: v.optional(v.number()),
      revenue_gbp: v.optional(v.number()),
    })),
    expanded_items: v.optional(v.array(v.object({
      item_id: v.id("items"),
      item_name_canonical: v.string(),
      qty: v.number(),
      via_bundle: v.optional(v.id("bundles")),
    }))),
    input_hash: v.string(),
    // Phase 3c/W3b — which tier of the vision pipeline produced the
    // dominant resolution. Optional for backward-compatibility.
    resolved_via_tier: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { reservation_id, resolved_items, expanded_items, input_hash, resolved_via_tier },
  ) => {
    const now = Date.now();
    await ctx.db.patch(reservation_id, {
      resolved_items,
      expanded_items,
      resolution_at: now,
      resolution_method: "llm+vision",
      resolution_input_hash: input_hash,
    });
    // Phase W3b — dual-write to reservation_vision side table (with tier).
    await mirrorResolvedItemsToVisionTable(
      ctx,
      reservation_id,
      resolved_items,
      now,
      resolved_via_tier,
    );
    return { ok: true };
  },
});

/**
 * Paginated deletion of v1-imported reservations. SAFETY: defaults to
 * dryRun=true. Run admin_purgeV1Reservations({}) first to see counts.
 *
 * Pre-requisite: export-v1-to-r2 Trigger task has run AND R2 snapshots
 * + by_item / by_renter / by_month / totals indexes exist (verify in
 * R2 console at cold/v1/...). Mastra wrappers will then merge R2 data
 * into chat answers when R2_LIFETIME_MERGE=true.
 *
 * Use limit ≤ 200 per call to stay under Convex transaction limits.
 */
export const admin_purgeV1Reservations = mutation({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { dryRun, limit }) => {
    const isDry = dryRun !== false; // default true (safety)
    const cap = Math.min(Math.max(1, limit ?? 100), 200);

    // Use the by_v1_rental_id index. Convex "gt" on a string index
    // reliably returns rows whose v1_rental_id is set (UUIDs sort > '').
    const candidates = await ctx.db
      .query("reservations")
      .withIndex("by_v1_rental_id", (q) => q.gt("v1_rental_id", ""))
      .take(cap);

    if (isDry) {
      // Cheap secondary count via a wider index probe.
      const all = await ctx.db
        .query("reservations")
        .withIndex("by_v1_rental_id", (q) => q.gt("v1_rental_id", ""))
        .collect();
      return {
        ok: true,
        dryRun: true,
        wouldDeleteThisCall: candidates.length,
        wouldDeleteTotal: all.length,
        sample: candidates.slice(0, 3).map((r) => ({
          v1_rental_id: r.v1_rental_id,
          status: r.status,
          start_date: r.start_date,
          end_date: r.end_date,
          gross_paid_gbp: r.gross_paid_gbp,
        })),
      };
    }

    let purged = 0;
    for (const r of candidates) {
      await ctx.db.delete(r._id);
      purged++;
    }
    return {
      ok: true,
      dryRun: false,
      purgedThisCall: purged,
      hint: purged === cap ? "more rows remain — call again" : "pool empty",
    };
  },
});
