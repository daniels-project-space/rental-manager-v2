/**
 * Trigger.dev scheduled task: snapshot the daily_briefing MV to R2.
 *
 * Runs every 10 minutes. Reads the pre-computed `daily_briefing` MV
 * (account = "all") via a single Convex query — no recompute.
 * If the MV row is null (not yet computed), skips the R2 write.
 *
 * R2 key: cold/v1/indexes/daily_briefing.json
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { wrapSnapshot, putAggregateIndex } from "../lib/r2-cold-storage";

const CONVEX_URL =
  process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

export const snapshotDailyBriefingTask = schedules.task({
  id: "snapshot-daily-briefing",
  cron: "*/10 * * * *",
  run: async () => {
    if (process.env.SNAPSHOTS_VIA_CONVEX === "1") {
      logger.info("SNAPSHOTS_VIA_CONVEX=1, deferring to Convex internalAction");
      return { skipped: true, reason: "convex-action" };
    }
    const startedAt = Date.now();
    logger.info("snapshot-daily-briefing: starting");

    const convex = new ConvexHttpClient(CONVEX_URL);

    // Single MV read — no recompute. Returns null if cron hasn't run yet.
    const briefing = await convex.query(api.mv.daily_briefing.get, {});

    if (briefing === null) {
      logger.warn("snapshot-daily-briefing: MV not yet computed, skipping R2 write");
      return { ok: false, reason: "mv_null" };
    }

    const payload = wrapSnapshot(briefing);
    const rowSize = JSON.stringify(payload).length;

    await putAggregateIndex("daily_briefing", payload);

    const durationMs = Date.now() - startedAt;
    logger.info("snapshot-daily-briefing: done", { rowSize, durationMs });

    return { ok: true, rowSize, durationMs };
  },
});
