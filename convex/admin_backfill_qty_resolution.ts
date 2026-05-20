/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Layer C (2026-05-19) — one-shot qty-resolution backfill.
 *
 *  Finds reservations where the per-listing resolver (Layer A fix in
 *  src/trigger/resolve-items.ts) under-counted Hygglo's raw items[] array:
 *
 *    items.length > 1
 *    AND (expanded_items.length < items.length
 *         OR sum(expanded_items[].qty) < items.length)
 *
 *  For each such row clears `resolution_input_hash` (the cache-key that the
 *  resolver checks before re-running) so the next resolver pass treats the row
 *  as a cache miss and re-resolves with the fixed per-listing logic.
 *
 *  Run:
 *    npx convex run admin_backfill_qty_resolution:run '{}'
 *
 *  Idempotent: re-running once the resolver catches up clears 0 rows.
 *  Bound by SAFETY_LIMIT (default 200) so a runaway can't nuke the entire DB.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { titleHash } from "./listing_cache";

const SAFETY_LIMIT = 200;

export const run = internalMutation({
  args: {
    limit: v.optional(v.number()),
    dry_run: v.optional(v.boolean()),
    // active_multi_listing=true (default): clear ALL active multi-listing rows
    // so the per-listing resolver fix (Layer A) re-resolves them. Required
    // because the old single-shot resolver collapsed same-SKU multi-listing
    // orders (Olivia 3928504: 2x FX3 listings → expanded qty:1 each, not 2).
    // active_multi_listing=false: only clear rows where current expanded sum
    // is provably < items.length (cheaper, but misses same-SKU collapses).
    active_multi_listing: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { limit = SAFETY_LIMIT, dry_run = false, active_multi_listing = true },
  ) => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await ctx.db.query("reservations").collect();
    const candidates: Array<{
      id: typeof rows[number]["_id"];
      hygglo_order_id: string;
      items_len: number;
      expanded_len: number;
      expanded_sum: number;
    }> = [];
    let skipped_v1_legacy = 0;
    let skipped_inactive = 0;
    let skipped_no_drift = 0;
    for (const r of rows) {
      if (!Array.isArray(r.items) || r.items.length <= 1) continue;
      // Skip v1-imported legacy rows — resolver only handles hygglo-poll rows.
      if (!r.hygglo_order_id) {
        skipped_v1_legacy++;
        continue;
      }
      const expanded = Array.isArray(r.expanded_items) ? r.expanded_items : [];
      const expandedLen = expanded.length;
      const expandedSum = expanded.reduce((s, e) => s + (e.qty ?? 0), 0);

      let select: boolean;
      if (active_multi_listing) {
        // Active = status=confirmed, not obsolete, end_date >= today.
        // Multi-listing rows resolved BEFORE Layer A may have under-counted
        // when multiple listings collapsed to the same SKU.
        const active =
          r.status === "confirmed" &&
          !r.is_obsolete &&
          typeof r.end_date === "string" &&
          (r.end_date as string) >= today;
        if (!active) {
          skipped_inactive++;
          continue;
        }
        select = true;
      } else {
        const drift =
          expandedLen < r.items.length || expandedSum < r.items.length;
        if (!drift) {
          skipped_no_drift++;
          continue;
        }
        select = true;
      }
      if (!select) continue;
      candidates.push({
        id: r._id,
        hygglo_order_id: String(r.hygglo_order_id),
        items_len: r.items.length,
        expanded_len: expandedLen,
        expanded_sum: expandedSum,
      });
      if (candidates.length >= limit) break;
    }

    // Safety: if drift count is huge, bail and surface for human review.
    if (candidates.length >= SAFETY_LIMIT) {
      return {
        cleared: 0,
        sample_count: candidates.length,
        warning:
          `drift count >= ${SAFETY_LIMIT}; aborting auto-backfill. ` +
          "Inspect qty_drift_alerts and re-run with explicit limit.",
        hygglo_order_ids: candidates.slice(0, 20).map((c) => c.hygglo_order_id),
      };
    }

    let cleared = 0;
    let listing_cache_rows_deleted = 0;
    const cleared_ids: string[] = [];
    for (const c of candidates) {
      const row = await ctx.db.get(c.id);
      if (!row) continue;
      if (!dry_run) {
        // Clear `resolution_input_hash` so the next resolver run treats this
        // row as cache-miss. Don't touch `expanded_items`/`resolved_items` —
        // the resolver will overwrite them on its next pass.
        await ctx.db.patch(c.id, { resolution_input_hash: undefined });

        // Also bust the title-hash listing_resolutions cache so the resolver
        // doesn't immediately return the OLD pre-Layer-A collapsed result.
        // Computed from the row's items[] (same key the resolver uses).
        const itemsForHash = (row.items ?? []) as Array<{ item_name: string }>;
        if (itemsForHash.length > 0) {
          const tHash = titleHash(itemsForHash);
          const cacheRows = await ctx.db
            .query("listing_resolutions")
            .withIndex("by_title_hash", (q) => q.eq("title_hash", tHash))
            .collect();
          for (const cr of cacheRows) {
            await ctx.db.delete(cr._id);
            listing_cache_rows_deleted++;
          }
        }
      }
      cleared++;
      if (cleared_ids.length < 20) cleared_ids.push(c.hygglo_order_id);
    }

    return {
      cleared,
      dry_run,
      hygglo_order_ids_sample: cleared_ids,
      total_candidates: candidates.length,
      skipped_v1_legacy,
      skipped_inactive,
      skipped_no_drift,
      listing_cache_rows_deleted,
      mode: active_multi_listing ? "active_multi_listing" : "drift_only",
    };
  },
});
