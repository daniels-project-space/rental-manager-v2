/**
 * MV: top_earners_30d
 *
 * Refresh interval: every 15 min. Heavier compute (joins items × reservations)
 * and tolerates moderate staleness — earnings change slowly over a 30-day window.
 *
 * For each item: gross/net 30d, rental count, 7-day utilisation %.
 * Top 20 per account by gross.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, isoDaysAgo, todayISO, ACCOUNT_ALL } from "./_helpers";
import { OWNER_SHARE } from "./constants";

/**
 * Pure recompute for one account. Shared by `refresh` (all accounts) and
 * `refreshOne` (Wave 4 per-account variant) — single implementation.
 */
async function recomputeForAccount(
  ctx: MutationCtx,
  account: string,
  startedAt: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reservations: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[],
  today: string,
  cutoff: string,
): Promise<void> {
  const capacityByName = new Map<string, number>();
  for (const it of items) {
    capacityByName.set(it.name_canonical, it.qty);
    for (const alias of it.aliases ?? []) {
      if (!capacityByName.has(alias)) capacityByName.set(alias, it.qty);
    }
  }
  const scoped = account === ACCOUNT_ALL
    ? reservations
    : reservations.filter((r) => r.account_slug === account);

  const earned = scoped.filter((r) => {
    if (r.status === "cancelled" || r.status === "declined") return false;
    const d = r.pickup_date ?? r.start_date;
    return d !== undefined && d >= cutoff && d <= today;
  });

  type Agg = { gross: number; net: number; count: number; rentDays: number };
  const agg = new Map<string, Agg>();
  for (const r of earned) {
    const itemCount = (r.items ?? []).length || 1;
    const perItemGross = (r.gross_paid_gbp ?? 0) / itemCount;
    const perItemNet =
      r.net_to_owner_gbp !== undefined
        ? r.net_to_owner_gbp / itemCount
        : perItemGross * OWNER_SHARE;
    const startMs = new Date(Math.max(new Date(r.start_date ?? cutoff).getTime(), new Date(cutoff).getTime())).getTime();
    const endMs = new Date(Math.min(new Date(r.end_date ?? today).getTime(), new Date(today).getTime())).getTime();
    const overlapDays = Math.max(0, Math.round((endMs - startMs) / 86_400_000) + 1);

    for (const it of r.items ?? []) {
      const cur = agg.get(it.item_name) ?? { gross: 0, net: 0, count: 0, rentDays: 0 };
      cur.gross += perItemGross;
      cur.net += perItemNet;
      cur.count += 1;
      cur.rentDays += overlapDays;
      agg.set(it.item_name, cur);
    }
  }

  const rows = [...agg.entries()]
    .map(([itemName, a]) => {
      const capacity = capacityByName.get(itemName) ?? 1;
      const utilizationPct = Math.min(
        100,
        Math.round((a.rentDays / Math.max(1, capacity * 30)) * 100),
      );
      return {
        itemName,
        gross30dGbp: Math.round(a.gross * 100) / 100,
        net30dGbp: Math.round(a.net * 100) / 100,
        rentalCount: a.count,
        utilizationPct,
      };
    })
    .sort((a, b) => b.gross30dGbp - a.gross30dGbp)
    .slice(0, 20);

  await upsertSingleton(ctx, "top_earners_30d", account, { generatedAt: startedAt, rows });
}

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(30);
    // Indexed read — only rentals whose start_date is within the 30-day
    // window. Drops ~1767 rows → ~80 rows per refresh.
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();
    const items = await ctx.db.query("items").collect();

    const targets = account ? [account, ACCOUNT_ALL] : getAccountSlugs();
    let totalAffected = 0;
    for (const acc of targets) {
      await recomputeForAccount(ctx, acc, startedAt, reservations, items, today, cutoff);
      totalAffected += 1;
    }
    return { ok: true, rowsAffected: totalAffected, durationMs: Date.now() - startedAt };
  },
});

/** Wave 4 — single-account variant. Also refreshes the `"all"` aggregate. */
export const refreshOne = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(30);
    // Indexed read — only rentals whose start_date is within the 30-day
    // window. Drops ~1767 rows → ~80 rows per refresh.
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();
    const items = await ctx.db.query("items").collect();
    for (const acc of [account, ACCOUNT_ALL]) {
      await recomputeForAccount(ctx, acc, startedAt, reservations, items, today, cutoff);
    }
    return { ok: true, rowsAffected: 2, durationMs: Date.now() - startedAt };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("top_earners_30d")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
