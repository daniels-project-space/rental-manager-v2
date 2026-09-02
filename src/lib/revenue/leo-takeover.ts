export const LEO_TAKEOVER_MONTH = "2026-08";

export type RevenuePerformanceMonth = {
  month: string;
  revenue: number;
};

export type LeoTakeoverPerformance = {
  beforeAverage: number;
  afterAverage: number;
  beforeMonths: number;
  afterMonths: number;
  deltaPct: number | null;
};

function average(rows: RevenuePerformanceMonth[]): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((sum, row) => sum + row.revenue, 0) / rows.length);
}

/**
 * Compare Leo's management era with the preceding 24 calendar months.
 *
 * Zero-revenue months deliberately remain in both denominators: excluding them
 * would inflate either operator's performance.
 *
 * COMPLETED MONTHS ONLY (2026-09-02). The current month is excluded from BOTH
 * sides, matching the Avg/mo, Best and Weakest stats in LifetimeRevenue.tsx,
 * which all slice on `m.month < currentMonthKey`. Including the partial current
 * month made this average crater on the 1st of every month — on 2026-09-02 it
 * read (Aug £3,484 + Sep £835) / 2 = £2,160/mo, because Sep was 2 days old.
 * A partial month is not a comparable data point against completed months; the
 * old `includesPartialCurrentMonth` "so far" badge papered over a real
 * arithmetic error rather than fixing it. Future months are ignored as before.
 */
export function calculateLeoTakeoverPerformance(
  rows: RevenuePerformanceMonth[],
  currentMonth: string,
  takeoverMonth = LEO_TAKEOVER_MONTH,
): LeoTakeoverPerformance {
  const observed = rows
    .filter((row) => row.month < currentMonth && Number.isFinite(row.revenue))
    .sort((a, b) => a.month.localeCompare(b.month));
  const before = observed.filter((row) => row.month < takeoverMonth).slice(-24);
  const after = observed.filter((row) => row.month >= takeoverMonth);
  const beforeAverage = average(before);
  const afterAverage = average(after);
  return {
    beforeAverage,
    afterAverage,
    beforeMonths: before.length,
    afterMonths: after.length,
    deltaPct: beforeAverage > 0
      ? Math.round(((afterAverage - beforeAverage) / beforeAverage) * 100)
      : null,
  };
}
