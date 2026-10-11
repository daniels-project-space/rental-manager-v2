const format = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function rentalCalendarParts(timestamp: number) {
  const p = Object.fromEntries(
    format.formatToParts(timestamp).map((p) => [p.type, p.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
}
/** Reject nonexistent/ambiguous clock times instead of silently moving the rental. */
export function rentalCalendarTimestamp(date: string, time: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  )
    throw Error("Choose a valid date and time.");
  const utc = Date.parse(`${date}T${time}:00Z`);
  const matches = [utc - 3600000, utc].filter((t) => {
    const p = rentalCalendarParts(t);
    return p.date === date && p.time === time;
  });
  if (matches.length !== 1)
    throw Error(
      "This London clock time changes with daylight saving. Choose another time.",
    );
  return matches[0];
}
