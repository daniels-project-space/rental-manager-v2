/**
 * Compute Europe/London minutes-since-midnight for the given instant.
 * Shared internal helper — keeps quiet-hours and poll-window logic in sync.
 */
function londonMinutesSinceMidnight(now: Date): number {
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
 * Poller-only active window (07:00–23:00 London); other tasks keep isWithinUkQuietHours.
 * Returns true when current Europe/London time is OUTSIDE the active window, i.e.
 * the poll should be skipped. Window is env-overridable via
 * POLL_ACTIVE_START_MIN / POLL_ACTIVE_END_MIN (minutes since midnight;
 * defaults: 420 = 07:00, 1380 = 23:00). Honours BYPASS_QUIET_HOURS=1.
 */
export function isOutsidePollActiveWindow(now: Date = new Date()): boolean {
  if (process.env.BYPASS_QUIET_HOURS === "1") return false;
  const startMin = Number(process.env.POLL_ACTIVE_START_MIN ?? 7 * 60);  // 07:00
  const endMin   = Number(process.env.POLL_ACTIVE_END_MIN   ?? 23 * 60); // 23:00
  const mins = londonMinutesSinceMidnight(now);
  return mins < startMin || mins >= endMin; // outside 07:00–23:00 → skip poll
}
