/**
 * MV: upcoming_returns
 *
 * Phase 18.3 refactor: compute is a pure function that consumes
 * pre-collected reservation + renter arrays. The `refresh` internalMutation
 * stays as a thin wrapper for direct invocations (refresh_dispatch,
 * manual ops). master.ts uses `computeUpcomingReturns` + writeUpcomingReturns
 * to share the reservations collect across MVs.
 *
 * Windows the next 7 days ahead PLUS includes already-overdue confirmed rentals.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, todayISO, ACCOUNT_ALL } from "./_helpers";

const WINDOW_DAYS = 7;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReservationRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RenterRow = any;

export type UpcomingReturnRow = {
  rentalId: string;
  renterName: string;
  items: string[];
  returnDate: string;
  daysUntilReturn: number;
  overdue: boolean;
};

export type UpcomingReturnsAccountRow = {
  account: string;
  generatedAt: number;
  rows: UpcomingReturnRow[];
  windowDays: number;
};

/**
 * Pure compute — pass pre-collected reservations and renters.
 * Returns one row per account slug (incl. ACCOUNT_ALL).
 * Caller is responsible for writing each row via upsertSingleton.
 */
export function computeUpcomingReturns(args: {
  reservations: ReservationRow[];
  renters: RenterRow[];
  targetAccount?: string;
  generatedAt?: number;
}): UpcomingReturnsAccountRow[] {
  const { reservations, renters, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const today = todayISO();
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);
  const windowEndStr = windowEnd.toISOString().slice(0, 10);

  const rentersById = new Map<string, RenterRow>();
  for (const rt of renters) rentersById.set(rt._id, rt);

  const confirmed = reservations.filter((r) => r.status === "confirmed");
  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  const result: UpcomingReturnsAccountRow[] = [];

  for (const account of targets) {
    const scoped = account === ACCOUNT_ALL
      ? confirmed
      : confirmed.filter((r) => r.account_slug === account);

    const inWindow = scoped.filter((r) => {
      if (!r.end_date) return false;
      return r.end_date <= windowEndStr;
    });

    const rows: UpcomingReturnRow[] = inWindow.map((r) => {
      let renterName = r.renter_name ?? "Unknown";
      if (renterName === "Unknown" && r.renter_id) {
        const rt = rentersById.get(r.renter_id);
        renterName = rt?.display_name ?? "Unknown";
      }
      const endMs = new Date(r.end_date as string).getTime();
      const todayMs = new Date(today).getTime();
      const daysUntilReturn = Math.round((endMs - todayMs) / 86_400_000);
      const overdue = (r.end_date as string) < today;
      return {
        rentalId: r._id,
        renterName,
        items: (r.items ?? []).map((i: { item_name: string }) => i.item_name),
        returnDate: r.end_date as string,
        daysUntilReturn,
        overdue,
      };
    });

    rows.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return a.daysUntilReturn - b.daysUntilReturn;
    });

    result.push({ account, generatedAt, rows, windowDays: WINDOW_DAYS });
  }

  return result;
}

/**
 * Thin wrapper preserved for back-compat with refresh_dispatch + manual ops.
 * master.ts bypasses this and uses the pure compute + write mutation.
 */
export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();
    const renters = await ctx.db.query("renters").collect();

    const computed = computeUpcomingReturns({
      reservations,
      renters,
      targetAccount,
      generatedAt: startedAt,
    });

    let rowsAffected = 0;
    for (const row of computed) {
      await upsertSingleton(ctx, "upcoming_returns", row.account, {
        generatedAt: row.generatedAt,
        rows: row.rows,
        windowDays: row.windowDays,
      });
      rowsAffected += 1;
    }

    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("upcoming_returns")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
