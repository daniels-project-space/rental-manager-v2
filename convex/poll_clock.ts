/**
 * Hygglo poll clock — Convex-side cadence gate (added 2026-08-22).
 *
 * WHY THIS EXISTS
 * ---------------
 * `poll-hygglo-inbox` used to be driven directly by a Trigger.dev declarative
 * cron on `HYGGLO_POLL_CRON` ("*\/2,15,45 * * * *" = 768 ticks/day). Trigger.dev
 * bills a full run for every tick, including the ones that evaluate their two
 * internal gates and immediately `return { skipped: true }`. Roughly half of
 * those 768 daily runs were billed no-ops.
 *
 * Both gates are decidable from data Convex already holds:
 *
 *   Gate A — clock only (`hyggloPollMode`): active-window / overnight-hourly /
 *            full-vs-operational selection. Pure function of the current time.
 *   Gate B — cadence (`resolveEffectivePollInterval` + `isPollIntervalElapsed`):
 *            the human `settings.polling_interval_ms` dial widened by the
 *            adaptive `quietStreak` in `sync_state[source="hygglo_poller"]`.
 *
 * So this action evaluates BOTH gates using only local Convex reads — no HTTP,
 * no Trigger.dev run — and reaches out over the network only when the answer is
 * "yes, do real work". The decision is identical to the one the Trigger.dev task
 * would have made, so polling cadence and data freshness are unchanged; only the
 * billed no-op runs disappear.
 *
 * NOT A REPEAT OF THE 2026-05-24 MISTAKE
 * --------------------------------------
 * Two earlier Convex→Vercel pollers were deleted 2026-05-24 (see the comment
 * block in `convex/crons.ts`) because they made an UNCONDITIONAL round-trip and
 * only discovered there was nothing to do AFTER paying for the call. This action
 * is the inverse: it pays for the network call only after a local read has
 * already proven there is work. On a skip it costs two small indexed Convex
 * reads and nothing else.
 *
 * GATE PARITY CAVEAT
 * ------------------
 * `hyggloPollMode` honours the `BYPASS_QUIET_HOURS`, `POLL_ACTIVE_START_MIN` and
 * `POLL_ACTIVE_END_MIN` env vars. For the clock and the Trigger.dev task to
 * agree, those must hold the same values in the Convex deployment and in the
 * Trigger.dev environment. None of them are set in either today (defaults:
 * active window 08:00–23:00 London, hard 01:00–08:00 break). If you ever set one,
 * set it in BOTH places — otherwise the clock and the task disagree about what
 * "due" means and the task silently discards runs the clock paid to enqueue.
 */
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { hyggloPollMode } from "../src/lib/quiet-hours";
import {
  isPollIntervalElapsed,
  resolveEffectivePollInterval,
} from "../src/lib/hygglo-poll-backoff";

export type PollClockResult = {
  /** True only when a Trigger.dev run was actually enqueued. */
  invoked: boolean;
  reason:
    | "outside_poll_active_window"
    | "configured_interval_not_elapsed"
    | "enqueued"
    | "enqueue_failed"
    | "not_configured";
  mode?: "full" | "operational";
  effectiveIntervalMs?: number;
  quietStreak?: number;
  elapsedMs?: number | null;
  detail?: string;
};

/**
 * POST the existing `/api/poll-hygglo` route, which enqueues the Trigger.dev
 * task. Deliberately the same transport, env vars and header shape as
 * `enqueueRecoveryPoll` in `convex/poller_health.ts` — one authenticated path
 * from Convex into the poller, not two competing ones.
 */
async function enqueuePoll(mode: "full" | "operational"): Promise<{ ok: boolean; detail?: string }> {
  const url = process.env.POLL_TRIGGER_URL;
  const secret = process.env.POLL_TRIGGER_SECRET;
  if (!url || !secret) {
    return { ok: false, detail: "POLL_TRIGGER_URL or POLL_TRIGGER_SECRET is not configured" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      // `source` is load-bearing: it tells the Trigger.dev task to treat this as
      // a SCHEDULED run. Without it the task sees a payload with no
      // type="DECLARATIVE" marker, classifies it as a manual operator run, and
      // both forces mode="full" AND bypasses its own interval gate — which would
      // make this clock strictly more expensive than the cron it replaces.
      body: JSON.stringify({ mode, source: "convex-clock" }),
    });
    if (!response.ok) return { ok: false, detail: `poll endpoint returned ${response.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err).slice(0, 240) };
  }
}

/**
 * Runs every 2 minutes (see `convex/crons.ts`). Cheap by construction: the
 * common case is an early return after zero or two indexed reads.
 */
export const tickPollClock = internalAction({
  args: {},
  handler: async (ctx): Promise<PollClockResult> => {
    // ── Gate A — clock only, zero reads ────────────────────────────────
    // `manual = false`: this is a scheduled tick, never an operator repair.
    const mode = hyggloPollMode(new Date(), false);
    if (mode === "skip") {
      return { invoked: false, reason: "outside_poll_active_window" };
    }

    // ── Gate B — local Convex reads only, still no network ─────────────
    const [settings, previous] = await Promise.all([
      ctx.runQuery(api.settings.get, {}),
      ctx.runQuery(api.sync_state.get, { source: "hygglo_poller" }),
    ]);

    const { effectiveIntervalMs, quietStreak } = resolveEffectivePollInterval(
      (settings as { polling_interval_ms?: number } | null)?.polling_interval_ms,
      (previous as { quietStreak?: number } | null)?.quietStreak,
    );
    const lastRunAt = (previous as { lastRunAt?: number } | null)?.lastRunAt ?? null;
    const now = Date.now();
    const elapsedMs = lastRunAt === null ? null : now - lastRunAt;

    if (!isPollIntervalElapsed(lastRunAt, now, effectiveIntervalMs)) {
      // The whole point: this branch costs two Convex reads instead of a
      // billed Trigger.dev run that would have returned `skipped`.
      return {
        invoked: false,
        reason: "configured_interval_not_elapsed",
        mode,
        effectiveIntervalMs,
        quietStreak,
        elapsedMs,
      };
    }

    // ── Real work is due — only now do we touch the network ────────────
    const enqueued = await enqueuePoll(mode);
    if (!enqueued.ok) {
      // Surface loudly: a clock that cannot reach the poller means the
      // Trigger.dev backup cron (L2) and the staleness auto-heal (L3) are the
      // only things keeping the poller alive.
      console.error("[poll-clock] failed to enqueue poll", {
        mode,
        detail: enqueued.detail,
      });
      return {
        invoked: false,
        reason: enqueued.detail?.includes("not configured") ? "not_configured" : "enqueue_failed",
        mode,
        effectiveIntervalMs,
        quietStreak,
        elapsedMs,
        detail: enqueued.detail,
      };
    }

    return {
      invoked: true,
      reason: "enqueued",
      mode,
      effectiveIntervalMs,
      quietStreak,
      elapsedMs,
    };
  },
});
