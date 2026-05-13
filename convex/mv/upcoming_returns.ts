/**
 * MV: upcoming_returns
 *
 * Refresh interval: every 10 min. Drives "returns due this week" surface
 * in dashboard chat + renter-bot. 10 min is the sweet spot between
 * fresh-after-poll and acceptable cron load.
 *
 * Windows the next 7 days ahead PLUS includes already-overdue confirmed rentals.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, todayISO, ACCOUNT_ALL } from "./_helpers";

const WINDOW_DAYS = 7;

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + WINDOW_DAYS);
    const windowEndStr = windowEnd.toISOString().slice(0, 10);

    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();

    const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
    let rowsAffected = 0;
    for (const account of targets) {
      const scoped = account === ACCOUNT_ALL
        ? reservations
        : reservations.filter((r) => r.account_slug === account);

      const inWindow = scoped.filter((r) => {
        if (!r.end_date) return false;
        // Include overdue (end_date < today) + future within window
        return r.end_date <= windowEndStr;
      });

      const rows = await Promise.all(
        inWindow.map(async (r) => {
          let renterName = r.renter_name ?? "Unknown";
          if (renterName === "Unknown" && r.renter_id) {
            const rt = await ctx.db.get(r.renter_id);
            renterName = rt?.display_name ?? "Unknown";
          }
          const endMs = new Date(r.end_date as string).getTime();
          const todayMs = new Date(today).getTime();
          const daysUntilReturn = Math.round((endMs - todayMs) / 86_400_000);
          const overdue = (r.end_date as string) < today;
          return {
            rentalId: r._id,
            renterName,
            items: (r.items ?? []).map((i) => i.item_name),
            returnDate: r.end_date as string,
            daysUntilReturn,
            overdue,
          };
        }),
      );

      // Sort: overdue first (most overdue first), then by daysUntilReturn ascending
      rows.sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return a.daysUntilReturn - b.daysUntilReturn;
      });

      await upsertSingleton(ctx, "upcoming_returns", account, {
        generatedAt: startedAt,
        rows,
        windowDays: WINDOW_DAYS,
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

