/**
 * MV: churn_risk_renters
 *
 * Phase 18.3 refactor: pure `computeChurnRisk(renters, reservations, ...)`
 * exported. `refresh` internalMutation remains as a thin wrapper.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReservationRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RenterRow = any;

export type ChurnRiskRow = {
  renterName: string;
  lastRentalDaysAgo: number;
  lifetimeGbp: number;
  lifetimeRentals: number;
  risk: "high" | "med" | "low";
  reason: string;
};

export type ChurnRiskAccountRow = {
  account: string;
  generatedAt: number;
  rows: ChurnRiskRow[];
};

/**
 * Pure compute — caller supplies full renters + full reservations.
 * (Renters need cross-account reservation membership lookup, so we
 * accept the full reservations array.)
 */
export function computeChurnRisk(args: {
  renters: RenterRow[];
  reservations: ReservationRow[];
  targetAccount?: string;
  generatedAt?: number;
}): ChurnRiskAccountRow[] {
  const { renters, reservations, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();

  const renterAccounts = new Map<string, Set<string>>();
  for (const r of reservations) {
    if (!r.renter_id || !r.account_slug) continue;
    const set = renterAccounts.get(r.renter_id) ?? new Set<string>();
    set.add(r.account_slug);
    renterAccounts.set(r.renter_id, set);
  }

  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  const result: ChurnRiskAccountRow[] = [];

  for (const account of targets) {
    const scoped = renters.filter((rt) => {
      if ((rt.total_rentals_count ?? 0) < 2) return false;
      if (rt.blacklisted || rt.blacklist) return false;
      if (account === ACCOUNT_ALL) return true;
      return renterAccounts.get(rt._id)?.has(account) ?? false;
    });

    const rows: ChurnRiskRow[] = scoped
      .map((rt) => {
        const lastMs = rt.last_rental_at ?? rt.first_rental_at ?? rt.created_at;
        const daysAgo = elapsedDays(lastMs, generatedAt);
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
      .sort((a, b) => {
        const wA = (a.risk === "high" ? 3 : a.risk === "med" ? 2 : 1) * a.lifetimeGbp;
        const wB = (b.risk === "high" ? 3 : b.risk === "med" ? 2 : 1) * b.lifetimeGbp;
        return wB - wA;
      })
      .slice(0, 30);

    result.push({ account, generatedAt, rows });
  }

  return result;
}

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const renters = await ctx.db.query("renters").collect();
    const reservations = await ctx.db.query("reservations").collect();

    const computed = computeChurnRisk({
      renters,
      reservations,
      targetAccount,
      generatedAt: startedAt,
    });

    let rowsAffected = 0;
    for (const row of computed) {
      await upsertSingleton(ctx, "churn_risk_renters", row.account, {
        generatedAt: row.generatedAt,
        rows: row.rows,
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
