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
import { getAccountSlugs, upsertSingleton, isoDaysAgo, todayISO, ACCOUNT_ALL } from "./_helpers";
import { OWNER_SHARE } from "./constants";

export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const today = todayISO();
    const cutoff = isoDaysAgo(30);
    const reservations = await ctx.db.query("reservations").collect();
    const items = await ctx.db.query("items").collect();

    // Capacity lookup: item_name → MASTER_INVENTORY qty
    const capacityByName = new Map<string, number>();
    for (const it of items) {
      capacityByName.set(it.name_canonical, it.qty);
      for (const alias of it.aliases ?? []) {
        if (!capacityByName.has(alias)) capacityByName.set(alias, it.qty);
      }
    }

    let totalAffected = 0;
    for (const account of getAccountSlugs()) {
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
        // Days in 30d window this rental contributed
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
          // 7-day utilisation proxy: rentDays in last 30d / (capacity * 30)
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

      await upsertSingleton(ctx, "top_earners_30d", account, {
        generatedAt: startedAt,
        rows,
      });
      totalAffected += 1;
    }

    return { ok: true, rowsAffected: totalAffected, durationMs: Date.now() - startedAt };
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

