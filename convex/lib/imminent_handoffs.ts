export type ImminentHandoffCandidate = {
  thread_id: string | null;
  account_slug: string | null;
  renter_name: string;
  items: string[];
  kind: "pickup" | "return";
  date: string;
  time: string;
};

export type ImminentHandoff = ImminentHandoffCandidate & {
  minutes_away: number;
};

function ymdDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 86_400_000);
}

function hmMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : null;
}

export function calendarMinute(date: string, time: string): number | null {
  const day = ymdDay(date);
  const minute = hmMinutes(time);
  return day === null || minute === null ? null : day * 1440 + minute;
}

export function nearbyCalendarDates(date: string): Set<string> {
  const day = ymdDay(date);
  if (day === null) return new Set([date]);
  return new Set([-1, 0, 1].map((offset) =>
    new Date((day + offset) * 86_400_000).toISOString().slice(0, 10),
  ));
}

/** Filter and sort date-aware handoffs, including windows crossing midnight. */
export function filterImminentHandoffs(
  candidates: ImminentHandoffCandidate[],
  nowDate: string,
  nowTime: string,
  windowMin = 60,
  accountSlug?: string,
): ImminentHandoff[] {
  const now = calendarMinute(nowDate, nowTime);
  if (now === null) return [];
  return candidates
    .flatMap((candidate) => {
      if (accountSlug && candidate.account_slug !== accountSlug) return [];
      const event = calendarMinute(candidate.date, candidate.time);
      if (event === null) return [];
      const minutes_away = event - now;
      return Math.abs(minutes_away) <= windowMin
        ? [{ ...candidate, minutes_away }]
        : [];
    })
    .sort((a, b) =>
      Math.abs(a.minutes_away) - Math.abs(b.minutes_away) ||
      a.minutes_away - b.minutes_away,
    );
}
