/**
 * MV: churn_risk_renters
 *
 * Refresh interval: every 60 min. Slow-changing — renter behaviour shifts
 * over weeks, not minutes. 60 min is plenty.
 *
 * For each renter with lifetime ≥ 2 rentals:
 *   - lastRentalDaysAgo = elapsedDays since last_rental_at
 *   - risk: high if > 180d, med if > 90d, low otherwise
 *   - reason: pre-rendered narrative
 *
 * Top 30 by risk × lifetimeGbp per account.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, ACCOUNT_ALL } from "./_helpers";
import { elapsedDays } from "./constants";

export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const renters = await ctx.db.query("renters").collect();
    const reservations = await ctx.db.query("reservations").collect();

    // Per-account renter scoping: a renter "belongs" to an account if they
    // have ≥ 1 reservation under that account_slug.
    const renterAccounts = new Map<string, Set<string>>();
    for (const r of reservations) {
      if (!r.renter_id || !r.account_slug) continue;
      const set = renterAccounts.get(r.renter_id) ?? new Set();
      set.add(r.account_slug);
      renterAccounts.set(r.renter_id, set);
    }

    let rowsAffected = 0;
    for (const account of getAccountSlugs()) {
      const scoped = renters.filter((rt) => {
        if ((rt.total_rentals_count ?? 0) < 2) return false;
        if (rt.blacklisted || rt.blacklist) return false;
        if (account === ACCOUNT_ALL) return true;
        return renterAccounts.get(rt._id)?.has(account) ?? false;
      });

      const rows = scoped
        .map((rt) => {
          const lastMs = rt.last_rental_at ?? rt.first_rental_at ?? rt.created_at;
          const daysAgo = elapsedDays(lastMs, startedAt);
          const lifetimeGbp = rt.total_spend_gbp ?? 0;
          const lifetimeRentals = rt.total_rentals_count ?? 0;
          let risk: "high" | "med" | "low";
          let reason: string;
          if (daysAgo > 180) {
            risk = "high";
            reason = `${daysAgo}d since last rental (${lifetimeRentals} lifetime, £${Math.round(lifetimeGbp)}) — at high churn risk.`;
          } else if (daysAgo > 90) {
            risk = "med";
            reason = `${daysAgo}d since last rental — re-engagement window.`;
          } else {
            risk = "low";
            reason = `Active renter (${daysAgo}d since last booking).`;
          }
          return {
            renterName: rt.display_name ?? "Unknown",
            lastRentalDaysAgo: daysAgo,
            lifetimeGbp: Math.round(lifetimeGbp),
            lifetimeRentals,
            risk,
            reason,
          };
        })
        // Rank by risk weight × lifetime value
        .sort((a, b) => {
          const wA = (a.risk === "high" ? 3 : a.risk === "med" ? 2 : 1) * a.lifetimeGbp;
          const wB = (b.risk === "high" ? 3 : b.risk === "med" ? 2 : 1) * b.lifetimeGbp;
          return wB - wA;
        })
        .slice(0, 30);

      await upsertSingleton(ctx, "churn_risk_renters", account, {
        generatedAt: startedAt,
        rows,
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
      .query("churn_risk_renters")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});

