/**
 * Rental-revenue expectation shared by the card and chart. Only completed
 * calendar days feed pace. A fourteen-day historical prior stabilises early
 * estimates, and confirmed bookings are a floor rather than an extra run-rate
 * term. Claims, pending verification and unpaid requests do not drive pace.
 */

/** Weights for the trailing baseline, most-recent month first. */
export const TRAILING_WEIGHTS = [0.5, 0.3, 0.2] as const;

/**
 * "What a normal month looks like", from recent COMPLETED months.
 *
 * @param recentCompleted Net revenue of completed months, MOST RECENT FIRST.
 *   Short arrays are fine — weights are renormalised over what is present, so
 *   a two-month-old account still gets a sane baseline instead of a number
 *   silently scaled down by missing terms.
 */
export function trailingBaseline(recentCompleted: number[]): number {
  const usable = recentCompleted
    .slice(0, TRAILING_WEIGHTS.length)
    .map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  if (usable.length === 0) return 0;
  let weighted = 0;
  let weightSum = 0;
  for (let i = 0; i < usable.length; i++) {
    weighted += usable[i] * TRAILING_WEIGHTS[i];
    weightSum += TRAILING_WEIGHTS[i];
  }
  if (weightSum <= 0) return 0;
  return Math.round(weighted / weightSum);
}

export type CurrentMonthInput = {
  /** Net revenue on completed calendar days. Excludes the current partial day. */
  realisedToDate: number;
  /** Net revenue committed for today and the rest of the month. */
  bookedRemainder: number;
  daysElapsed: number;
  daysInMonth: number;
  /** From trailingBaseline(). */
  baseline: number;
};

export type CurrentMonthProjection = {
  /** Expected full-month total. Never below `committed`. */
  projected: number;
  /** What a normal month looks like — independent of this month's bookings. */
  target: number;
  /** realisedToDate + bookedRemainder. */
  committed: number;
  /** Which signal dominated, for debugging and tooltips. */
  basis: "committed" | "pace" | "baseline" | "blend";
};

/** Completed days only; fourteen days of historical revenue stabilise early pace. */
export function projectCurrentMonth(input: CurrentMonthInput): CurrentMonthProjection {
  const finite = (v: number) => Number.isFinite(v) ? Math.max(0, v) : 0;
  const daysInMonth = Math.max(1, Math.floor(finite(input.daysInMonth)));
  const daysElapsed = Math.min(Math.floor(finite(input.daysElapsed)), daysInMonth);
  const realisedToDate = finite(input.realisedToDate);
  const bookedRemainder = finite(input.bookedRemainder);
  const baseline = finite(input.baseline);
  const committed = Math.round((realisedToDate + bookedRemainder) * 100) / 100;
  const remainingDays = daysInMonth - daysElapsed;
  const priorDays = baseline > 0 ? 14 : 0;
  const rawDailyRate = daysElapsed + priorDays > 0
    ? (realisedToDate + (baseline / daysInMonth) * priorDays) / (daysElapsed + priorDays)
    : 0;
  // Limit inferred new demand to twice normal daily revenue; actual bookings
  // remain an unrestricted floor. One large rental cannot imply a huge run rate.
  const dailyRate = baseline > 0 ? Math.min(rawDailyRate, 2 * baseline / daysInMonth) : rawDailyRate;
  // Bookings for remaining days are already part of the expected demand;
  // take the larger remainder instead of adding them to the run rate twice.
  const trend = realisedToDate + dailyRate * remainingDays;
  const projected = Math.max(Math.ceil(committed), Math.round(trend));
  const basis: CurrentMonthProjection["basis"] = committed > trend ? "committed"
    : daysElapsed === 0 ? "baseline" : baseline > 0 ? "blend" : "pace";
  return { projected, target: Math.round(baseline), committed, basis };
}

export function previousMonthKeys(month: string, count = 3): string[] {
  const [year, number] = month.split("-").map(Number);
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(year, number - 2 - i, 1)).toISOString().slice(0, 7));
}

/**
 * Percentage of the month's baseline already committed. Uncapped on purpose —
 * a great month SHOULD read 130%. Callers clamp the progress BAR, not the
 * number. (The old code did `Math.min(100, …)` against a target that was itself
 * set to `projected`, so this always read exactly 100%.)
 */
export function pctOfTarget(committed: number, target: number): number {
  if (!(target > 0)) return 0;
  return Math.round((committed / target) * 100);
}
