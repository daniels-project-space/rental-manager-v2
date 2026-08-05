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
  includesPartialCurrentMonth: boolean;
};

function average(rows: RevenuePerformanceMonth[]): number {
  if (rows.length === 0) return 0;
  return Math.round(rows.reduce((sum, row) => sum + row.revenue, 0) / rows.length);
}

/**
 * Compare Leo's management era with the preceding 24 calendar months.
 *
 * Zero-revenue months deliberately remain in both denominators: excluding them
 * would inflate either operator's performance. Future months are ignored, while
 * the current partial month is included and explicitly surfaced to the UI.
 */
export function calculateLeoTakeoverPerformance(
  rows: RevenuePerformanceMonth[],
  currentMonth: string,
  takeoverMonth = LEO_TAKEOVER_MONTH,
): LeoTakeoverPerformance {
  const observed = rows
    .filter((row) => row.month <= currentMonth && Number.isFinite(row.revenue))
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
    includesPartialCurrentMonth: after.some((row) => row.month === currentMonth),
  };
}
