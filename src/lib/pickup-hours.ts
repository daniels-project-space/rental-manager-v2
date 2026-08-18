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
