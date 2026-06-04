/**
 * 2026-06-04 — One-time backfill: correct `duration_days` on existing
 * `reservations` to the INCLUSIVE-day basis (the B1 fix now live in the poller).
 *
 * WHY ──────────────────────────────────────────────────────────────────────
 * Hygglo rental periods are inclusive of BOTH the pickup and return day:
 * same-day = 1 day, Fri→Sun = 3 days. The corrected formula lives in
 * `src/hygglo-core/dates.ts`:
 *     hyggloInclusiveDays(s,e) = max(1, round((e - s) / 86400000) + 1)
 * Rows written before that fix carry an UNDERCOUNTED `duration_days`
 * (off-by-one) or `undefined` (legacy rows). `duration_days` feeds the
 * rolling-365-day missed/denied-revenue ESTIMATES
 * (`convex/mv/missed_denied_compute.ts` → `dp * max(1, duration_days ?? 2)`),
 * so the stale values understate those estimates. This backfill brings the
 * stored field onto the corrected basis so re-polled and historical rows agree.
 *
 * COMPUTATION SOURCE (parity-critical) ──────────────────────────────────────
 * The live poller computes duration in `src/hygglo-core/shape.ts:254-257` from
 * the FULL UTC timestamps `order.rentalPeriod.startDateUTC / endDateUTC`. Those
 * full timestamps are NOT persisted as separate fields — only the date-only
 * slices `start_date` / `end_date` (YYYY-MM-DD, `startUTC.slice(0,10)`) are
 * stored (`convex/hygglo.ts` upsert; `convex/schema.ts:225-226`).
 *
 * This backfill recomputes from the stored date-only `start_date` / `end_date`
 * parsed as midnight UTC. EMPIRICALLY VERIFIED on hearty-oyster-600 (probe,
 * 2026-06-04, 2175 rows): the date-only recompute equals the poller's
 * full-UTC-timestamp value for EVERY row (timeOfDayDiff = 0) — because Hygglo's
 * startDateUTC and endDateUTC share the same time-of-day, so the fractional day
 * parts cancel under `round`. Date-only is therefore the correct,
 * poller-agreeing source AND the only source available on stored rows.
 *
 * SAFETY ────────────────────────────────────────────────────────────────────
 *   - Touches ONLY `duration_days`. No other field, no other table.
 *   - Rows with missing/invalid dates are SKIPPED (left untouched).
 *   - Updates ONLY when newDur !== existing duration_days. Idempotent:
 *     a second run patches 0 rows.
 *   - Bounded per-call (chunk_size × max_chunks) for Convex tx/action limits.
 *
 * USAGE ─────────────────────────────────────────────────────────────────────
 *   Dry-run (count + sample, NO writes):
 *     npx convex run migrations/backfill_inclusive_duration:dryRunCount '{}'
 *   Apply (loops to completion across chunks):
 *     npx convex run migrations/backfill_inclusive_duration:backfillInclusiveDuration '{}'
 *   Re-run dryRunCount afterwards → expect would_change: 0 (idempotency proof).
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { hyggloInclusiveDays } from "../../src/hygglo-core/dates";

/**
 * Recompute the corrected inclusive duration for one reservation from its
 * stored date-only `start_date` / `end_date`. Returns null when the dates are
 * missing or unparseable (caller SKIPS — never patches such a row).
 *
 * Exported so the vitest suite can exercise the exact recompute logic the
 * mutation uses (same-day → 1, off-by-one corrected, missing-date → null).
 */
export function recomputeDuration(
  startDate: string | undefined,
  endDate: string | undefined,
): number | null {
  if (!startDate || !endDate) return null;
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return hyggloInclusiveDays(startMs, endMs);
}

// ── per-chunk write mutation ────────────────────────────────────────────────

/**
 * Process one page of reservations. Recomputes `duration_days` from the stored
 * date-only fields and patches ONLY rows whose value actually changes. Each
 * chunk commits independently so a single bad row can't roll back a batch.
 */
export const _backfillDurationChunk = internalMutation({
  args: {
    chunk_size: v.number(),
    cursor: v.optional(v.string()),
    dry_run: v.boolean(),
  },
  handler: async (ctx, { chunk_size, cursor, dry_run }) => {
    const page = await ctx.db
      .query("reservations")
      .paginate({ numItems: chunk_size, cursor: cursor ?? null });

    let changed = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const r of page.page) {
      const row = r as {
        start_date?: string;
        end_date?: string;
        duration_days?: number;
      };
      const newDur = recomputeDuration(row.start_date, row.end_date);
      if (newDur === null) {
        skipped++; // missing / invalid dates — leave untouched
        continue;
      }
      if (newDur === row.duration_days) {
        unchanged++;
        continue;
      }
      if (!dry_run) {
        await ctx.db.patch(r._id, { duration_days: newDur });
      }
      changed++;
    }
    return {
      changed,
      unchanged,
      skipped,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// ── top-level driver action ─────────────────────────────────────────────────

/**
 * Loops `_backfillDurationChunk` up to `max_chunks` times, driving the cursor
 * to completion. `dry_run: true` runs the full read pass + counts but writes
 * nothing. Returns aggregated counters + whether the table was fully scanned.
 */
export const backfillInclusiveDuration = internalAction({
  args: {
    chunk_size: v.optional(v.number()),
    max_chunks: v.optional(v.number()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { chunk_size, max_chunks, dry_run },
  ): Promise<{
    changed: number;
    unchanged: number;
    skipped: number;
    chunks_completed: number;
    finished: boolean;
    dry_run: boolean;
  }> => {
    const chunk = Math.max(1, Math.min(chunk_size ?? 200, 500));
    const maxChunks = Math.max(1, Math.min(max_chunks ?? 200, 1000));
    const isDry = dry_run ?? false;

    let cursor: string | null = null;
    let totalChanged = 0;
    let totalUnchanged = 0;
    let totalSkipped = 0;
    let chunksCompleted = 0;
    let finished = false;

    for (let i = 0; i < maxChunks; i++) {
      const res: {
        changed: number;
        unchanged: number;
        skipped: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(
        internal.migrations.backfill_inclusive_duration._backfillDurationChunk,
        { chunk_size: chunk, cursor: cursor ?? undefined, dry_run: isDry },
      );
      totalChanged += res.changed;
      totalUnchanged += res.unchanged;
      totalSkipped += res.skipped;
      chunksCompleted++;
      cursor = res.continueCursor;
      if (res.isDone) {
        finished = true;
        break;
      }
    }

    return {
      changed: totalChanged,
      unchanged: totalUnchanged,
      skipped: totalSkipped,
      chunks_completed: chunksCompleted,
      finished,
      dry_run: isDry,
    };
  },
});

// ── standalone dry-run counter (read-only) ──────────────────────────────────

/**
 * Read-only DRY-RUN. Counts how many reservations WOULD change, returns a small
 * sample of {id, oldDur, newDur, startDate, endDate} and min/max/avg of the
 * old→new transition — WITHOUT writing anything. Used to report the blast
 * radius before applying, and to prove idempotency (expect would_change: 0)
 * after applying.
 *
 * NOTE: full scan via `.collect()` — this is a one-off admin helper, same
 * precedent as `admin_backfill_renter_links.ts:listCandidates`.
 */
export const dryRunCount = internalQuery({
  args: { sample_size: v.optional(v.number()) },
  handler: async (ctx, { sample_size }) => {
    const rows = await ctx.db.query("reservations").collect(); // check-patterns:ok — one-off migration dry-run
    const sampleCap = sample_size ?? 15;

    let total = 0;
    let wouldChange = 0;
    let unchanged = 0;
    let skipped = 0;
    let minOld = Infinity;
    let maxOld = -Infinity;
    let minNew = Infinity;
    let maxNew = -Infinity;
    let sumOld = 0;
    let sumNew = 0;
    let definedOldCount = 0;
    const deltaHistogram: Record<string, number> = {};
    const sample: Array<{
      id: string;
      oldDur: number | undefined;
      newDur: number;
      startDate: string;
      endDate: string;
    }> = [];

    for (const r of rows) {
      total++;
      const row = r as {
        start_date?: string;
        end_date?: string;
        duration_days?: number;
      };
      const newDur = recomputeDuration(row.start_date, row.end_date);
      if (newDur === null) {
        skipped++;
        continue;
      }
      if (newDur === row.duration_days) {
        unchanged++;
        continue;
      }
      wouldChange++;
      const oldKey = row.duration_days === undefined ? "undef" : String(row.duration_days);
      deltaHistogram[`${oldKey}->${newDur}`] =
        (deltaHistogram[`${oldKey}->${newDur}`] ?? 0) + 1;
      if (row.duration_days !== undefined) {
        definedOldCount++;
        minOld = Math.min(minOld, row.duration_days);
        maxOld = Math.max(maxOld, row.duration_days);
        sumOld += row.duration_days;
      }
      minNew = Math.min(minNew, newDur);
      maxNew = Math.max(maxNew, newDur);
      sumNew += newDur;
      if (sample.length < sampleCap) {
        sample.push({
          id: r._id,
          oldDur: row.duration_days,
          newDur,
          startDate: row.start_date as string,
          endDate: row.end_date as string,
        });
      }
    }

    return {
      total,
      would_change: wouldChange,
      unchanged,
      skipped,
      pct_changing: total > 0 ? Math.round((wouldChange / total) * 1000) / 10 : 0,
      old_dur: {
        min: definedOldCount > 0 ? minOld : null,
        max: definedOldCount > 0 ? maxOld : null,
        avg: definedOldCount > 0 ? Math.round((sumOld / definedOldCount) * 100) / 100 : null,
        defined_count: definedOldCount,
      },
      new_dur: {
        min: wouldChange > 0 ? minNew : null,
        max: wouldChange > 0 ? maxNew : null,
        avg: wouldChange > 0 ? Math.round((sumNew / wouldChange) * 100) / 100 : null,
      },
      delta_histogram: deltaHistogram,
      sample,
    };
  },
});
