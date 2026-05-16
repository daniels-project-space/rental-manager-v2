/**
 * Snapshot helper: snapshot the daily_briefing MV to R2.
 *
 * Reads the pre-computed `daily_briefing` MV (account = "all") via a single
 * Convex query — no recompute. If the MV row is null (not yet computed),
 * skips the R2 write.
 *
 * R2 key: cold/v1/indexes/daily_briefing.json
 *
 * NOTE: Previously a standalone `schedules.task` (cron "*\/10 * * * *").
 * Consolidated into `snapshot-all` (Phase 18.5) to reduce scheduled task
 * count and align all snapshots to fire AFTER the daily 04:00 MV refresh.
 */
import { logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { wrapSnapshot, putAggregateIndex } from "../lib/r2-cold-storage";

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

export async function runSnapshotDailyBriefing() {
  if (process.env.SNAPSHOTS_VIA_CONVEX === "1") {
    logger.info("SNAPSHOTS_VIA_CONVEX=1, deferring to Convex internalAction");
    return { ok: false as const, reason: "convex-action" as const };
  }
  const startedAt = Date.now();
  logger.info("snapshot-daily-briefing: starting");

  const convex = new ConvexHttpClient(CONVEX_URL);

  // Single MV read — no recompute. Returns null if cron hasn't run yet.
  const briefing = await convex.query(api.mv.daily_briefing.get, {});

  if (briefing === null) {
    logger.warn("snapshot-daily-briefing: MV not yet computed, skipping R2 write");
    return { ok: false as const, reason: "mv_null" as const };
  }

  const payload = wrapSnapshot(briefing);
  const rowSize = JSON.stringify(payload).length;

  await putAggregateIndex("daily_briefing", payload);

  const durationMs = Date.now() - startedAt;
  logger.info("snapshot-daily-briefing: done", { rowSize, durationMs });

  return { ok: true as const, rowSize, durationMs };
}

