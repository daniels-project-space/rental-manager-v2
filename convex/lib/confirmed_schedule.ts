import type { ScheduleProof } from "../../src/lib/booking-schedule-evidence";
export function confirmedClock(
  row: {
    account_slug?: string;
    pickup_time?: string | null;
    return_time?: string | null;
    pickup_time_provenance?: ScheduleProof;
    return_time_provenance?: ScheduleProof;
  },
  endpoint: "pickup" | "return",
  date: string,
) {
  const time = endpoint === "pickup" ? row.pickup_time : row.return_time,
    proof =
      endpoint === "pickup"
        ? row.pickup_time_provenance
        : row.return_time_provenance;
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined;
  // Website clocks are accepted in the immutable signed rental contract.
  if (row.account_slug === "dbcinema_web") return time;
  return proof?.time === time && proof.date === date ? time : undefined;
}
const london = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function londonStockInstant(label: string, bound: "start" | "end") {
  const civil = Date.parse(label + "Z");
  if (!Number.isFinite(civil) || new Date(civil).toISOString().slice(0,16)!==label) throw Error("Invalid stock schedule label");
  const matches: number[] = [];
  // Modern London candidates include both sides of a DST fold. Historic
  // perpetual repair endpoints use UTC sentinels rather than local LMT seconds.
  if (label.startsWith("0001-") || label.startsWith("9999-")) return civil;
  for (const offset of [-3600000, 0, 3600000]) {
    const candidate = civil + offset;
    const p = Object.fromEntries(
      london.formatToParts(new Date(candidate)).map((x) => [x.type, x.value]),
    );
    if (
      `${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}` ===
      label
    )
      matches.push(candidate);
  }
  if (!matches.length) {
    // A nonexistent spring-forward clock cannot release stock. Widen the
    // affected boundary to the beginning/end of that local day instead.
    const day = label.slice(0, 10);
    const fallback =
      bound === "start"
        ? day + "T00:00"
        : new Date(Date.parse(day + "T12:00Z") + 86400000)
            .toISOString()
            .slice(0, 10) + "T00:00";
    return londonStockInstant(fallback, bound);
  }
  return bound === "start" ? Math.min(...matches) : Math.max(...matches);
}

export function londonStockLabel(at:number){const p=Object.fromEntries(london.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return `${p.year.padStart(4,"0")}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
