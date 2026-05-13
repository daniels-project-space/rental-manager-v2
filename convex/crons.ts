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

crons.interval(
  "daily_briefing refresh",
  { minutes: 5 },
  internal.mv.daily_briefing.refresh,
);

crons.interval(
  "top_earners_30d refresh",
  { minutes: 15 },
  internal.mv.top_earners.refresh,
);

crons.interval(
  "purchase_signals refresh",
  { minutes: 30 },
  internal.mv.purchase_signals.refresh,
);

crons.interval(
  "churn_risk_renters refresh",
  { minutes: 60 },
  internal.mv.churn_risk.refresh,
);

crons.interval(
  "utilization_today refresh",
  { minutes: 15 },
  internal.mv.utilization.refresh,
);

crons.interval(
  "upcoming_returns refresh",
  { minutes: 10 },
  internal.mv.upcoming_returns.refresh,
);

export default crons;
