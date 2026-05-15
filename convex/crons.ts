/**
 * Convex cron schedule for the Wave 3 materialized-view layer.
 *
 * Refresh intervals tuned per MV staleness tolerance:
 *
 *   daily_briefing      15 min   tolerated stale window per chat-UX testing.
 *   top_earners_30d     60 min   30-day window barely changes hourly.
 *   purchase_signals   120 min   denial aggregation, slow-moving.
 *   churn_risk         360 min   renter behaviour shifts over weeks.
 *   utilization_today   60 min   widget reads MV; refresh as bookings flow.
 *   upcoming_returns    30 min   refreshes after every poll cycle.
 *
 * Cost: cron cadences widened ~3x on 2026-05-15 to cut Convex bandwidth
 * (was ~3.5M reservations-row reads/day from crons alone).
 *
 * All MV refreshers run as `internalMutation` (no external network calls,
 * so action wrappers are unnecessary for crons — direct mutation is faster).
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// NOTE (Wave 4): each MV refresh handler now takes optional `account` arg.
// Crons always run the full all-accounts refresh — pass `{}` explicitly so the
// rest-param signature `OptionalRestArgs<FuncRef>` resolves.
crons.interval(
  "daily_briefing refresh",
  { minutes: 15 },
  internal.mv.daily_briefing.refresh,
  {},
);

crons.interval(
  "top_earners_30d refresh",
  { minutes: 60 },
  internal.mv.top_earners.refresh,
  {},
);

crons.interval(
  "purchase_signals refresh",
  { minutes: 120 },
  internal.mv.purchase_signals.refresh,
  {},
);

crons.interval(
  "churn_risk_renters refresh",
  { minutes: 360 },
  internal.mv.churn_risk.refresh,
  {},
);

crons.interval(
  "utilization_today refresh",
  { minutes: 60 },
  internal.mv.utilization.refresh,
  {},
);

crons.interval(
  "upcoming_returns refresh",
  { minutes: 30 },
  internal.mv.upcoming_returns.refresh,
  {},
);

// ── Wave 4 — Hygglo polling workflow trigger ──────────────────
//
// Every 3 min. Cadence tuned so:
//   - faster than Trigger.dev's 5-min scrape, so any new Hygglo order
//     picked up by the scraper gets an AI decision in under 3 min
//     (decision-latency SLO for Daniel's admin review).
//   - slow enough that with 2 accounts × ~50 orders/day, AI decision
//     calls per day stay around 100 — well within xAI rate limits.
//
// The Convex action `fetch()`es a Next.js API route which owns the
// Mastra workflow invocation (the workflow runs in Node, not Convex).
// Until POLL_TRIGGER_URL env var is set, the action no-ops — keeping
// the cron registered is harmless.
crons.interval(
  "hygglo_poll workflow",
  { minutes: 15 },
  internal.hygglo_poll_trigger.triggerWorkflow,
);

// Demote stale-confirmed rows (Hygglo dropped them from every filter) to
// completed so they stop appearing as ongoing/overdue in the Active widget.
crons.interval(
  "complete stale-confirmed reservations",
  { minutes: 60 },
  internal.reservations.completeStaleConfirmedCron,
  {},
);


// ── Item resolver — LIFTED TO TRIGGER.DEV ──────────────────────
// Now lives at src/trigger/resolve-items.ts :: resolveItemsTask.
// Convex action runtime was billed for every Grok call (3-8s × 15
// resolutions per batch × 96 runs/day = ~2-3 hrs/day of action time).
// Trigger.dev free-tier compute is materially cheaper for long LLM jobs.
// To re-enable here, uncomment the block below AND disable the
// Trigger schedule. They share the same input_hash idempotency, so
// running both is wasteful (double-LLM) but not corrupting.
/*
crons.interval(
  "item_resolver batch",
  { minutes: 15 },
  internal.item_resolver.resolveBatch,
  { limit: 15 },
);
*/

// ── Notes-only backfill — LIFTED TO TRIGGER.DEV ───────────────
// Now lives at src/trigger/resolve-items.ts :: resolveItemsNotesBackfillTask.
/*
crons.interval(
  "item_resolver notes backfill",
  { minutes: 60 },
  internal.item_resolver.resolveBatch,
  { limit: 10, include_notes_only: true },
);
*/


// ── Booking-time extractor — LIFTED TO TRIGGER.DEV ────────────
// Now lives at src/trigger/extract-booking-times.ts :: extractBookingTimesTask.
/*
crons.interval(
  "booking_time_extractor batch",
  { minutes: 30 },
  internal.extract_booking_times.extractBatch,
  { limit: 10 },
);
*/


// ── Vision resolver — LIFTED TO TRIGGER.DEV ───────────────────
// Now lives at src/trigger/vision-resolve.ts :: visionResolveTask.
// Vision Grok holds Convex actions open ~8-15s × 5 calls = up to 75s
// of action time per cycle. Trigger.dev free-tier compute avoids that.
/*
crons.interval(
  "vision_resolver augment",
  { minutes: 60 },
  internal.vision_resolver.augmentBatch,
  { limit: 5 },
);
*/


// ── Account profile-image sync — weekly. Re-scrapes each account's
// Hygglo profile photo from a sample order detail. Right now we
// hand-seeded once; this catches Daniel changing his avatar over time.
crons.weekly(
  "account profile image sync",
  { dayOfWeek: "monday", hourUTC: 4, minuteUTC: 0 },
  internal.sync_account_profiles.syncAccountProfiles,
  {},
);

// ── Phase 10.7 — Demand-Loss Classifier sweep.
// Picks up newly-obsolete rows from the Hygglo poller and assigns
// demand_loss_class within an hour. Idempotent; small batch keeps
// per-cycle cost flat. See convex/demand_loss.ts.
crons.interval(
  "classify-obsolete-demand-loss",
  { hours: 1 },
  internal.demand_loss.classifyObsoleteReservations,
  { limit: 100 },
);

export default crons;
