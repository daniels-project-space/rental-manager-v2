/**
 * Mastra data-layer wrappers for the new convex/intel.ts queries.
 * Pure thin shims — convex query + envelope wrap.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";
import { cachedIndex } from "../../lib/r2-cold-storage";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

async function passthrough<TArgs extends object>(
  path: string,
  args: TArgs,
  source: string,
): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.intel[path], args),
      getSyncState(),
    ]);
    return wrap({ data, source, syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─── ROI / smart buy + sell ────────────────────────────────────────────────
export const getItemROIRanking = (input: { limit?: number; includeUnknownCost?: boolean }) =>
  passthrough("getItemROIRanking", {
    limit: input.limit,
    include_unknown_cost: input.includeUnknownCost,
  }, "convex.intel.getItemROIRanking");

export const getSmartSellRanking = (input: { idleDays?: number; limit?: number }) =>
  passthrough("getSmartSellRanking", {
    idle_days: input.idleDays,
    limit: input.limit,
  }, "convex.intel.getSmartSellRanking");

export const getSmartBuyRanking = (input: { days?: number; limit?: number }) =>
  passthrough("getSmartBuyRanking", input, "convex.intel.getSmartBuyRanking");

// ─── Bundles + forgotten accessories ───────────────────────────────────────
export const getBundleProfitRanking = (input: { days?: number }) =>
  passthrough("getBundleProfitRanking", input, "convex.intel.getBundleProfitRanking");

export const getForgottenAccessories = (input: {
  itemNames: string[];
  minSupportPct?: number;
  limit?: number;
}) =>
  passthrough("getForgottenAccessories", {
    item_names: input.itemNames,
    min_support_pct: input.minSupportPct,
    limit: input.limit,
  }, "convex.intel.getForgottenAccessories");

// ─── Customer intel ────────────────────────────────────────────────────────
export const getAtRiskRenters = (input: {
  inactiveDays?: number;
  minLifetimeGbp?: number;
  limit?: number;
}) =>
  passthrough("getAtRiskRenters", {
    inactive_days: input.inactiveDays,
    min_lifetime_gbp: input.minLifetimeGbp,
    limit: input.limit,
  }, "convex.intel.getAtRiskRenters");

interface R2RenterAgg {
  name: string;
  totalGross: number;
  rentalCount: number;
  firstDate: string;
  lastDate: string;
}
interface ConvexTopSpenderRow {
  renterId: string | null;
  displayName: string;
  email: string | null;
  rentalCount: number;
  grossGbp: number;
  netGbp: number;
  blacklisted: boolean;
}

/**
 * R2-aware top spenders.
 * - Convex query returns post-purge cohort (last-N-days or full table).
 * - When R2_LIFETIME_MERGE=true and the by_renter index exists, fold v1
 *   lifetime totals in by name (case-insensitive, normalised).
 * - Without the env flag this is identical to the old passthrough.
 */
export async function getTopSpenders(input: { days?: number; limit?: number }): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [convexRaw, syncState, r2Renters] = await Promise.all([
      convex.query(anyApi.intel.getTopSpenders, input),
      getSyncState(),
      process.env.R2_LIFETIME_MERGE === "true"
        ? cachedIndex<Record<string, R2RenterAgg>>("by_renter")
        : Promise.resolve(null),
    ]);
    const convexResult = convexRaw as { ok: boolean; lookbackDays: number | null; rows: ConvexTopSpenderRow[] };
    if (!convexResult.ok || !r2Renters) {
      return wrap({
        data: convexResult,
        source: "convex.intel.getTopSpenders",
        syncState,
      });
    }

    // Merge by case-insensitive name. Convex rows win when present (they
    // include richer fields: renter_id, email, blacklist flag); R2-only
    // names get appended as fresh entries.
    const norm = (s: string) => s.toLowerCase().trim();
    const byName = new Map<string, ConvexTopSpenderRow>();
    for (const r of convexResult.rows) byName.set(norm(r.displayName), r);

    for (const [, r2] of Object.entries(r2Renters)) {
      const k = norm(r2.name);
      const existing = byName.get(k);
      if (existing) {
        existing.grossGbp = Math.round((existing.grossGbp + r2.totalGross) * 100) / 100;
        existing.rentalCount += r2.rentalCount;
        existing.netGbp = Math.round(existing.netGbp * 100) / 100; // R2 has no net split — leave as Convex
      } else {
        byName.set(k, {
          renterId: null,
          displayName: r2.name,
          email: null,
          rentalCount: r2.rentalCount,
          grossGbp: r2.totalGross,
          netGbp: 0,
          blacklisted: false,
        });
      }
    }

    const merged = Array.from(byName.values())
      .sort((a, b) => b.grossGbp - a.grossGbp)
      .slice(0, input.limit ?? 15);

    return wrap({
      data: { ok: true, lookbackDays: convexResult.lookbackDays, rows: merged },
      source: "convex.intel.getTopSpenders + r2.by_renter",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export const getNewVsRepeatRevenue = (input: { days?: number }) =>
  passthrough("getNewVsRepeatRevenue", input, "convex.intel.getNewVsRepeatRevenue");

// ─── Cash flow + overdue ───────────────────────────────────────────────────
export const getCashFlowForecast = (input: { days?: number }) =>
  passthrough("getCashFlowForecast", input, "convex.intel.getCashFlowForecast");

export const getOverdueReturns = (_input: Record<string, never>) =>
  passthrough("getOverdueReturns", {}, "convex.intel.getOverdueReturns");

// ─── Seasonality / YoY / trend ─────────────────────────────────────────────
export const getItemSeasonality = (input: { itemName: string }) =>
  passthrough("getItemSeasonality", { item_name: input.itemName }, "convex.intel.getItemSeasonality");

export const getItemYoYGrowth = (input: { itemName?: string; limit?: number }) =>
  passthrough("getItemYoYGrowth", {
    item_name: input.itemName,
    limit: input.limit,
  }, "convex.intel.getItemYoYGrowth");

export const getDemandTrendSlope = (input: { months?: number; limit?: number }) =>
  passthrough("getDemandTrendSlope", input, "convex.intel.getDemandTrendSlope");

// ─── Pricing signal ────────────────────────────────────────────────────────
export const getPricingSignals = (input: { lookbackDays?: number; limit?: number }) =>
  passthrough("getPricingSignals", {
    lookback_days: input.lookbackDays,
    limit: input.limit,
  }, "convex.intel.getPricingSignals");
