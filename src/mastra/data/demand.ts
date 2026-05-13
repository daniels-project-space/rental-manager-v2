/**
 * Demand-signal reads.
 *
 * V1 mirror: src/demand/demand.service.ts:50 getTopRequestedItems
 * V2 backing query: convex.demand.getTopRequestedItems (added this PR).
 *
 * Wave 2.5 follow-up: V2 has no `demand_records` table yet. We proxy from
 * `denial_records` for now — see convex/demand.ts.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

const DAYS_PER_RANGE: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "6m": 180,
};

export async function getTop(input?: {
  range?: string;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const days = DAYS_PER_RANGE[input?.range ?? "30d"] ?? 30;
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.demand.getTopRequestedItems, {
        days,
        limit: input?.limit ?? 20,
      }),
      getSyncState(),
    ]);
    return wrap({
      data: { ok: true as const, range: input?.range ?? "30d", ...(data as object) },
      source: "convex.demand.getTopRequestedItems (denial-records proxy)",
      syncState,
      extraCaveats: [
        "Demand proxy: V2 has no dedicated demand_records table yet (Wave 2.5). Counts reflect renter requests that were declined/denied — true demand signal must add conversation-extracted-fact aggregation in a future wave.",
      ],
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
