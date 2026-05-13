/**
 * Lost-revenue reads + denial recording.
 *
 * V1 mirror: src/lost-revenue/lost-revenue.service.ts (549 / 635 / 959 / 1171).
 *
 * Wave 2 status:
 *   - getSummary       → wraps convex.revenue.getMissedRevenue (READY)
 *   - recordDenial     → wraps convex.denial_records.createDenial (READY)
 *   - getUnmatchedDemand          → STUB (Wave 2.5: needs Convex query)
 *   - getSubstitutionPatterns     → STUB (Wave 2.5: needs Convex query)
 *   - getPurchaseRecommendations  → STUB (Wave 2.5: needs Convex query)
 *
 * Each STUB returns `{ ok: false, source: 'pending-convex-query', caveats }`
 * so the agent can degrade gracefully instead of throwing.
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
 * V2: NO MATCHING CONVEX QUERY YET → Wave 2.5 follow-up.
 *
 * STUB: returns the raw denial_records list as a best-effort substitute so the
 * agent has *something* useful to surface ("X renters asked for items we
 * don't own"). True unmatched-demand analysis (de-dup by item, frequency
 * weighting, last-asked timestamp) belongs server-side.
 */
export async function getUnmatchedDemand(input?: {
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [denials, syncState] = await Promise.all([
      convex.query(anyApi.denial_records.list, { limit: input?.limit ?? 50 }),
      getSyncState(),
    ]);
    return wrap({
      data: {
        ok: true as const,
        source: "pending-convex-query",
        denials,
      },
      source: "convex.denial_records.list (Wave 2.5 stub)",
      syncState,
      extraCaveats: [
        "getUnmatchedDemandNotYetWired — returning raw denial_records as a best-effort substitute. Wave 2.5 will add convex.lost_revenue.getUnmatchedDemand (item-deduplicated, frequency-weighted).",
      ],
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1: lost-revenue.service.ts:959 getSubstitutionAnalysis
 * V2: NO MATCHING CONVEX QUERY YET → Wave 2.5 follow-up.
 * STUB: returns empty result + caveat. The agent can still answer the
 * question by reasoning over denial_records + inventory if needed.
 */
export async function getSubstitutionPatterns(): Promise<Result<unknown>> {
  return {
    ok: false,
    error:
      "substitutionPatternsNotYetWired — Wave 2.5: needs convex.lost_revenue.getSubstitutionPatterns query (analyses denial → completed-rental same-customer sequences).",
  };
}

/**
 * V1: lost-revenue.service.ts:1171 getPurchaseRecommendations
 * V2: NO MATCHING CONVEX QUERY YET → Wave 2.5 follow-up.
 * STUB. The agent can suggest manually using denial_records + price catalog.
 */
export async function getPurchaseRecommendations(): Promise<Result<unknown>> {
  return {
    ok: false,
    error:
      "purchaseRecommendationsNotYetWired — Wave 2.5: needs convex.lost_revenue.getPurchaseRecommendations query (ranks unmet demand × estimated ROI vs acquisition cost).",
  };
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
