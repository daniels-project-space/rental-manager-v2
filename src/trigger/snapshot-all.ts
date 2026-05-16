/**
 * snapshot-all — Trigger.dev scheduled task (Phase 18.5).
 *
 * Consolidates four previously-independent snapshot tasks into a single daily
 * job. Fires at 04:30 UTC, immediately AFTER the MV master refresh at 04:00
 * UTC (Phase 18.3), so every R2 snapshot reads fresh materialised data.
 *
 * Quiet hours: snapshots are write-only with no LLM cost, so this task is
 * EXEMPT from the UK quiet-hours gate. It runs regardless of clock.
 *
 * Execution: sequential (await each) to avoid hammering Convex. One failing
 * snapshot is logged and the next is attempted — error isolation per step.
 *
 * Steps (in order):
 *   1. daily_briefing       (R2: cold/v1/indexes/daily_briefing.json)
 *   2. intel_rankings       (R2: cold/v1/indexes/intel_rankings.json)
 *   3. top_renters          (R2: cold/v1/indexes/top_renters.json)
 *   4. inventory_overview   (R2: cold/v1/indexes/inventory_overview.json)
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { runSnapshotDailyBriefing } from "./snapshot-daily-briefing";
import { runSnapshotIntelRankings } from "./snapshot-intel-rankings";
import { runSnapshotTopRenters } from "./snapshot-top-renters";
import { runSnapshotInventoryOverview } from "./snapshot-inventory-overview";

type StepResult = {
  snapshot: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
): Promise<StepResult> {
  const startedAt = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - startedAt;
    logger.info(`snapshot-all: step ok`, { snapshot: name, durationMs });
    return { snapshot: name, ok: true, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`snapshot-all: step failed`, {
      snapshot: name,
      durationMs,
      error: message,
    });
    return { snapshot: name, ok: false, durationMs, error: message };
  }
}

export const snapshotAllTask = schedules.task({
  id: "snapshot-all",
  cron: "30 4 * * *",
  maxDuration: 600,
  run: async (_payload, { ctx }) => {
    const startedAt = Date.now();
    logger.info("snapshot-all: starting", { runId: ctx.run.id });

    const results: StepResult[] = [];

    // Sequential — one failure does NOT stop the chain.
    results.push(await runStep("daily_briefing", () => runSnapshotDailyBriefing()));
    results.push(await runStep("intel_rankings", () => runSnapshotIntelRankings()));
    results.push(await runStep("top_renters", () => runSnapshotTopRenters()));
    results.push(
      await runStep("inventory_overview", () =>
        runSnapshotInventoryOverview(ctx.run.id),
      ),
    );

    const totalMs = Date.now() - startedAt;
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;

    logger.info("snapshot-all: done", {
      totalMs,
      okCount,
      failCount,
      results,
    });

    return { ok: failCount === 0, totalMs, okCount, failCount, results };
  },
});
