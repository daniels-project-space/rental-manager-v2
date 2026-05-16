/**
 * Convex cron schedule for the Wave 3 materialized-view layer.
 *
 * Refresh intervals tuned per MV staleness tolerance:
 *
 *   daily_briefing       15 min   tolerated stale window per chat-UX testing.
 *   top_earners_30d     360 min   30-day window — 6h staleness tolerated.
 *   purchase_signals  daily 04:00 UTC   denial aggregation, slow-moving.
 *   churn_risk        daily 04:15 UTC   renter behaviour shifts over weeks.
 *   utilization_today    60 min   widget reads MV; refresh as bookings flow.
 *   upcoming_returns     30 min   refreshes after every poll cycle.
 *
 * Cost: Phase 18.1 (2026-05-16) shifted slow-moving MVs to daily and
 * widened top_earners to 6h. Previous round (2026-05-15) widened
 * cadences ~3x to cut Convex bandwidth (was ~3.5M reservations-row
 * reads/day from crons alone).
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
  { minutes: 360 },
  internal.mv.top_earners.refresh,
  {},
);

crons.daily(
  "purchase_signals refresh",
  { hourUTC: 4, minuteUTC: 0 },
  internal.mv.purchase_signals.refresh,
  {},
);

crons.daily(
  "churn_risk_renters refresh",
  { hourUTC: 4, minuteUTC: 15 },
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


// ── Item resolver, notes-only backfill, booking-time extractor, vision
// resolver: all LIFTED TO TRIGGER.DEV. See src/trigger/{resolve-items,
// extract-booking-times,vision-resolve}.ts. Convex action runtime was
// billed for every Grok call; Trigger.dev free-tier compute is cheaper
// for long LLM jobs.

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
// demand_loss_class. Idempotent; daily cadence sufficient since
// obsolete reservations are slow-moving. See convex/demand_loss.ts.
crons.daily(
  "classify-obsolete-demand-loss",
  { hourUTC: 4, minuteUTC: 30 },
  internal.demand_loss.classifyObsoleteReservations,
  { limit: 100 },
);

export default crons;
