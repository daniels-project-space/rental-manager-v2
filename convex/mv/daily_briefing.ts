/**
 * MV: daily_briefing
 *
 * Refresh interval: every 5 min (most-stale-sensitive — drives chat
 * "what happened today" answers). One row per account slug.
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

function computeForAccount(args: {
  account: string;
  reservations: Array<{
    status: string;
    start_date?: string;
    end_date?: string;
    pickup_date?: string;
    account_slug?: string;
    gross_paid_gbp?: number;
    items?: Array<{ item_name: string }>;
  }>;
  today: string;
}): {
  todayEarningsGbp: number;
  activeRentalsCount: number;
  pendingRequestsCount: number;
  overdueReturnsCount: number;
  topItemsToday: ItemTotal[];
  summary: string;
} {
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

  // Top items by gbp earned today
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
 * Internal mutation — runs the full refresh transactionally.
 * Reads all reservations (one collect — small table) and upserts one row
 * per account slug.
 */
export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const today = todayISO();
    // 90-day rolling window. daily_briefing reports today's earnings +
    // active rentals (start_date<=today<=end_date) + 'this month' counters.
    // Anything older than 90 days can't appear in those buckets. Indexed
    // read drops ~1767 rows → ~200 rows per refresh.
    const cutoff = isoDaysAgo(90);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    const targets = account ? [account, ACCOUNT_ALL] : getAccountSlugs();
    let rowsAffected = 0;
    for (const acc of targets) {
      const computed = computeForAccount({ account: acc, reservations, today });
      await upsertSingleton(ctx, "daily_briefing", acc, {
        generatedAt: startedAt,
        ...computed,
      });
      rowsAffected += 1;
    }

    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

/**
 * Wave 4 — single-account refresh entry point. Recomputes the targeted
 * account row PLUS the cross-account `"all"` row (changing one account
 * always shifts the aggregate). Delegates to `refresh`.
 */
export const refreshOne = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(90);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();

    let rowsAffected = 0;
    for (const acc of [account, ACCOUNT_ALL]) {
      const computed = computeForAccount({ account: acc, reservations, today });
      await upsertSingleton(ctx, "daily_briefing", acc, {
        generatedAt: startedAt,
        ...computed,
      });
      rowsAffected += 1;
    }
    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

/**
 * Public query — read the latest singleton row for an account.
 * Falls back to `"all"` if no account passed.
 */
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

