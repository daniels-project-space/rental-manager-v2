/**
 * Mastra data-layer wrappers for the new convex/intel.ts queries.
 * Pure thin shims — convex query + envelope wrap.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

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

export const getTopSpenders = (input: { days?: number; limit?: number }) =>
  passthrough("getTopSpenders", input, "convex.intel.getTopSpenders");

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
