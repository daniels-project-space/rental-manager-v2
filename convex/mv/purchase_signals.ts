/**
 * MV: purchase_signals
 *
 * Phase 18.3 refactor: pure `computePurchaseSignals(...)` exported.
 * `refresh` / `refreshOne` internalMutations remain as thin wrappers.
 *
 * Reuses Wave 2.5 logic: groups denial_records by item_name, frequency-weights,
 * projects annual revenue at OWNER_SHARE, flags alias-of-owned via items.aliases.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { getAccountSlugs, upsertSingleton, ACCOUNT_ALL } from "./_helpers";
import { OWNER_SHARE } from "./constants";

const ASSUMED_AVG_RENTAL_DAYS = 3;
const ROI_WINDOW_DAYS = 365;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DenialRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ItemRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PricingRow = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AccountRow = any;

function normItem(s: string | undefined | null): string {
  if (!s) return "";
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export type PurchaseSignalRow = {
  itemRequested: string;
  requestCount30d: number;
  projectedAnnualGbp: number;
  aliasOfOwned: string | null;
  confidence: "high" | "med" | "low";
};

export type PurchaseSignalsAccountRow = {
  account: string;
  generatedAt: number;
  signals: PurchaseSignalRow[];
  topInsight: string;
};

/**
 * Pure compute — caller supplies denial_records, items, pricing_catalog,
 * and accounts. (All four are needed for alias-of-owned + per-account
 * denial scoping.)
 */
export function computePurchaseSignals(args: {
  denials: DenialRow[];
  items: ItemRow[];
  pricing: PricingRow[];
  accounts: AccountRow[];
  targetAccount?: string;
  generatedAt?: number;
}): PurchaseSignalsAccountRow[] {
  const { denials, items, pricing, accounts, targetAccount } = args;
  const generatedAt = args.generatedAt ?? Date.now();
  const cutoff = generatedAt - 30 * 86_400_000;

  const aliasOfOwned = new Map<string, string>();
  for (const it of items) {
    if (it.status !== "active" && it.status !== "marketing_only") continue;
    const canonicalKey = normItem(it.name_canonical);
    aliasOfOwned.set(canonicalKey, it.name_canonical);
    for (const a of it.aliases ?? []) {
      aliasOfOwned.set(normItem(a), it.name_canonical);
    }
  }

  const priceByName = new Map<string, number>();
  for (const p of pricing) {
    priceByName.set(normItem(p.item_name_canonical), p.daily_price_max);
  }

  const accountIdToSlug = new Map<string, string>();
  for (const a of accounts) accountIdToSlug.set(a._id, a.slug);

  const targets = targetAccount ? [targetAccount, ACCOUNT_ALL] : getAccountSlugs();
  const result: PurchaseSignalsAccountRow[] = [];

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
        const requestsPerMonth = a.count / 1;
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
      .filter((s) => s.aliasOfOwned === null)
      .sort((a, b) => b.projectedAnnualGbp - a.projectedAnnualGbp)
      .slice(0, 10);

    const top = signals[0];
    const topInsight = top
      ? `${top.itemRequested}: ${top.requestCount30d} unmet requests in 30d, projecting £${top.projectedAnnualGbp}/yr at owner share.`
      : scopedDenials.length === 0
        ? "No denial records yet in this window."
        : "No high-frequency unmet demand (all denials are sub-threshold or alias of owned).";

    result.push({ account, generatedAt, signals, topInsight });
  }

  void ROI_WINDOW_DAYS;
  return result;
}

/**
 * @deprecated Phase 2.1 — independent per-MV scan removed. Forwards to
 * canonical `master.refreshFast` which collects source tables ONCE and
 * fans out to all MVs (purchase_signals included). Per-account targeting
 * is lost — master always refreshes the full fleet.
 */
export const refresh = internalMutation({
  args: { account: v.optional(v.string()) },
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.mv.master.refreshFast, {});
    return { ok: true, rowsAffected: 0, durationMs: 0, scheduled: "master.refreshFast" as const };
  },
});

export const refreshOne = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account: targetAccount }) => {
    const startedAt = Date.now();
    const denials = await ctx.db.query("denial_records").collect();
    const items = await ctx.db.query("items").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const accounts = await ctx.db.query("accounts").collect();

    const computed = computePurchaseSignals({
      denials,
      items,
      pricing,
      accounts,
      targetAccount,
      generatedAt: startedAt,
    });

    let rowsAffected = 0;
    for (const row of computed) {
      await upsertSingleton(ctx, "purchase_signals", row.account, {
        generatedAt: row.generatedAt,
        signals: row.signals,
        topInsight: row.topInsight,
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
