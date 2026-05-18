/**
 * Phase 3d — internal query/mutation helpers for the backfill action.
 *
 * Split from admin_backfill_hygglo_signals.ts because that file is
 * "use node" (needs fetch with custom headers, OAuth login) and Convex
 * forbids query/mutation in Node modules.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// ── List a page of obsolete reservations pending signal backfill ─────────
export const listObsoletesPendingSignal = internalQuery({
  args: {
    limit: v.number(),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { limit, force = false },
  ): Promise<
    Array<{
      _id: string;
      hygglo_order_id: string | null;
      account_slug: string | null;
    }>
  > => {
    const out: Array<{
      _id: string;
      hygglo_order_id: string | null;
      account_slug: string | null;
    }> = [];
    let scanned = 0;
    const SCAN_CAP = Math.max(limit * 12, 800);
    for await (const r of ctx.db.query("reservations").order("desc")) {
      scanned++;
      const isObsolete = r.is_obsolete === true;
      const isCancelled = r.status === "cancelled" || r.status === "declined";
      if (!isObsolete && !isCancelled) {
        if (scanned >= SCAN_CAP) break;
        continue;
      }
      if (!force && r.hygglo_system_signal != null) {
        if (scanned >= SCAN_CAP) break;
        continue;
      }
      if (!r.hygglo_order_id) {
        if (scanned >= SCAN_CAP) break;
        continue;
      }
      out.push({
        _id: r._id as unknown as string,
        hygglo_order_id: r.hygglo_order_id ?? null,
        account_slug: r.account_slug ?? null,
      });
      if (out.length >= limit) break;
      if (scanned >= SCAN_CAP) break;
    }
    return out;
  },
});

// ── Count remaining pending rows ──────────────────────────────────────────
export const countPending = internalQuery({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force = false }): Promise<number> => {
    let count = 0;
    let scanned = 0;
    const SCAN_CAP = 2000;
    for await (const r of ctx.db.query("reservations").order("desc")) {
      scanned++;
      const isObsolete = r.is_obsolete === true;
      const isCancelled = r.status === "cancelled" || r.status === "declined";
      if (isObsolete || isCancelled) {
        if (force || r.hygglo_system_signal == null) {
          if (r.hygglo_order_id) count++;
        }
      }
      if (scanned >= SCAN_CAP) break;
    }
    return count;
  },
});

// ── Patch hygglo_system_signal on one row ─────────────────────────────────
export const patchSignal = internalMutation({
  args: {
    _id: v.id("reservations"),
    hygglo_system_signal: v.union(
      v.literal("owner_denied"),
      v.literal("renter_cancelled"),
      v.literal("auto_cancelled"),
      v.literal("verification_failed"),
      v.literal("approved"),
      v.literal("none"),
    ),
    hygglo_system_signal_text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<Doc<"reservations">> = {
      hygglo_system_signal: args.hygglo_system_signal,
    };
    if (args.hygglo_system_signal_text !== undefined) {
      patch.hygglo_system_signal_text = args.hygglo_system_signal_text;
    }
    await ctx.db.patch(args._id, patch);
  },
});
