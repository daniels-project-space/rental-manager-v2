/**
 * Convex cron schedule for the Wave 3 materialized-view layer.
 *
 * Refresh intervals tuned per MV staleness tolerance:
 *
 *   daily_briefing       5 min   most-stale-sensitive — drives chat "what
 *                                happened today" surface; must look live.
 *   top_earners_30d     15 min   30-day window changes slowly; 15 min is plenty.
 *   purchase_signals    30 min   30d denial aggregation — slow-moving.
 *   churn_risk          60 min   renter behaviour shifts over weeks.
 *   utilization_today   15 min   per-item snapshot; updates as bookings flow in.
 *   upcoming_returns    10 min   needs to feel fresh after each poll cycle.
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
  { minutes: 5 },
  internal.mv.daily_briefing.refresh,
  {},
);

crons.interval(
  "top_earners_30d refresh",
  { minutes: 15 },
  internal.mv.top_earners.refresh,
  {},
);

crons.interval(
  "purchase_signals refresh",
  { minutes: 30 },
  internal.mv.purchase_signals.refresh,
  {},
);

crons.interval(
  "churn_risk_renters refresh",
  { minutes: 60 },
  internal.mv.churn_risk.refresh,
  {},
);

crons.interval(
  "utilization_today refresh",
  { minutes: 15 },
  internal.mv.utilization.refresh,
  {},
);

crons.interval(
  "upcoming_returns refresh",
  { minutes: 10 },
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
  { minutes: 3 },
  internal.hygglo_poll_trigger.triggerWorkflow,
);

// Demote stale-confirmed rows (Hygglo dropped them from every filter) to
// completed so they stop appearing as ongoing/overdue in the Active widget.
crons.interval(
  "complete stale-confirmed reservations",
  { minutes: 7 },
  internal.reservations.completeStaleConfirmedCron,
  {},
);


// ── Item resolver — LLM-driven resolution of Hygglo titles → inventory IDs.
// Runs every 5 min, resolves up to 15 unresolved reservations per cycle so
// new poller writes get accurate item identification within minutes.
crons.interval(
  "item_resolver batch",
  { minutes: 5 },
  internal.item_resolver.resolveBatch,
  { limit: 15 },
);


// ── Booking-time extractor — LLM reads owner-renter chat → pickup_time /
// return_time / pickup_date / return_date / methods on each reservation.
// Hygglo's API never exposes these; we negotiate them in chat.
// 10 min cadence; up to 10 reservations per cycle (LLM cost guard).
crons.interval(
  "booking_time_extractor batch",
  { minutes: 10 },
  internal.extract_booking_times.extractBatch,
  { limit: 10 },
);


// ── Vision resolver — Grok vision pass over LLM-resolved kit-style
// reservations. Catches kit-lens / accessory items hidden in the photo
// that the text-only resolver missed. Tight 5-per-cycle cap (vision costs
// ~10x text).
crons.interval(
  "vision_resolver augment",
  { minutes: 15 },
  internal.vision_resolver.augmentBatch,
  { limit: 5 },
);


// ── Account profile-image sync — weekly. Re-scrapes each account's
// Hygglo profile photo from a sample order detail. Right now we
// hand-seeded once; this catches Daniel changing his avatar over time.
crons.weekly(
  "account profile image sync",
  { dayOfWeek: "monday", hourUTC: 4, minuteUTC: 0 },
  internal.sync_account_profiles.syncAccountProfiles,
  {},
);

export default crons;
