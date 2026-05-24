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

// Phase 18.2 — MV cron consolidation.
// Was: 6 separate cron entries each running a per-MV `refresh` mutation
// (daily_briefing + top_earners + purchase_signals + churn_risk +
// utilization + upcoming_returns).
// Now: 2 master actions in convex/mv/_master.ts that fan out to the same
// refresh mutations. Each delegated refresh keeps its existing compute logic
// (account loops, denial-record reads, singleton writes) so dashboard query
// shapes are unchanged. Future PR can refactor each MV to a pure
// `compute(reservations, denials, items)` function and share the input
// collect across MVs for the bigger Convex-bandwidth win.
crons.interval(
  "mv_refresh_fast",
  { minutes: 60 },
  internal.mv.master.refreshFast,
  {},
);

crons.daily(
  "mv_refresh_slow",
  { hourUTC: 4, minuteUTC: 0 },
  internal.mv.master.refreshSlow,
  {},
);

// ── Wave 4 — Hygglo polling workflow trigger ──────────────────
// REMOVED 2026-05-24 (Convex pro-plan cost audit).
//
// This was a 15-min Convex action that fetch()ed a Next.js API route to
// invoke the Mastra `hygglo_poll` workflow on top of the Trigger.dev
// scraper. The Trigger.dev `poll-hygglo-inbox` task at 5 min has been
// the source-of-truth scraper for months; the Mastra workflow was
// idempotent and detected "nothing new" on every fire — meaning every
// 15 min the cron burned a Convex action runtime + an HTTPS round-trip
// + a sync_state heartbeat write for zero downstream effect (~96 wasted
// invocations/day per account). Removed entirely. Reinstate by reading
// git history if a future flow genuinely needs Convex-side polling.

// ── S2 fix — direct backup_poll cron ─────────────────────────────
// DISABLED 2026-05-23 (Convex pro-plan over quota): this cron has been
// READ-ONLY since 2026-05-20 — fetchOrdersMinimal returns telemetry only
// and writes no domain rows. 144 wasted action runs/day × Hygglo round-trips.
// The `poller staleness check` cron below already invokes runBackupPoll
// on-demand when the primary poller goes stale (>30 min), so the heartbeat
// is preserved via staleness-driven invocation.
// Re-enable by uncommenting the block below if telemetry/heartbeat gaps appear.
// crons.interval(
//   "hygglo backup poll",
//   { minutes: 10 },
//   internal.backup_poll.runBackupPoll,
//   {},
// );

// Demote stale-confirmed rows (Hygglo dropped them from every filter) to
// completed so they stop appearing as ongoing/overdue in the Active widget.
// Cadence loosened 2026-05-24 from 60min → 4h: stale-confirmed rows turn
// stale by the day (Hygglo drops them after end_date passes), not by the
// minute. Was running full reservations.collect() 24×/day to flag a handful
// of rows. Audit recommends adding by_status index — deferred to follow-up.
crons.interval(
  "complete stale-confirmed reservations",
  { minutes: 240 },
  internal.reservations.completeStaleConfirmedCron,
  {},
);

// ── Layer B (2026-05-19) — qty-drift safety net ────────────────
// Nightly 03:00 UTC re-fetches Hygglo per-order detail for active reservations
// and compares raw items[].length vs stored expanded_items quantity. Drifted
// rows persist in qty_drift_alerts (status=open) and surface via
// dashboard.getStatsDrawerData.qty_drift_count. Layer C
// (admin_backfill_qty_resolution) clears them by re-running the resolver.
// Loosened 2026-05-24 daily → weekly. Drift is slow-moving (days, not hours)
// and this cron does an unindexed full-table reservations scan plus an HTTPS
// Hygglo round-trip + mutation per candidate row — dominant per-fire cost.
// Audit recommends batching the mutations + adding by_account_slug/by_status
// index — deferred to follow-up; weekly cadence already gives ~85% reduction.
crons.weekly(
  "audit qty drift",
  { dayOfWeek: "monday", hourUTC: 3, minuteUTC: 0 },
  internal.audit_qty_drift.auditItemQuantities,
  { only_active: true },
);


// ── Wave 4 — Poller staleness alarm + auto-heal ─────────────────
//
// Every 10 min. Scans account_state for `active` rows whose
// lastSuccessfulPollAt is older than 30 min, sends a Telegram alert
// to Daniel (deduped per-account to 1/hour), and invokes the backup
// poller (internal.backup_poll.runBackupPoll) to auto-heal.
//
// Telegram env vars required on Convex prod:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID_DANIEL
// If missing, the alert no-ops gracefully (still attempts auto-heal).
crons.interval(
  "poller staleness check",
  { minutes: 10 },
  internal.poller_health.runStalenessCheck,
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

// ── Phase 3a / Wave 2b — R2 snapshot writers moved from Trigger.dev.
// Each writes the same R2 key its Trigger counterpart did. While both run,
// the Trigger versions short-circuit when SNAPSHOTS_VIA_CONVEX=1 to avoid
// double-writes (last-writer wins regardless via the wrapSnapshot envelope).
//
// TODO (audit 2026-05-23, Convex over-quota): VERIFY the env var
// SNAPSHOTS_VIA_CONVEX=1 is actually set on Trigger.dev (project
// proj_cdhxwycwcjdmxnsodsmc, prod env). If unset, the 4 snapshot tasks below
// fire TWICE per cadence — once here on Convex AND once on Trigger.dev —
// roughly doubling action runtime for this code path. To check:
//   npx trigger.dev@latest env list --env prod | grep SNAPSHOTS_VIA_CONVEX
// Or set it explicitly via Trigger.dev dashboard → Project → Env vars.
// snapshot-daily-briefing stays hourly: its source MV (`mv_refresh_fast`)
// refreshes hourly too, so hourly snapshots match data churn 1:1.
crons.cron(
  "snapshot-daily-briefing",
  "7 * * * *",
  internal.snapshot_jobs.snapshotDailyBriefing,
  {},
);
// Realigned 2026-05-24: intel/top-renters/inventory all read from
// `mv_refresh_slow` which only runs daily at 04:00 UTC (see line 43-48).
// Previously these snapshotted every 4h/6h/12h respectively, meaning
// 95% of their runs wrote identical R2 payloads from stale MV data.
// Now fire once daily at 04:05 UTC — 5 min after mv_refresh_slow lands.
// Saves ~28 wasted Convex action runs/day (was 6+4+2=12 runs/day, now 3).
crons.daily(
  "snapshot-intel-rankings",
  { hourUTC: 4, minuteUTC: 5 },
  internal.snapshot_jobs.snapshotIntelRankings,
  {},
);
crons.daily(
  "snapshot-top-renters",
  { hourUTC: 4, minuteUTC: 10 },
  internal.snapshot_jobs.snapshotTopRenters,
  {},
);
crons.daily(
  "snapshot-inventory-overview",
  { hourUTC: 4, minuteUTC: 15 },
  internal.snapshot_jobs.snapshotInventoryOverview,
  {},
);

// ── Phase 3a / Wave 3a — R2 cold-storage archiver (DRY-RUN DEFAULT).
//
// Moves `hygglo_messages` + `audit_log` rows older than 90d to R2 to free
// Convex hot-storage. DEFAULT IS DRY-RUN. Daniel must manually invoke
// once with `dry_run: false` via the Convex dashboard (or `npx convex run
// archive_to_r2:archiveToR2 '{"dry_run":false}'`) to verify behaviour
// BEFORE flipping the cron arg below.
crons.daily(
  "archive-to-r2-cold",
  { hourUTC: 3, minuteUTC: 30 },
  internal.archive_to_r2.archiveToR2,
  { dry_run: false },
);

// ── Phase 5a — Weekly metrics recompute.
// Runs Sunday 23:30 UTC (just after the ISO week boundary). Idempotent
// re-compute of the just-finished week (Mon..Sun). Writes
// weekly_metrics rows (global + per-kind + per-item, × accounts).
// See convex/admin_backfill_weekly_metrics.ts:recomputeJustFinishedWeek.
crons.weekly(
  "phase5a-weekly-metrics-recompute",
  { dayOfWeek: "sunday", hourUTC: 23, minuteUTC: 30 },
  internal.admin_backfill_weekly_metrics.recomputeJustFinishedWeek,
  {},
);

// ── Phase 5b — Advanced weekly metrics (gap diagnosis + demand +
// customer + substitution). Runs Sunday 23:45 UTC, 15 min after 5a above
// lands the base rows. Patches the same weekly_metrics rows with 5b-owned
// fields (capacity_denied_*, voluntary_denied_*, unique/repeat/new renters,
// avg_response_time_minutes, top_co_rented_canonicals,
// substitutes_booked_after_denial). Idempotent — re-running overwrites
// patched fields with fresh values.
// See convex/admin_backfill_weekly_metrics_5b.ts.
crons.weekly(
  "phase5b-advanced-metrics",
  { dayOfWeek: "sunday", hourUTC: 23, minuteUTC: 45 },
  internal.admin_backfill_weekly_metrics_5b.cronRefreshLastWeek,
  {},
);

export default crons;
