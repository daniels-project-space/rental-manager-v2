/**
 * Compute Europe/London minutes-since-midnight for the given instant.
 * Shared internal helper — keeps quiet-hours and poll-window logic in sync.
 */
export function londonMinutesSinceMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  const mm = Number(parts.find((p) => p.type === "minute")?.value);
  return hh * 60 + mm;
}

/**
 * UK quiet-hours guard (Phase 14.1) — Node-side duplicate.
 * Returns true when current UK local time is within the quiet window
 * 02:00 (inclusive) – 08:30 (exclusive) Europe/London.
 * Honours BYPASS_QUIET_HOURS=1 for manual ops.
 * Pure TS — duplicated across runtimes (Trigger.dev / Mastra).
 */
export function isWithinUkQuietHours(now: Date = new Date()): boolean {
  if (process.env.BYPASS_QUIET_HOURS === "1") return false;
  const mins = londonMinutesSinceMidnight(now);
  return mins >= 120 && mins < 510; // 02:00 inclusive – 08:30 exclusive → quiet
}

/**
 * Poller-only active window (08:00–23:00 London); other tasks keep isWithinUkQuietHours.
 * Returns true when current Europe/London time is OUTSIDE the active window, i.e.
 * the poll should be skipped. Window is env-overridable via
 * POLL_ACTIVE_START_MIN / POLL_ACTIVE_END_MIN (minutes since midnight;
 * defaults: 480 = 08:00, 1380 = 23:00). Honours BYPASS_QUIET_HOURS=1.
 *
 * Hard token-saving break: polling is ALWAYS skipped 01:00–08:00 UK (Daniel,
 * 2026-06-26), enforced independently of the configurable window so widening
 * the window can never re-enable overnight polls.
 */
const POLL_BREAK_START_MIN = 1 * 60; // 01:00 inclusive
const POLL_BREAK_END_MIN = 8 * 60; // 08:00 exclusive

export function isOutsidePollActiveWindow(now: Date = new Date()): boolean {
  if (process.env.BYPASS_QUIET_HOURS === "1") return false;
  const mins = londonMinutesSinceMidnight(now);
  // Always honour the 01:00–08:00 break, regardless of the configured window.
  if (mins >= POLL_BREAK_START_MIN && mins < POLL_BREAK_END_MIN) return true;
  const startMin = Number(process.env.POLL_ACTIVE_START_MIN ?? 8 * 60);  // 08:00
  const endMin   = Number(process.env.POLL_ACTIVE_END_MIN   ?? 23 * 60); // 23:00
  return mins < startMin || mins >= endMin; // outside 08:00–23:00 → skip poll
}

/**
 * Decide whether the Hygglo poller should do a real fetch on this invocation.
 *
 * The normal 15-minute cadence remains limited to 08:00–23:00 London, but a
 * complete overnight blackout can hide a late-paid, next-morning rental from
 * both Active Rentals and the calendar until 08:00. Outside the active window
 * we therefore keep one top-of-hour safety poll. This adds only nine reads per
 * night while bounding overnight staleness to one hour instead of nine.
 *
 * Manual invocations always run: an operator-triggered repair must not turn
 * into a successful no-op merely because it was launched outside office hours.
 */
export function shouldRunHyggloPoll(
  now: Date = new Date(),
  manual = false,
): boolean {
  if (manual) return true;
  if (!isOutsidePollActiveWindow(now)) return true;
  return londonMinutesSinceMidnight(now) % 60 === 0;
}

export type HyggloPollMode = "full" | "operational" | "skip";

// Every two minutes for Quick Access freshness, plus the odd quarter-hours so
// full reconciliation still runs exactly at :00, :15, :30, and :45.
export const HYGGLO_POLL_CRON = "*/2,15,45 * * * *";

/**
 * Select the work performed by the two-minute schedule.
 *
 * Full inventory/presence/reconciliation work stays on the existing 15-minute
 * cadence. Intervening runs only refresh a bounded set of recently active
 * orders so replies and payment transitions reach Quick Access faster.
 * Outside the active window we retain the existing hourly safety poll and make
 * all other invocations true no-ops (including no Convex heartbeat write).
 */
export function hyggloPollMode(
  now: Date = new Date(),
  manual = false,
): HyggloPollMode {
  if (manual) return "full";
  if (!shouldRunHyggloPoll(now)) return "skip";
  if (isOutsidePollActiveWindow(now)) return "full";
  return londonMinutesSinceMidnight(now) % 15 === 0 ? "full" : "operational";
}
