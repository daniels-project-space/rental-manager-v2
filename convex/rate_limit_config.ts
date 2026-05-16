/**
 * Convex application-layer rate limits (Phase 3c W1a).
 *
 * Uses @convex-dev/rate-limiter — a Convex component that stores rate-limit
 * state transactionally alongside your other Convex data.
 *
 * Rules defined here:
 *
 *   chat_per_thread   60 turns / 5 min     Per thread_id cap. Prevents a
 *                                           single runaway conversation from
 *                                           consuming all xAI quota.
 *
 *   chat_per_account  300 turns / 60 min   Per accountSlug cap. Dashboard-
 *                                           wide ceiling per tenant.
 *
 *   hygglo_poll       1 run / 4 min        Absolute guard on the Convex cron
 *                                           that triggers the Mastra workflow.
 *                                           Prevents double-fire if a manual
 *                                           trigger races the 15-min cron.
 *
 * Allow-list for background crons (NOT rate-limited here):
 *   - mv_refresh_fast / mv_refresh_slow  (MV writers — pure Convex mutations)
 *   - snapshot-* crons                   (R2 writers — internalActions)
 *   - archive-to-r2-cold                 (archiver — internalAction)
 *   - complete stale-confirmed           (reservation cleanup)
 *   - account profile image sync         (weekly scrape)
 *   - classify-obsolete-demand-loss      (demand-loss classifier)
 *
 * These background jobs run on a fixed cadence with no user-driven amplification
 * so per-call rate limits add no value and would create false positives.
 */
import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

// NOTE: `components.rateLimiter` is typed as `{}` until `convex dev` regenerates
// _generated/api.d.ts after convex.config.ts registers the component. The
// `as any` cast is safe — the runtime shape matches once the deployment is live.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rateLimiter = new RateLimiter((components as any).rateLimiter, {
    /**
     * Per-thread chat cap: 60 turns per 5-minute fixed window.
     * key = thread_id
     */
    chat_per_thread: {
      kind: "fixed window",
      rate: 60,
      period: 5 * MINUTE,
    },

    /**
     * Per-account chat cap: 300 turns per hour.
     * key = accountSlug
     */
    chat_per_account: {
      kind: "fixed window",
      rate: 300,
      period: HOUR,
    },

    /**
     * Hygglo poll workflow trigger: 1 per 4 minutes absolute.
     * Global singleton (no key). Prevents manual trigger + cron race.
     */
    hygglo_poll: {
      kind: "fixed window",
      rate: 1,
      period: 4 * MINUTE,
    },
});
