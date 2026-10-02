import { londonToday } from "./effectiveDates";
import { shiftStockDate, validIsoDate } from "./renter_stock";

type DateScope = { explicit: boolean; valid: boolean; start_date?: string; end_date?: string; matched_text?: string };
const monthNames = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const monthNumber = (name: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase()) + 1;
const day = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const iso = (year: number, month: number, date: string) => `${year}-${String(month).padStart(2, "0")}-${date.padStart(2, "0")}`;
function scope(start: string, end: string, matched_text: string): DateScope {
  return { explicit: true, valid: validIsoDate(start) && validIsoDate(end) && end >= start, start_date: start, end_date: end, matched_text };
}

/** Calendar words qualify the claim they describe, not the current booking's
 * immutable dates. Unknown years and conflicting spans remain unverified. */
export function claimDateScope(text: string, contextStart?: string | null, today = londonToday()): DateScope {
  const isoDates = [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
  if (isoDates.length) {
    if (isoDates.length > 2) return { explicit: true, valid: false };
    return scope(isoDates[0][0], isoDates[1]?.[0] ?? isoDates[0][0], text.slice(isoDates[0].index, isoDates.at(-1)!.index! + 10));
  }
  const year = contextStart && validIsoDate(contextStart) ? Number(contextStart.slice(0, 4)) : undefined;
  const ranges = [...text.matchAll(new RegExp(String.raw`\b${day}\s*(?:to|[-–])\s*${day}\s+(${monthNames})(?:\s+(\d{4}))?\b`, "gi"))];
  if (ranges.length > 1) return { explicit: true, valid: false };
  if (ranges.length) {
    const m = ranges[0], y = m[4] ? Number(m[4]) : year;
    return y ? scope(iso(y, monthNumber(m[3]), m[1]), iso(y, monthNumber(m[3]), m[2]), m[0]) : { explicit: true, valid: false };
  }
  const cross = [...text.matchAll(new RegExp(String.raw`\b${day}\s+(${monthNames})(?:\s+(\d{4}))?\s*(?:to|[-–])\s*${day}\s+(${monthNames})(?:\s+(\d{4}))?\b`, "gi"))];
  if (cross.length > 1) return { explicit: true, valid: false };
  if (cross.length) {
    const m = cross[0], y = m[3] ? Number(m[3]) : year;
    const startMonth = monthNumber(m[2]), endMonth = monthNumber(m[5]);
    return y ? scope(iso(y, startMonth, m[1]), iso(m[6] ? Number(m[6]) : y + (endMonth < startMonth ? 1 : 0), endMonth, m[4]), m[0]) : { explicit: true, valid: false };
  }
  const points = [...text.matchAll(new RegExp(String.raw`\b${day}\s+(${monthNames})(?:\s+(\d{4}))?\b`, "gi"))];
  if (points.length > 1) return { explicit: true, valid: false };
  if (points.length) {
    const m = points[0], y = m[3] ? Number(m[3]) : year;
    const date = y ? iso(y, monthNumber(m[2]), m[1]) : "";
    // An extension "through 8 October" describes the retained pickup-to-
    // return span. "Booked on 8 October" is still an independent point claim.
    const prefix = text.slice(0, m.index);
    if (contextStart && validIsoDate(contextStart)
      && /\bextend(?:ed|ing)?\b[^.!?;]{0,100}\b(?:through|until|to)\s*$/i.test(prefix))
      return y ? scope(contextStart, date, m[0]) : { explicit: true, valid: false };
    return y ? scope(date, date, m[0]) : { explicit: true, valid: false };
  }
  const relative = /\b(?:available|booked|for|from|on|through|until)\s+(today|tomorrow)\b/i.exec(text);
  if (relative) { const date = shiftStockDate(today, relative[1].toLowerCase() === "tomorrow" ? 1 : 0); return scope(date, date, relative[1]); }
  return { explicit: false, valid: true };
}
