/**
 * Pickup/collection window resolution for the renter bot.
 *
 * Extracted from src/app/api/renter-bot-draft/route.ts on 2026-08-18 after a
 * real bug: that path fell straight from a per-account override to a HARDCODED
 * literal, skipping the operator's global `settings.pickup_hours` entirely,
 * while convex/replyInbox.ts:1167 had always honoured the middle tier. The two
 * halves of the same bot could therefore state different opening hours for the
 * same account, and an operator editing the global hours in Settings would see
 * no effect on what renters were told.
 *
 * SettingsDrawer.tsx tells the operator "Using the shared fallback windows."
 * whenever an account's own list is empty — this module is what makes that
 * promise true. Keep the cascade here, tested, rather than inline in a route.
 */

export type PickupWindow = { start: string; end: string };

/**
 * Last-resort windows for a deployment where NEITHER a per-account override nor
 * a global setting exists. Deliberately the historical values so behaviour on a
 * fresh/unconfigured deployment is unchanged — never treat this as "the hours".
 */
export const FALLBACK_PICKUP_HOURS: PickupWindow[] = [
  { start: "10:00", end: "12:00" },
  { start: "19:00", end: "21:00" },
];

/**
 * Three-tier cascade: per-account override → operator's global setting →
 * hardcoded last resort. An empty array counts as "not set" at every tier,
 * because that is exactly how the Settings UI represents "fall back".
 */
export function resolvePickupHours(
  perAccount: PickupWindow[] | null | undefined,
  global: PickupWindow[] | null | undefined,
): PickupWindow[] {
  if (perAccount && perAccount.length) return perAccount;
  if (global && global.length) return global;
  return FALLBACK_PICKUP_HOURS;
}

/** "HH:MM" → minutes since midnight. Returns NaN on unparseable input. */
export function toMinutes(hm: string): number {
  const [h, m] = String(hm).split(":").map(Number);
  if (!Number.isFinite(h)) return Number.NaN;
  return h * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Windows that still have usable time left today.
 *
 * `bufferMinutes` keeps the bot from offering a window that technically hasn't
 * ended but is too close to be arrangeable — at 11:58 the 10:00–12:00 slot is
 * not a real option. Mirrors the original inline `nowMin + 15`.
 */
export function remainingWindowsToday(
  windows: PickupWindow[],
  nowHM: string,
  bufferMinutes = 15,
): PickupWindow[] {
  const nowMin = toMinutes(nowHM);
  if (!Number.isFinite(nowMin)) return windows;
  return windows.filter((w) => {
    const end = toMinutes(w.end);
    return Number.isFinite(end) && end > nowMin + bufferMinutes;
  });
}

/**
 * The earliest moment a returning unit can actually be collected again.
 *
 * Two constraints compose, and stating either alone gives a wrong answer:
 *   1. a one-hour turnaround after the previous renter hands it back
 *   2. collection only happens inside a pickup window
 *
 * So a 12:30 return is not "free at 13:30" — it is free at the start of the
 * first window that has not already ended by 13:30. With windows of 10:00-12:00
 * and 19:00-21:00 that is 19:00 the same day; a 12:00 return against a window
 * opening at 13:00 is collectable at 13:00.
 *
 * Returns null when no window on the return day still works, so the caller can
 * fall back to the next day's opening.
 */
export function nextCollectableTime(
  returnTime: string,
  windows: Array<{ start: string; end: string }>,
  turnaroundMinutes = 60,
): string | null {
  const toMin = (hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    return Number.isFinite(h) ? h * 60 + (m || 0) : NaN;
  };
  const ready = toMin(returnTime) + turnaroundMinutes;
  if (!Number.isFinite(ready)) return null;
  const usable = [...windows]
    .filter((w) => Number.isFinite(toMin(w.start)) && Number.isFinite(toMin(w.end)))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
  for (const w of usable) {
    // The window must not already be over by the time the kit is ready.
    if (toMin(w.end) <= ready) continue;
    const at = Math.max(toMin(w.start), ready);
    const hh = String(Math.floor(at / 60)).padStart(2, "0");
    const mm = String(at % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return null;
}
