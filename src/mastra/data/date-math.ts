/**
 * Date math helpers. Hygglo treats both start and end as rental days, so any
 * "days between" math MUST add 1 and clamp to >= 1.
 *
 * V1 sources (every revenue/lost-revenue calc):
 *   - src/lost-revenue/lost-revenue.service.ts:252,736,1105
 *   - src/revenue/revenue.service.ts:1821,2108,2401
 *   - src/autonomous/autonomous.service.ts:2988,3932
 * V1 audit: /tmp/claude_scratchpad/v1_feature_inventory.md §6
 * Daniel rule: MEMORY.md "Hygglo dates INCLUSIVE: Math.max(1, Math.round(diff/86400000) + 1)"
 */

const MS_PER_DAY = 86_400_000;

/**
 * Inclusive day count between two dates (both ends counted as rental days).
 * Accepts Date objects, ISO strings, or millisecond timestamps.
 *
 *   hyggloDaysInclusive("2026-05-13", "2026-05-13") => 1
 *   hyggloDaysInclusive("2026-05-13", "2026-05-14") => 2
 */
export function hyggloDaysInclusive(
  start: Date | string | number,
  end: Date | string | number,
): number {
  const s = toMs(start);
  const e = toMs(end);
  return Math.max(1, Math.round((e - s) / MS_PER_DAY) + 1);
}

/**
 * Elapsed days from a past date until now (NOT inclusive — used for
 * "how many days has X been ongoing").
 * V1 source: revenue.service.ts:2781,3288 — daysElapsed = Math.max(1, Math.round(ms/86400000))
 */
export function elapsedDays(
  start: Date | string | number,
  end: Date | string | number = Date.now(),
): number {
  const s = toMs(start);
  const e = toMs(end);
  return Math.max(1, Math.round((e - s) / MS_PER_DAY));
}

function toMs(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return new Date(v).getTime();
}
