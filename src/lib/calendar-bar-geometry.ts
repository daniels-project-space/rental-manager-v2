export const DAY_MS = 86_400_000;
export const DAY_WINDOW_START_MIN = 9 * 60;
export const DAY_WINDOW_END_MIN = 22 * 60;
export const MIN_READABLE_BAR_WIDTH = 112;

export type CalendarBarBlock = {
  start_date?: string;
  end_date?: string;
  return_date?: string | null;
  pickup_time?: string | null;
  return_time?: string | null;
};

export type CalendarBarGeometry = { left: number; width: number };

export function timeFrac(time: string | null | undefined, fallback: number): number {
  if (!time) return fallback;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return fallback;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Math.max(
    0,
    Math.min(1, (minutes - DAY_WINDOW_START_MIN) / (DAY_WINDOW_END_MIN - DAY_WINDOW_START_MIN)),
  );
}

/**
 * Time-accurate geometry with a readable same-day minimum. Expansion stays
 * inside the real day column, so a one-hour rental no longer becomes a dot and
 * never appears to occupy an adjacent date.
 */
export function calendarBarGeometry(
  block: CalendarBarBlock,
  weekStart: string,
  xAt: (dayFloat: number) => number,
  minReadableWidth = MIN_READABLE_BAR_WIDTH,
): CalendarBarGeometry | null {
  if (!block.start_date) return null;
  const effectiveReturn = block.return_date ?? block.end_date;
  if (!effectiveReturn) return null;
  const weekStartMs = Date.parse(`${weekStart}T00:00:00Z`);
  const weekEndMs = weekStartMs + 7 * DAY_MS;
  const startMs = Date.parse(`${block.start_date}T00:00:00Z`) + timeFrac(block.pickup_time, 0) * DAY_MS;
  const endMs = Date.parse(`${effectiveReturn}T00:00:00Z`) + timeFrac(block.return_time, 1) * DAY_MS;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= weekStartMs || startMs >= weekEndMs) return null;

  const startDays = Math.max(0, (startMs - weekStartMs) / DAY_MS);
  const endDays = Math.min(7, (endMs - weekStartMs) / DAY_MS);
  const rawLeft = xAt(startDays);
  const rawRight = xAt(endDays);
  const rawWidth = Math.max(rawRight - rawLeft, 0);

  if (block.start_date === effectiveReturn && rawWidth < minReadableWidth) {
    const dayIndex = Math.max(0, Math.min(6, Math.floor(startDays)));
    const dayLeft = xAt(dayIndex) + 4;
    const dayRight = xAt(dayIndex + 1) - 4;
    const available = Math.max(8, dayRight - dayLeft);
    const width = Math.min(Math.max(rawWidth, minReadableWidth), available);
    const midpoint = (rawLeft + rawRight) / 2;
    const left = Math.max(dayLeft, Math.min(midpoint - width / 2, dayRight - width));
    return { left, width };
  }

  return { left: rawLeft, width: Math.max(rawWidth, 8) };
}
