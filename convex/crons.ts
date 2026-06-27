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
import { cronJobs, makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// New module not yet in the committed _generated/api type map (only EXISTING
// modules are picked up via `typeof import`), so reference it by name — same
// pattern the dashboard chat tools use for drift-prone functions. Keeps
// `next build`'s typecheck green without committing a regenerated api.
const syncDbcinemaWebRef = makeFunctionReference<"action">(
  "sync_dbcinema_web:syncDbcinemaWeb",
);

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

// backup_poll cron + runBackupPoll action both deleted 2026-05-24 (phase 7c).
// Was disabled 2026-05-23 and the implementation file was orphaned; the
// poller_health staleness check no longer invokes it either (line 152 comment
// in convex/poller_health.ts). Telegram alerts still fire on staleness, just
// without an auto-heal action. Restore from git history if needed.

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

// Sibling for PENDING rows Hygglo dropped after their rental date passed
// (expired / never paid) — they can never reach payment, so demote to
// cancelled instead of showing "pending" forever (2026-06-25, Peter O).
crons.interval(
  "cancel stale-pending reservations",
  { minutes: 240 },
  internal.reservations.cancelStalePendingCron,
  {},
);

// Copy a confirmed handover time recorded on one order onto the other orders of
// the same renter+period rental (so a multi-listing booking sits in the right
// calendar slot even though the time was only agreed in one chat). 2026-06-25.
crons.interval(
  "propagate grouped handover times",
  { minutes: 30 },
  internal.reservations.propagateGroupedTimesCron,
  {},
);

// Pull the DB Cinema WEBSITE's own paid bookings (db-cinema-v2 storefront) up
// into RMv2 as the "dbcinema_web" profile — ongoing rentals, availability and
// revenue, alongside the Hygglo accounts. 30 min. 2026-06-25.
crons.interval(
  "sync dbcinema website bookings",
  { minutes: 30 },
  syncDbcinemaWebRef,
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
// Every 20 min. Scans account_state for `active` rows whose
// lastSuccessfulPollAt is older than 30 min, sends a Telegram alert
// to Daniel (deduped per-account to 1/hour), and invokes the backup
// poller (internal.backup_poll.runBackupPoll) to auto-heal.
// The handler itself self-skips overnight (London 23:00–07:00) when the
// poller is intentionally idle, so off-hours ticks are cheap no-ops.
//
// Telegram env vars required on Convex prod:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID_DANIEL
// If missing, the alert no-ops gracefully (still attempts auto-heal).
crons.interval(
  "poller staleness check",
  { minutes: 20 },
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

// All 4 R2 snapshot cron entries + their snapshot_jobs.ts handlers deleted
// 2026-05-25 (pass 9a). Grep across the codebase confirmed ZERO consumers
// for the R2 keys (`cold/v1/indexes/{daily_briefing,intel_rankings,
// top_renters,inventory_overview}.json`). Chat tools and dashboard widgets
// all read from the Convex MVs directly, not from R2.
//
// The hourly snapshot-daily-briefing was costing ~0.85 GBh/day across Prod
// + Dev with nobody reading the output. Trigger.dev's snapshot-all task
// was also deleted along with the 4 individual src/trigger/snapshot-*.ts
// files. Restore from git history if a future consumer needs cold-storage
// snapshots.

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

// Auto-close returns Hygglo has confirmed (order_step REVIEWED) so the Return
// Hub only shows gear genuinely still out. Conservative (recent + REVIEWED only).
crons.daily(
  "auto_close_reviewed_returns",
  { hourUTC: 5, minuteUTC: 0 },
  internal.returns_reconcile.reconcile,
  {},
);

// ── Phase 6 (2026-06-21) — Return close is now OPERATOR-TRIGGERED, NO CRON ──
// The old 5-min "auto rate+text after manual close" interval that called
// internal.returns_autoclose.drain was REMOVED. The Return Hub rating tap now
// closes on Hygglo + (green) rates + texts in one operator action via the public
// action api.returns_autoclose.finalizeReturn. There is no background close path.
// One-time backfill of pre-rework pending rows: api.returns_autoclose.adminBackfillClose
// (manual, token-guarded — never a cron). See convex/returns_autoclose.ts.

// ── Phase 3 (2026-06-27) — renter trust refresh ──
// Fetch Hygglo reviews for renters currently awaiting a reply and derive their
// rating/review_count, so the AI-draft trust-line works for active threads (it
// was previously only populated on-demand via the dashboard star-click). Daily,
// capped per run to bound external calls. Owner-side signal — see
// renter_reviews.fetchHyggloReviews caveat.
// Renter trust (rating + renter-side reviews) from the Hygglo order detail
// (users.otherPart.rating + customerStats). Replaced the old owner-side
// product-reviews source that left almost every renter rating-less (2026-06-27).
crons.daily(
  "refresh_active_renter_trust",
  { hourUTC: 4, minuteUTC: 30 },
  internal.renter_trust.resolveActiveTrust,
  {},
);

// ── Phase 5b (2026-06-27) — listing-location backfill ──
// Resolve the pickup/listing location (label + postcode + coords) for active
// threads so the tile can show the map link + distance/heavy tag. Hourly; the
// modal-open lazy resolve covers immediacy for the thread you open.
crons.interval(
  "resolve_active_locations",
  { minutes: 60 },
  internal.locations.resolveActive,
  {},
);

// Snapshot the inquiry listing (the item the renter asked about) onto inquiry
// threads so the tile shows it + the draft is grounded. 2026-06-27.
crons.interval(
  "resolve_inquiry_listings",
  { minutes: 30 },
  internal.inquiry_context.resolveActive,
  {},
);

// Pre-generate AI drafts for awaiting-reply threads so they're ready before the
// box is opened (on-message pre-gen only covers new messages). 2026-06-27.
crons.interval(
  "pregenerate_active_drafts",
  { minutes: 30 },
  internal.replyInbox_actions.pregenerateActiveDrafts,
  {},
);

export default crons;
