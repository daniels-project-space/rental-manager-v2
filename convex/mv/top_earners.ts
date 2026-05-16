/**
 * MV: top_earners_30d
 *
 * Phase 18.3 refactor: pure `computeTopEarners(reservations, items, ...)`
 * exported. `refresh` and `refreshOne` internalMutations remain as thin
 * wrappers for direct invocation.
 *
 * For each item: gross/net 30d, rental count, 7-day utilisation %.
 * Top 20 per account by gross.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, isoDaysAgo, todayISO, ACCOUNT_ALL } from "./_helpers";
import { OWNER_SHARE } from "./constants";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReservationRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ItemRow = any;

export type TopEarnerRow = {
  itemName: string;
  gross30dGbp: number;
  net30dGbp: number;
  rentalCount: number;
  utilizationPct: number;
};

export type TopEarnersAccountRow = {
  account: string;
  generatedAt: number;
  rows: TopEarnerRow[];
};

function computeForAccount(args: {
  account: string;
  reservations: ReservationRow[];
  items: ItemRow[];
  today: string;
  cutoff: string;
}): TopEarnerRow[] {
  const { account, reservations, items, today, cutoff } = args;
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

  return [...agg.entries()]
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
}

/**
 * Pure compute — caller supplies the 30-day reservations window + full items table.
 */
export function computeTopEarners(args: {
  reservations: ReservationRow[];
  items: ItemRow[];
  targetAccount?: string;
  generatedAt?: number;
}): TopEarnersAccountRow[] {
  const { reservations, items, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const today = todayISO();
  const cutoff = isoDaysAgo(30);
  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  return targets.map((account) => ({
    account,
    generatedAt,
    rows: computeForAccount({ account, reservations, items, today, cutoff }),
  }));
}

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const cutoff = isoDaysAgo(30);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();
    const items = await ctx.db.query("items").collect();

    const computed = computeTopEarners({
      reservations,
      items,
      targetAccount: account,
      generatedAt: startedAt,
    });

    let totalAffected = 0;
    for (const row of computed) {
      await upsertSingleton(ctx, "top_earners_30d", row.account, {
        generatedAt: row.generatedAt,
        rows: row.rows,
      });
      totalAffected += 1;
    }
    return { ok: true, rowsAffected: totalAffected, durationMs: Date.now() - startedAt };
  },
});

export const refreshOne = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    const startedAt = Date.now();
    const cutoff = isoDaysAgo(30);
    const reservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();
    const items = await ctx.db.query("items").collect();

    const computed = computeTopEarners({
      reservations,
      items,
      targetAccount: account,
      generatedAt: startedAt,
    });

    for (const row of computed) {
      await upsertSingleton(ctx, "top_earners_30d", row.account, {
        generatedAt: row.generatedAt,
        rows: row.rows,
      });
    }
    return { ok: true, rowsAffected: computed.length, durationMs: Date.now() - startedAt };
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
