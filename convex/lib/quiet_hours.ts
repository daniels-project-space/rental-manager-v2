/**
 * UK quiet-hours guard (Phase 14.1).
 * Returns true when current UK local time is within 02:00–08:30 Europe/London.
 * Honours BYPASS_QUIET_HOURS=1 for manual ops.
 * Pure TS — no Convex runtime types.
 */
export function isWithinUkQuietHours(now: Date = new Date()): boolean {
  if (process.env.BYPASS_QUIET_HOURS === "1") return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  const mm = Number(parts.find((p) => p.type === "minute")?.value);
  const mins = hh * 60 + mm;
  return mins >= 120 && mins < 510; // 02:00–08:30
}
