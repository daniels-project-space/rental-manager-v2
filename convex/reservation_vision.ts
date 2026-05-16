/**
 * Phase W3b — reservation_vision side table helpers.
 *
 * Dual-write phase: every existing site that patches
 * `reservations.resolved_items` ALSO calls `upsertReservationVision` here.
 * Readers prefer this table (cheaper to load — narrow row, no other heavy
 * reservation fields) and fall back to the old column when the side-table
 * row is missing (back-compat during rollout).
 *
 * The old column REMAINS authoritative until a follow-up phase NULLs it.
 * If a side-table write fails, callers should log a warning and continue —
 * the primary `db.patch` is still the source of truth during migration.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

/**
 * Upsert the side-table row for a reservation. Creates the row if missing,
 * updates if present. `last_synced_at` is bumped unconditionally so the
 * backfill action can use it as an idempotency checkpoint.
 *
 * Internal — write surface is dual-write helpers only. External callers
 * should keep using the existing item_resolver / vision_resolver mutations.
 */
export const upsertReservationVision = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    resolved_items: v.optional(v.any()),
    vision_processed_at: v.optional(v.number()),
  },
  handler: async (ctx, { reservation_id, resolved_items, vision_processed_at }) => {
    const existing = await ctx.db
      .query("reservation_vision")
      .withIndex("by_reservation_id", (q) => q.eq("reservation_id", reservation_id))
      .unique();
    const now = Date.now();
    if (existing) {
      const patch: Record<string, unknown> = {
        resolved_items,
        last_synced_at: now,
      };
      if (vision_processed_at !== undefined) {
        patch.vision_processed_at = vision_processed_at;
      }
      await ctx.db.patch(existing._id, patch);
      return { ok: true, action: "updated" as const, id: existing._id };
    }
    const id = await ctx.db.insert("reservation_vision", {
      reservation_id,
      resolved_items,
      vision_processed_at,
      last_synced_at: now,
    });
    return { ok: true, action: "inserted" as const, id };
  },
});

/**
 * Single-row read. Returns the side-table row or null when no mirror exists
 * yet (caller should fall back to reservation.resolved_items).
 */
export const getReservationVision = internalQuery({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }) => {
    const row = await ctx.db
      .query("reservation_vision")
      .withIndex("by_reservation_id", (q) => q.eq("reservation_id", reservation_id))
      .unique();
    return row;
  },
});

/**
 * DataLoader-friendly batch read. Returns one entry per requested id
 * (null when missing) in the SAME ORDER as the input array so callers can
 * zip back without re-sorting.
 */
export const getReservationVisionBatch = internalQuery({
  args: { reservation_ids: v.array(v.id("reservations")) },
  handler: async (ctx, { reservation_ids }) => {
    const out = [] as Array<{
      reservation_id: typeof reservation_ids[number];
      resolved_items: unknown | undefined;
      vision_processed_at: number | undefined;
      last_synced_at: number;
    } | null>;
    for (const rid of reservation_ids) {
      const row = await ctx.db
        .query("reservation_vision")
        .withIndex("by_reservation_id", (q) => q.eq("reservation_id", rid))
        .unique();
      if (!row) {
        out.push(null);
      } else {
        out.push({
          reservation_id: row.reservation_id,
          resolved_items: row.resolved_items,
          vision_processed_at: row.vision_processed_at,
          last_synced_at: row.last_synced_at,
        });
      }
    }
    return out;
  },
});

/**
 * Public wrapper for the Next-side Mastra reader path. Same shape as the
 * internal batch query above; exposed as public so router-tools.ts can call
 * it via the Convex HTTP client (which can't reach `internal.*` refs).
 * NO write surface — read-only.
 */
export const publicGetReservationVisionBatch = query({
  args: { reservation_ids: v.array(v.id("reservations")) },
  handler: async (ctx, { reservation_ids }) => {
    const out = [] as Array<{
      reservation_id: typeof reservation_ids[number];
      resolved_items: unknown | undefined;
      vision_processed_at: number | undefined;
      last_synced_at: number;
    } | null>;
    for (const rid of reservation_ids) {
      const row = await ctx.db
        .query("reservation_vision")
        .withIndex("by_reservation_id", (q) => q.eq("reservation_id", rid))
        .unique();
      if (!row) {
        out.push(null);
      } else {
        out.push({
          reservation_id: row.reservation_id,
          resolved_items: row.resolved_items,
          vision_processed_at: row.vision_processed_at,
          last_synced_at: row.last_synced_at,
        });
      }
    }
    return out;
  },
});

/**
 * Public single-row read — used in case the reader prefers a per-id lookup
 * over batch. Same shape as the internal query.
 */
export const publicGetReservationVision = query({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }) => {
    const row = await ctx.db
      .query("reservation_vision")
      .withIndex("by_reservation_id", (q) => q.eq("reservation_id", reservation_id))
      .unique();
    return row;
  },
});

/**
 * Dual-write helper for mutation handlers. Inline (not a separate mutation)
 * because Convex mutations can't call other mutations directly — they share
 * the same `ctx.db`. Use this from every site that patches resolved_items:
 *
 *   await ctx.db.patch(reservation_id, { resolved_items, ... });
 *   await mirrorResolvedItemsToVisionTable(ctx, reservation_id, resolved_items);
 *
 * Wrapped internally in try/catch — a side-table failure logs a warning
 * but does NOT bubble up (primary patch is source of truth during dual-write).
 *
 * `ctx` is typed as `any` for ctx compatibility — Convex's auto-generated
 * GenericMutationCtx is bound to the schema's data model and is too
 * narrow to share via an exported helper signature. Internally we only
 * touch `ctx.db.query/insert/patch`, which match the real shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mirrorResolvedItemsToVisionTable(
  ctx: any,
  reservation_id: unknown,
  resolved_items: unknown,
  vision_processed_at?: number,
): Promise<void> {
  try {
    const existing = await ctx.db
      .query("reservation_vision")
      .withIndex("by_reservation_id", (q: { eq: (k: string, v: unknown) => unknown }) =>
        q.eq("reservation_id", reservation_id),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      const patch: Record<string, unknown> = {
        resolved_items,
        last_synced_at: now,
      };
      if (vision_processed_at !== undefined) {
        patch.vision_processed_at = vision_processed_at;
      }
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("reservation_vision", {
        reservation_id,
        resolved_items,
        vision_processed_at,
        last_synced_at: now,
      });
    }
  } catch (err) {
    // Dual-write — never fail the primary mutation on a side-table error.
    console.warn(
      "[reservation_vision] mirror write failed for",
      String(reservation_id),
      err instanceof Error ? err.message : String(err),
    );
  }
}
