/**
 * Canonical CURRENT-MONTH expectation.
 *
 * Shared by the Expected Monthly stat card (convex/dashboard.ts) and the
 * lifetime chart's forecast (convex/revenue.ts) so the dashboard cannot show
 * three different numbers for the same month.
 *
 * ── Why this exists (2026-09-02) ─────────────────────────────────────
 * On 2026-09-02 the live dashboard showed, for September:
 *   Expected Monthly  £835      (dashboard.ts)
 *   "Projected"       £7,860    (lifetime chart legend)
 *   forecast / target £11,546   (revenue.ts currentMonthTarget)
 * …for a business averaging ~£3,342/mo. Three numbers, three formulas.
 *
 * Two independent start-of-month failures produced that spread:
 *
 * 1. dashboard.ts set `monthlyTarget = projected`, so "% of target" was pinned
 *    at 100% by construction, and `projected` used
 *    `avgDailyRate = monthTotal / daysElapsed`. At the start of a month nothing
 *    has been picked up yet, so avgDailyRate is 0 and `projected` collapsed to
 *    just the already-booked total — making Expected Monthly a duplicate of
 *    Month Confirmed.
 *
 * 2. revenue.ts computed `paceProjection` as
 *    `(currentMonthSoFar / dayOfMonth) * daysInCurrentMonth`, where
 *    `currentMonthSoFar` is the WHOLE month's booked revenue — including
 *    bookings dated later in the month. Dividing a full-month figure by days
 *    elapsed treats future bookings as if they were already earned: on day 2
 *    that turned £835.20 into £835.20 / 2 * 30 = £12,528.
 *
 * Both bugs shrink as the month progresses, which is why the dashboard looked
 * fine on 30 Aug and broken on 1 Sep.
 *
 * ── The model ────────────────────────────────────────────────────────
 * A month's expectation blends two signals by how far through the month we are:
 *   • pace     — this month's REALISED-TO-DATE run rate, extrapolated.
 *                Trustworthy late in the month, meaningless on day 1.
 *   • baseline — what a normal month looks like, from recent COMPLETED months.
 *                Trustworthy on day 1, stale by day 28.
 * Weighting by `progress = daysElapsed / daysInMonth` hands over smoothly.
 *
 * The result is floored at `committed` (realised + already-booked) so a
 * projection can never claim less money than is already on the books.
 *
 * Seasonality is deliberately NOT an input here. dashboard.ts reads only the
 * last 365 days of reservations (convex/dashboard.ts:411) so it cannot see
 * prior-year Septembers at all — including seasonality would make the two
 * callers diverge again by construction. revenue.ts still applies seasonality
 * to FUTURE months, which only the chart draws and which no tile mirrors.
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
  /** Net revenue whose effective date is on or before today. NOT the whole month. */
  realisedToDate: number;
  /** Net revenue already booked for the REMAINDER of this month. */
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

export function projectCurrentMonth(input: CurrentMonthInput): CurrentMonthProjection {
  const daysInMonth = Math.max(1, Math.floor(input.daysInMonth) || 1);
  const daysElapsed = Math.min(Math.max(0, Math.floor(input.daysElapsed) || 0), daysInMonth);
  const realisedToDate = Math.max(0, input.realisedToDate || 0);
  const bookedRemainder = Math.max(0, input.bookedRemainder || 0);
  const baseline = Math.max(0, input.baseline || 0);

  const committed = Math.round((realisedToDate + bookedRemainder) * 100) / 100;
  const progress = daysElapsed / daysInMonth;

  // Extrapolate THIS month's realised run rate to a full month. Zero on day 0,
  // and correctly zero when nothing has been earned yet — which is exactly why
  // it must be weighted by `progress` rather than used raw.
  const paceFull = daysElapsed > 0 ? (realisedToDate / daysElapsed) * daysInMonth : 0;

  const trend = progress * paceFull + (1 - progress) * baseline;
  const projected = Math.round(Math.max(committed, trend));

  let basis: CurrentMonthProjection["basis"];
  if (projected === Math.round(committed) && committed > trend) basis = "committed";
  else if (baseline <= 0) basis = "pace";
  else if (daysElapsed === 0) basis = "baseline";
  else basis = "blend";

  return { projected, target: Math.round(baseline), committed, basis };
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
