/**
 * Lost-revenue reads + denial recording.
 *
 * V1 mirror: src/lost-revenue/lost-revenue.service.ts (549 / 635 / 959 / 1171).
 *
 * Wave 2 status:
 *   - getSummary       → wraps convex.revenue.getMissedRevenue (READY)
 *   - recordDenial     → wraps convex.denial_records.createDenial (READY)
 *
 * Wave 2.5 (this PR):
 *   - getUnmatchedDemand          → wraps convex.lost_revenue.getUnmatchedDemand (READY)
 *   - getSubstitutionPatterns     → wraps convex.lost_revenue.getSubstitutionPatterns (READY)
 *   - getPurchaseRecommendations  → wraps convex.lost_revenue.getPurchaseRecommendations (READY)
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";
import { validateAccount, type AccountSlug } from "./account-scope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

const DAYS_PER_RANGE: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "6m": 180,
  "1y": 365,
};

function rangeToDays(range?: string): number {
  return DAYS_PER_RANGE[range ?? "90d"] ?? 90;
}

/**
 * V1: lost-revenue.service.ts:549 getLostRevenueSummary
 * V2: convex.revenue.getMissedRevenue (denial losses + idle-gap losses)
 */
export async function getSummary(input?: {
  range?: string;
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const days = rangeToDays(input?.range);
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.revenue.getMissedRevenue, { accountSlug, days }),
      getSyncState(),
    ]);
    return wrap({
      data: { ok: true as const, range: input?.range ?? "90d", ...(data as object) },
      source: "convex.revenue.getMissedRevenue",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1: lost-revenue.service.ts:635 getUnmatchedDemand
 * V2: convex.lost_revenue.getUnmatchedDemand
 *
 * Groups denial_records by item_name within `range` window, keeps items
 * requested >= minRequestCount times (default 2, mirrors V1), sorts by
 * request frequency, returns top-N with last-requested timestamp and an
 * optional lost-£ estimate (sum of `estimated_value` from denial rows).
 */
export async function getUnmatchedDemand(input?: {
  range?: string;
  account?: AccountSlug | null;
  limit?: number;
  minRequestCount?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const days = rangeToDays(input?.range);
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.lost_revenue.getUnmatchedDemand, {
        accountSlug,
        days,
        limit: input?.limit ?? 30,
        minRequestCount: input?.minRequestCount ?? 2,
      }),
      getSyncState(),
    ]);
    return wrap({
      data: { ok: true as const, range: input?.range ?? "90d", ...(data as object) },
      source: "convex.lost_revenue.getUnmatchedDemand",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1: lost-revenue.service.ts:959 getSubstitutionAnalysis
 * V2: convex.lost_revenue.getSubstitutionPatterns
 *
 * Joins denial_records × reservations within a 14-day sliding window per
 * V1 line 989. Returns `[{ requested, substitutedWith, count }]`.
 *
 * Caveat: V1 also matched on `renter_info`. V2 denial_records has no
 * renter_id (schema gap). The V2 implementation matches on time window
 * only, which is a weaker signal — the surfaced caveat warns the agent.
 */
export async function getSubstitutionPatterns(input?: {
  range?: string;
  account?: AccountSlug | null;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const days = rangeToDays(input?.range);
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.lost_revenue.getSubstitutionPatterns, {
        accountSlug,
        days,
        limit: input?.limit ?? 20,
      }),
      getSyncState(),
    ]);
    return wrap({
      data: { ok: true as const, range: input?.range ?? "90d", ...(data as object) },
      source: "convex.lost_revenue.getSubstitutionPatterns",
      syncState,
      extraCaveats: [
        "substitutionPatternsApproximate — V2 denial_records has no renter_id, so substitution detection uses a 14-day time-window join only (V1 matched on same renter). Treat results as 'items rented near in time to a denial', not a strict same-customer substitution.",
      ],
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1: lost-revenue.service.ts:1171 getPurchaseRecommendations
 * V2: convex.lost_revenue.getPurchaseRecommendations
 *
 * Cross-joins unmatched demand × pricing_catalog × ROI window. Projects
 * annual revenue per item and returns `[{ itemName, requestCount,
 * projectedAnnualGbp, recommendation }]` ranked by projected revenue.
 *
 * Caveat: V1's full output included EXPAND_STOCK and CONVERT_MARKETING
 * buckets that depend on utilization data we haven't ported yet. V2 ships
 * the BUY NOW bucket only.
 */
export async function getPurchaseRecommendations(input?: {
  range?: string;
  account?: AccountSlug | null;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const days = rangeToDays(input?.range);
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.lost_revenue.getPurchaseRecommendations, {
        accountSlug,
        days,
        limit: input?.limit ?? 10,
      }),
      getSyncState(),
    ]);
    return wrap({
      data: { ok: true as const, range: input?.range ?? "90d", ...(data as object) },
      source: "convex.lost_revenue.getPurchaseRecommendations",
      syncState,
      extraCaveats: [
        "purchaseRecommendationsBuyNowOnly — V2 ships V1's BUY NOW bucket only (items not in inventory with proven demand). EXPAND_STOCK and CONVERT_MARKETING buckets require utilization data not yet ported.",
      ],
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * Wave 2 Q1: write-side capability.
 * Records that a renter asked for an item we don't own / didn't have available.
 * Backing mutation: convex.denial_records.createDenial.
 */
export async function recordDenial(input: {
  itemRequested: string;
  renterName?: string;
  source?: "manual" | "parsed";
  account?: AccountSlug | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input.account);
    const reason = input.renterName
      ? `Renter "${input.renterName}" asked for "${input.itemRequested}" — not in inventory.`
      : `Customer asked for "${input.itemRequested}" — not in inventory.`;
    const notes =
      `recorded_via=${input.source ?? "manual"};` +
      (input.renterName ? `renter=${input.renterName};` : "");
    const result = (await convex.mutation(
      anyApi.denial_records.createDenial,
      {
        itemName: input.itemRequested,
        reason,
        notes,
        accountSlug: accountSlug ?? undefined,
      },
    )) as { ok: boolean; id: string };
    return { ok: true, id: result.id };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}
