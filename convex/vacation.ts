/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Vacation Mode — GLOBAL switch across ALL accounts.
 *  Waves 0 + 1: schema + queries/mutations.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Design (Daniel-approved):
 *  - GLOBAL: one row affects every account (DB Cinema, Vertus, Daniel, Leo).
 *    Intentionally NO account_slug field.
 *  - On save: BLOCK if any CONFIRMED reservation overlaps the window unless
 *    force:true. FLAG (don't auto-decline) PENDING (isPendingVerification)
 *    reservations — return them so the UI can surface them.
 *  - Day-granularity. Timezone Europe/London. Dates stored as YYYY-MM-DD.
 *  - Soft-cancel via is_active=false (keeps audit trail).
 */

import { query, mutation, internalQueryOf, internalMutationOf } from "./owner_functions";
import { v } from "convex/values";
import {
  isConfirmedWithDates,
  isPendingVerification,
  netOf,
} from "./lib/reservations/predicates";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { loadStockSources, stockForItem, validIsoDate } from "./lib/renter_stock";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Europe/London, YYYY-MM-DD. */
function todayLondon(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

/** Add `n` days (can be negative) to a YYYY-MM-DD string, returning YYYY-MM-DD. */
function addDays(ymd: string, n: number): string {
  // Parse as UTC to avoid TZ drift — we only care about the calendar arithmetic.
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Inclusive day-difference between two YYYY-MM-DD strings (b - a + 1). */
function diffDaysInclusive(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const at = Date.UTC(ay, am - 1, ad);
  const bt = Date.UTC(by, bm - 1, bd);
  return Math.max(1, Math.round((bt - at) / 86_400_000) + 1);
}

type ConflictRow = {
  reservation_id: Id<"reservations">;
  hygglo_id?: string;
  renter_name?: string;
  start_date: string;
  end_date: string;
  status: string;
  total_gbp: number;
};

/** Compute confirmed/pending reservation conflicts against [start, end] window. */
async function computeConflicts(
  ctx: QueryCtx,
  start_date: string,
  end_date: string,
): Promise<{ confirmed: ConflictRow[]; pending: ConflictRow[] }> {
  // Phase 2.1 — bounded scan. A reservation overlaps [start_date, end_date]
  // iff `r.start_date <= end_date && r.end_date >= start_date`. The schema
  // only indexes `start_date`, so we widen the lower bound by the longest
  // plausible rental (90d) to catch reservations that started before the
  // window but extend into it. Drops a ~2y full-table scan to a windowed
  // slice of ~weeks-to-months worth of reservations.
  const lowerBound = addDays(start_date, -90);
  const all = await ctx.db
    .query("reservations")
    .withIndex("by_start_date", (q) =>
      q.gte("start_date", lowerBound).lte("start_date", end_date),
    )
    .collect();
  const confirmed: ConflictRow[] = [];
  const pending: ConflictRow[] = [];

  for (const r of all) {
    if (r.is_obsolete) continue;
    if (!r.start_date || !r.end_date) continue;
    // YYYY-MM-DD strings sort lexicographically, so string-compare is safe.
    const overlaps = r.start_date <= end_date && r.end_date >= start_date;
    if (!overlaps) continue;

    const row: ConflictRow = {
      reservation_id: r._id,
      hygglo_id: r.hygglo_order_id,
      renter_name: r.renter_name,
      start_date: r.start_date,
      end_date: r.end_date,
      status: r.status,
      total_gbp: netOf(r),
    };

    if (isConfirmedWithDates(r)) confirmed.push(row);
    else if (isPendingVerification(r)) pending.push(row);
  }

  return { confirmed, pending };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export const getActiveVacations = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("vacation_periods"),
      start_date: v.string(),
      end_date: v.string(),
      reason: v.optional(v.string()),
      created_at: v.number(),
      created_by: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("vacation_periods")
      .withIndex("by_active_start", (q) => q.eq("is_active", true))
      .order("asc")
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      start_date: r.start_date,
      end_date: r.end_date,
      reason: r.reason,
      created_at: r.created_at,
      created_by: r.created_by,
    }));
  },
});

const conflictRowValidator = v.object({
  reservation_id: v.id("reservations"),
  hygglo_id: v.optional(v.string()),
  renter_name: v.optional(v.string()),
  start_date: v.string(),
  end_date: v.string(),
  status: v.string(),
  total_gbp: v.number(),
});

export const checkVacationConflicts = query({
  args: {
    start_date: v.string(),
    end_date: v.string(),
  },
  returns: v.object({
    confirmed: v.array(conflictRowValidator),
    pending: v.array(conflictRowValidator),
  }),
  handler: async (ctx, args) => {
    return await computeConflicts(ctx, args.start_date, args.end_date);
  },
});

export const isVacationActiveOn = query({
  args: { date: v.string() },
  returns: v.object({
    active: v.boolean(),
    vacation: v.optional(
      v.object({
        _id: v.id("vacation_periods"),
        start_date: v.string(),
        end_date: v.string(),
        reason: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("vacation_periods")
      .withIndex("by_active_start", (q) => q.eq("is_active", true))
      .collect();
    const hit = rows.find(
      (v) => v.start_date <= args.date && v.end_date >= args.date,
    );
    if (!hit) return { active: false };
    return {
      active: true,
      vacation: {
        _id: hit._id,
        start_date: hit.start_date,
        end_date: hit.end_date,
        reason: hit.reason,
      },
    };
  },
});

/**
 * Find closest free slice of `requested length` before/after the vacation that
 * conflicts with the requested window.
 *
 * Returns inVacation=false if the requested window doesn't overlap any active
 * vacation — caller should fall back to normal availability logic.
 */
export const getClosestAvailableDates = query({
  args: {
    requested_start: v.string(),
    requested_end: v.string(),
    requested_qty: v.optional(v.number()),
    item_id: v.optional(v.id("items")),
  },
  returns: v.object({
    inVacation: v.boolean(),
    vacationPeriod: v.optional(
      v.object({ start: v.string(), end: v.string() }),
    ),
    alternative_stock_scope: v.union(v.literal("physical_item"), v.literal("not_checked")),
    availability_guidance: v.string(),
    before: v.optional(v.object({ start: v.string(), end: v.string() })),
    after: v.optional(v.object({ start: v.string(), end: v.string() })),
  }),
  handler: async (ctx, args) => {
    const today = todayLondon();
    const reqQty = args.requested_qty ?? 1;
    if (!validIsoDate(args.requested_start) || !validIsoDate(args.requested_end) ||
        args.requested_end < args.requested_start || !Number.isInteger(reqQty) || reqQty < 1 || reqQty > 20 ||
        diffDaysInclusive(args.requested_start, args.requested_end) > 366) {
      throw new Error("Supply valid ordered ISO dates (at most 366 days) and an integer quantity from 1 to 20.");
    }
    const len = diffDaysInclusive(args.requested_start, args.requested_end);
    const alternative_stock_scope = args.item_id ? "physical_item" as const : "not_checked" as const;
    const availability_guidance = "This is a vacation calendar check, not confirmation of the requested rental. Alternative windows without an item have no stock check. With an item, only that physical item's requested units are checked. Before offering dates, check the exact complete listing/basket, its kit components, current booking context and prices through the rental availability/quote tools.";

    // 1. Find first active vacation overlapping the request.
    const vacations = await ctx.db
      .query("vacation_periods")
      .withIndex("by_active_start", (q) => q.eq("is_active", true))
      .collect();
    const overlapping = vacations.find(
      (v) =>
        v.start_date <= args.requested_end &&
        v.end_date >= args.requested_start,
    );
    if (!overlapping) return { inVacation: false, alternative_stock_scope: "not_checked" as const, availability_guidance };

    // A calendar opening is not a business-wide stock verdict. When a
    // physical item is supplied, use the same snapshot as renter availability.
    // Never reload reservations and inventory for every candidate day.
    const sources = args.item_id ? await loadStockSources(ctx) : null;
    const item = sources?.items.find(i => i._id === args.item_id);
    const isWindowFree = (s: string, e: string): boolean => {
      if (vacations.some(v => v.start_date <= e && v.end_date >= s)) return false;
      if (!args.item_id) return true;
      return !!item && !!sources && stockForItem(sources, item, {
        item_name: item.name_canonical, start_date: s, end_date: e, quantity: reqQty,
      }).available === true;
    };

    // 4. Look back up to 30 days for "before" slot ending on or before
    //    vacation_start - 1. Try the latest-ending window first.
    let before: { start: string; end: string } | undefined;
    const dayBefore = addDays(overlapping.start_date, -1);
    for (let offset = 0; offset <= 30; offset++) {
      const candEnd = addDays(dayBefore, -offset);
      const candStart = addDays(candEnd, -(len - 1));
      if (candEnd < today) break; // entirely in the past — stop
      if (candStart < today) continue;
      if (isWindowFree(candStart, candEnd)) {
        before = { start: candStart, end: candEnd };
        break;
      }
    }

    // 5. Look forward up to 30 days for "after" slot starting on or after
    //    vacation_end + 1. Try the earliest-starting window first.
    let after: { start: string; end: string } | undefined;
    const dayAfter = addDays(overlapping.end_date, 1);
    for (let offset = 0; offset <= 30; offset++) {
      const candStart = addDays(dayAfter, offset);
      const candEnd = addDays(candStart, len - 1);
      if (candStart < today) continue;
      if (isWindowFree(candStart, candEnd)) {
        after = { start: candStart, end: candEnd };
        break;
      }
    }

    return {
      inVacation: true,
      alternative_stock_scope,
      availability_guidance,
      vacationPeriod: {
        start: overlapping.start_date,
        end: overlapping.end_date,
      },
      before,
      after,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export const setVacation = mutation({
  args: {
    start_date: v.string(),
    end_date: v.string(),
    reason: v.optional(v.string()),
    force: v.optional(v.boolean()),
    created_by: v.optional(v.string()),
  },
  returns: v.object({
    _id: v.id("vacation_periods"),
    pending_conflicts: v.array(conflictRowValidator),
  }),
  handler: async (ctx, args) => {
    // 1. Format validation
    if (!YMD_RE.test(args.start_date) || !YMD_RE.test(args.end_date)) {
      throw new Error(
        `Invalid date format: expected YYYY-MM-DD, got start=${args.start_date} end=${args.end_date}`,
      );
    }
    if (args.start_date > args.end_date) {
      throw new Error(
        `start_date (${args.start_date}) must be <= end_date (${args.end_date})`,
      );
    }
    // 2. Cannot start in the past (Europe/London)
    const today = todayLondon();
    if (args.start_date < today) {
      throw new Error(
        `Cannot set vacation starting in the past: start_date=${args.start_date} today(London)=${today}`,
      );
    }

    // 3. Conflict check
    const { confirmed, pending } = await computeConflicts(
      ctx,
      args.start_date,
      args.end_date,
    );

    // 4. Block on confirmed unless force
    if (confirmed.length > 0 && !args.force) {
      // Stash structured info in the error message so the dashboard mutation
      // wrapper can parse it (Convex Errors collapse to .message on the wire).
      const payload = JSON.stringify({
        code: "CONFIRMED_CONFLICTS",
        confirmed,
        pending,
      });
      throw new Error(payload);
    }

    // 5. Insert (force-create even on confirmed conflicts when force=true —
    //    Daniel keeps both: the vacation row AND the confirmed bookings).
    const _id = await ctx.db.insert("vacation_periods", {
      start_date: args.start_date,
      end_date: args.end_date,
      reason: args.reason,
      created_at: Date.now(),
      created_by: args.created_by ?? "dashboard",
      is_active: true,
    });

    return { _id, pending_conflicts: pending };
  },
});

export const cancelVacation = mutation({
  args: { vacation_id: v.id("vacation_periods") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.vacation_id, { is_active: false });
    return null;
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_getActiveVacations = internalQueryOf(getActiveVacations);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_checkVacationConflicts = internalQueryOf(checkVacationConflicts);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_setVacation = internalMutationOf(setVacation);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_cancelVacation = internalMutationOf(cancelVacation);
