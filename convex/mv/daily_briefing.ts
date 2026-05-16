/**
 * MV: daily_briefing
 *
 * Phase 18.3 refactor: pure `computeDailyBriefing(reservations,...)` exported.
 * `refresh` and `refreshOne` internalMutations remain as thin wrappers.
 *
 * Computes today's earnings, active rentals, pending requests, overdue
 * returns, top 3 items today, and a pre-rendered narrative.
 *
 * Reuses denormalised reservation fields — never recomputes platform fees;
 * trusts `gross_paid_gbp` / `net_to_owner_gbp` from poller.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, todayISO, isoDaysAgo, ACCOUNT_ALL } from "./_helpers";

type ItemTotal = { name: string; gbp: number; count: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReservationRow = any;

export type DailyBriefingAccountRow = {
  account: string;
  generatedAt: number;
  todayEarningsGbp: number;
  activeRentalsCount: number;
  pendingRequestsCount: number;
  overdueReturnsCount: number;
  topItemsToday: ItemTotal[];
  summary: string;
};

function computeForAccount(args: {
  account: string;
  reservations: ReservationRow[];
  today: string;
}): Omit<DailyBriefingAccountRow, "account" | "generatedAt"> {
  const { account, reservations, today } = args;
  const scoped = account === ACCOUNT_ALL ? reservations : reservations.filter((r) => r.account_slug === account);

  const effectiveDate = (r: { start_date?: string; pickup_date?: string }) =>
    r.pickup_date ?? r.start_date;

  const earnedToday = scoped.filter(
    (r) =>
      r.status !== "cancelled" &&
      r.status !== "declined" &&
      effectiveDate(r) === today,
  );
  const todayEarningsGbp = earnedToday.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);

  const confirmed = scoped.filter(
    (r) => r.status === "confirmed" && r.start_date !== undefined && r.end_date !== undefined,
  );
  const activeRentalsCount = confirmed.filter(
    (r) => (r.start_date as string) <= today && (r.end_date as string) >= today,
  ).length;
  const overdueReturnsCount = confirmed.filter((r) => (r.end_date as string) < today).length;
  const pendingRequestsCount = scoped.filter((r) => r.status === "pending_review").length;

  const itemMap = new Map<string, ItemTotal>();
  for (const r of earnedToday) {
    const itemCount = (r.items ?? []).length || 1;
    const perItemGbp = (r.gross_paid_gbp ?? 0) / itemCount;
    for (const it of r.items ?? []) {
      const existing = itemMap.get(it.item_name);
      if (existing) {
        existing.gbp += perItemGbp;
        existing.count += 1;
      } else {
        itemMap.set(it.item_name, { name: it.item_name, gbp: perItemGbp, count: 1 });
      }
    }
  }
  const topItemsToday = [...itemMap.values()].sort((a, b) => b.gbp - a.gbp).slice(0, 3);

  const summary =
    todayEarningsGbp > 0
      ? `Today: £${todayEarningsGbp.toFixed(0)} from ${earnedToday.length} rental${earnedToday.length === 1 ? "" : "s"}. ` +
        `${activeRentalsCount} active, ${pendingRequestsCount} pending, ${overdueReturnsCount} overdue.`
      : `No earnings today yet. ${activeRentalsCount} active rentals, ${pendingRequestsCount} pending requests` +
        (overdueReturnsCount > 0 ? `, ${overdueReturnsCount} overdue returns.` : ".");

  return {
    todayEarningsGbp,
    activeRentalsCount,
    pendingRequestsCount,
    overdueReturnsCount,
    topItemsToday,
    summary,
  };
}

/**
 * Pure compute — pass pre-collected 90-day reservations window.
 * Returns one row per account slug.
 */
export function computeDailyBriefing(args: {
  reservations: ReservationRow[];
  targetAccount?: string;
  generatedAt?: number;
}): DailyBriefingAccountRow[] {
  const { reservations, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const today = todayISO();
  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  return targets.map((account) => ({
    account,
    generatedAt,
    ...computeForAccount({ account, reservations, today }),
  }));
}

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const cutoff = isoDaysAgo(90);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const computed = computeDailyBriefing({
      reservations,
      targetAccount: account,
      generatedAt: startedAt,
    });

    let rowsAffected = 0;
    for (const row of computed) {
      const { account: acc, generatedAt: ts, ...rest } = row;
      await upsertSingleton(ctx, "daily_briefing", acc, { generatedAt: ts, ...rest });
      rowsAffected += 1;
    }

    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

export const refreshOne = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const cutoff = isoDaysAgo(90);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const computed = computeDailyBriefing({
      reservations,
      targetAccount: account,
      generatedAt: startedAt,
    });

    let rowsAffected = 0;
    for (const row of computed) {
      const { account: acc, generatedAt: ts, ...rest } = row;
      await upsertSingleton(ctx, "daily_briefing", acc, { generatedAt: ts, ...rest });
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
      .query("daily_briefing")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
