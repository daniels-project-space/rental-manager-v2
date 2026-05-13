/**
 * MV: utilization_today
 *
 * Refresh interval: every 15 min. Tracks per-item utilisation snapshot:
 *   - capacity (MASTER_INVENTORY qty)
 *   - rentedNow (confirmed reservations covering today)
 *   - idleDays7d
 *   - utilization7dPct
 *   - fleetUtilizationPct (top-level)
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, todayISO, isoDaysAgo, ACCOUNT_ALL } from "./_helpers";

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const today = todayISO();
    const weekAgo = isoDaysAgo(7);

    const items = await ctx.db.query("items").collect();
    const reservations = await ctx.db.query("reservations").collect();

    const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
    let rowsAffected = 0;
    for (const account of targets) {
      const scoped = account === ACCOUNT_ALL
        ? reservations
        : reservations.filter((r) => r.account_slug === account);

      const activeNow = scoped.filter(
        (r) =>
          r.status === "confirmed" &&
          r.start_date !== undefined &&
          r.end_date !== undefined &&
          (r.start_date as string) <= today &&
          (r.end_date as string) >= today,
      );

      const last7d = scoped.filter((r) => {
        if (r.status === "cancelled" || r.status === "declined") return false;
        const d = r.pickup_date ?? r.start_date;
        return d !== undefined && d >= weekAgo && d <= today;
      });

      // rentedNow per item
      const rentedNow = new Map<string, number>();
      for (const r of activeNow) {
        for (const it of r.items ?? []) {
          rentedNow.set(it.item_name, (rentedNow.get(it.item_name) ?? 0) + 1);
        }
      }

      // 7d rented-day-count per item
      const rentDays7d = new Map<string, number>();
      for (const r of last7d) {
        const start = new Date(Math.max(new Date(r.start_date ?? weekAgo).getTime(), new Date(weekAgo).getTime())).getTime();
        const end = new Date(Math.min(new Date(r.end_date ?? today).getTime(), new Date(today).getTime())).getTime();
        const overlap = Math.max(0, Math.round((end - start) / 86_400_000) + 1);
        for (const it of r.items ?? []) {
          rentDays7d.set(it.item_name, (rentDays7d.get(it.item_name) ?? 0) + overlap);
        }
      }

      const activeItems = items.filter((it) => it.status === "active" || it.status === "marketing_only");
      let totalCapacityDays = 0;
      let totalRentedDays = 0;
      const rows = activeItems.map((it) => {
        const name = it.name_canonical;
        const cap = it.qty;
        const rent7 = rentDays7d.get(name) ?? 0;
        const capDays = cap * 7;
        const utilization7dPct = Math.min(100, Math.round((rent7 / Math.max(1, capDays)) * 100));
        const idleDays7d = Math.max(0, capDays - rent7);
        totalCapacityDays += capDays;
        totalRentedDays += rent7;
        return {
          itemName: name,
          capacity: cap,
          rentedNow: rentedNow.get(name) ?? 0,
          idleDays7d,
          utilization7dPct,
        };
      })
      .sort((a, b) => b.utilization7dPct - a.utilization7dPct);

      const fleetUtilizationPct = totalCapacityDays > 0
        ? Math.round((totalRentedDays / totalCapacityDays) * 100)
        : 0;

      await upsertSingleton(ctx, "utilization_today", account, {
        generatedAt: startedAt,
        rows,
        fleetUtilizationPct,
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
      .query("utilization_today")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});

