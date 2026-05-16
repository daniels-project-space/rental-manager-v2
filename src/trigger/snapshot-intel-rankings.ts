/**
 * Snapshot helper: snapshot intel ROI + top-earners data to R2.
 *
 * Reads two Convex queries in parallel:
 *   - intel.getItemROIRanking  (no args — full item set)
 *   - mv.top_earners.get       (account = undefined → "all")
 *
 * R2 key: cold/v1/indexes/intel_rankings.json
 *
 * NOTE: Previously a standalone `schedules.task` (cron "0 *\/4 * * *").
 * Consolidated into `snapshot-all` (Phase 18.5).
 */
import { logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { wrapSnapshot, putAggregateIndex } from "../lib/r2-cold-storage";

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

export async function runSnapshotIntelRankings() {
  if (process.env.SNAPSHOTS_VIA_CONVEX === "1") {
    logger.info("SNAPSHOTS_VIA_CONVEX=1, deferring to Convex internalAction");
    return { ok: false as const, reason: "convex-action" as const };
  }
  const startedAt = Date.now();
  logger.info("snapshot-intel-rankings: starting");

  const convex = new ConvexHttpClient(CONVEX_URL);

  let roiRanking: Awaited<ReturnType<typeof convex.query<typeof api.intel.getItemROIRanking>>>;
  let topEarners30d: Awaited<ReturnType<typeof convex.query<typeof api.mv.top_earners.get>>>;

  try {
    [roiRanking, topEarners30d] = await Promise.all([
      convex.query(api.intel.getItemROIRanking, {}),
      convex.query(api.mv.top_earners.get, {}),
    ]);
  } catch (err) {
    logger.error("snapshot-intel-rankings: Convex query failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const data = { roiRanking, topEarners30d };
  const payload = wrapSnapshot(data, "trigger");
  const payloadBytes = JSON.stringify(payload).length;
  const durationMs = Date.now() - startedAt;

  try {
    await putAggregateIndex("intel_rankings", payload);
  } catch (err) {
    logger.error("snapshot-intel-rankings: R2 write failed", {
      error: err instanceof Error ? err.message : String(err),
      payloadBytes,
      durationMs,
    });
    throw err;
  }

  logger.info("snapshot-intel-rankings: done", {
    rowCount: Array.isArray(roiRanking) ? roiRanking.length : 0,
    payloadBytes,
    durationMs,
  });

  return {
    ok: true as const,
    rowCount: Array.isArray(roiRanking) ? roiRanking.length : 0,
    payloadBytes,
    durationMs,
  };
}

