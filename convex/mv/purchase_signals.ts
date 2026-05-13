/**
 * MV: purchase_signals
 *
 * Refresh interval: every 30 min. Driven by 30d denial_records aggregation.
 * Slow-changing surface; 30 min staleness is acceptable.
 *
 * Reuses Wave 2.5 logic: groups denial_records by item_name, frequency-weights,
 * projects annual revenue at OWNER_SHARE, flags alias-of-owned via items.aliases.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { getAccountSlugs, upsertSingleton, ACCOUNT_ALL } from "./_helpers";
import { OWNER_SHARE } from "./constants";

const ASSUMED_AVG_RENTAL_DAYS = 3;
const ROI_WINDOW_DAYS = 365;

function normItem(s: string | undefined | null): string {
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const cutoff = startedAt - 30 * 86_400_000;

    const denials = await ctx.db.query("denial_records").collect();
    const items = await ctx.db.query("items").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const accounts = await ctx.db.query("accounts").collect();

    // Build alias-of-owned lookup: normalised denial name → canonical owned name
    const aliasOfOwned = new Map<string, string>();
    for (const it of items) {
      if (it.status !== "active" && it.status !== "marketing_only") continue;
      const canonicalKey = normItem(it.name_canonical);
      aliasOfOwned.set(canonicalKey, it.name_canonical);
      for (const a of it.aliases ?? []) {
        aliasOfOwned.set(normItem(a), it.name_canonical);
      }
    }

    // Pricing lookup: normalised name → daily_price_max
    const priceByName = new Map<string, number>();
    for (const p of pricing) {
      priceByName.set(normItem(p.item_name_canonical), p.daily_price_max);
    }

    const accountIdToSlug = new Map<string, string>();
    for (const a of accounts) accountIdToSlug.set(a._id, a.slug);

    let rowsAffected = 0;
    const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
    for (const account of targets) {
      const scopedDenials = denials.filter((d) => {
        if (d.created_at < cutoff) return false;
        if (account === ACCOUNT_ALL) return true;
        const slug = d.account_id ? accountIdToSlug.get(d.account_id) : undefined;
        return slug === account;
      });

      type Agg = { displayName: string; count: number; estLost: number };
      const agg = new Map<string, Agg>();
      for (const d of scopedDenials) {
        if (!d.item_name) continue;
        const key = normItem(d.item_name);
        const cur = agg.get(key) ?? { displayName: d.item_name, count: 0, estLost: 0 };
        cur.count += 1;
        cur.estLost += d.estimated_value ?? 0;
        agg.set(key, cur);
      }

      const signals = [...agg.entries()]
        .filter(([, a]) => a.count >= 2)
        .map(([key, a]) => {
          const dailyPrice = priceByName.get(key) ?? 0;
          // Projection: (requests/month) * 12 * avgDays * dailyPrice * OWNER_SHARE
          const requestsPerMonth = a.count / 1; // 30d window ~ 1 month
          const projectedAnnualGbp =
            requestsPerMonth * 12 * ASSUMED_AVG_RENTAL_DAYS * dailyPrice * OWNER_SHARE;
          const ownedAs = aliasOfOwned.get(key) ?? null;
          const confidence: "high" | "med" | "low" =
            a.count >= 5 && dailyPrice > 0 ? "high" : a.count >= 3 ? "med" : "low";
          return {
            itemRequested: a.displayName,
            requestCount30d: a.count,
            projectedAnnualGbp: Math.round(projectedAnnualGbp),
            aliasOfOwned: ownedAs,
            confidence,
          };
        })
        .filter((s) => s.aliasOfOwned === null)        // truly unmet
        .sort((a, b) => b.projectedAnnualGbp - a.projectedAnnualGbp)
        .slice(0, 10);

      const top = signals[0];
      const topInsight = top
        ? `${top.itemRequested}: ${top.requestCount30d} unmet requests in 30d, projecting £${top.projectedAnnualGbp}/yr at owner share.`
        : scopedDenials.length === 0
          ? "No denial records yet in this window."
          : "No high-frequency unmet demand (all denials are sub-threshold or alias of owned).";

      await upsertSingleton(ctx, "purchase_signals", account, {
        generatedAt: startedAt,
        signals,
        topInsight,
      });
      rowsAffected += 1;
    }

    // Silence unused-var lint for ROI_WINDOW_DAYS — reserved for next-pass enrichment
    void ROI_WINDOW_DAYS;
    return { ok: true, rowsAffected, durationMs: Date.now() - startedAt };
  },
});

/**
 * Wave 4 — single-account variant. Same algorithm as `refresh`, scoped to
 * one account plus the `"all"` aggregate. Pure inline (no cross-function
 * call) to keep within a single Convex mutation transaction.
 */
export const refreshOne = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const cutoff = startedAt - 30 * 86_400_000;

    const denials = await ctx.db.query("denial_records").collect();
    const items = await ctx.db.query("items").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const accounts = await ctx.db.query("accounts").collect();

    const aliasOfOwned = new Map<string, string>();
    for (const it of items) {
      if (it.status !== "active" && it.status !== "marketing_only") continue;
      const canonicalKey = normItem(it.name_canonical);
      aliasOfOwned.set(canonicalKey, it.name_canonical);
      for (const a of it.aliases ?? []) aliasOfOwned.set(normItem(a), it.name_canonical);
    }
    const priceByName = new Map<string, number>();
    for (const p of pricing) priceByName.set(normItem(p.item_name_canonical), p.daily_price_max);
    const accountIdToSlug = new Map<string, string>();
    for (const a of accounts) accountIdToSlug.set(a._id, a.slug);

    let rowsAffected = 0;
    for (const account of [targetAccount, ACCOUNT_ALL]) {
      const scopedDenials = denials.filter((d) => {
        if (d.created_at < cutoff) return false;
        if (account === ACCOUNT_ALL) return true;
        const slug = d.account_id ? accountIdToSlug.get(d.account_id) : undefined;
        return slug === account;
      });

      type Agg = { displayName: string; count: number; estLost: number };
      const agg = new Map<string, Agg>();
      for (const d of scopedDenials) {
        if (!d.item_name) continue;
        const key = normItem(d.item_name);
        const cur = agg.get(key) ?? { displayName: d.item_name, count: 0, estLost: 0 };
        cur.count += 1;
        cur.estLost += d.estimated_value ?? 0;
        agg.set(key, cur);
      }

      const signals = [...agg.entries()]
        .filter(([, a]) => a.count >= 2)
        .map(([key, a]) => {
          const dailyPrice = priceByName.get(key) ?? 0;
          const requestsPerMonth = a.count / 1;
          const projectedAnnualGbp = requestsPerMonth * 12 * ASSUMED_AVG_RENTAL_DAYS * dailyPrice * OWNER_SHARE;
          const ownedAs = aliasOfOwned.get(key) ?? null;
          const confidence: "high" | "med" | "low" =
            a.count >= 5 && dailyPrice > 0 ? "high" : a.count >= 3 ? "med" : "low";
          return {
            itemRequested: a.displayName,
            requestCount30d: a.count,
            projectedAnnualGbp: Math.round(projectedAnnualGbp),
            aliasOfOwned: ownedAs,
            confidence,
          };
        })
        .filter((s) => s.aliasOfOwned === null)
        .sort((a, b) => b.projectedAnnualGbp - a.projectedAnnualGbp)
        .slice(0, 10);

      const top = signals[0];
      const topInsight = top
        ? `${top.itemRequested}: ${top.requestCount30d} unmet requests in 30d, projecting £${top.projectedAnnualGbp}/yr at owner share.`
        : scopedDenials.length === 0
          ? "No denial records yet in this window."
          : "No high-frequency unmet demand (all denials are sub-threshold or alias of owned).";

      await upsertSingleton(ctx, "purchase_signals", account, {
        generatedAt: startedAt, signals, topInsight,
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
      .query("purchase_signals")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});

