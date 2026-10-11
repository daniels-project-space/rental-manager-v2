import { sanitizeTime } from "./booking-time-extraction";
import { hasScheduleTimingLanguage } from "./booking-time-transcript";
import type { BookingTimeMessage } from "./booking-time-transcript";
export type ScheduleProof = {
  source: "agreed_chat" | "provider_booking" | "website_contract";
  date: string;
  time: string;
  confirmedAt: number;
  evidenceHash?: string;
};
const acceptance =
  /^(?:yes(?:[!., ]|$)|yeah(?:[!., ]|$)|sure(?:[!., ]|$)|ok(?:ay)?(?:[!., ]|$)|alright(?:[!., ]|$)|perfect(?:[!., ]|$)|that works|sounds good|agreed|confirmed)/i;
const rejection =
  /\b(?:not|no|can't|cannot|won't|however|but|instead|could|would|until|unfortunately)\b/i;
/** Corroborate exact model candidates against a literal schedule proposal and the other party's acceptance.
 * Broad morning/evening, ETAs, lone renter requests and model confidence cannot establish an agreement. */
const CHAT_HOUR_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"] as const;
const CHAT_HOUR_PATTERN = "(?:" + CHAT_HOUR_WORDS.join("|") + ")";
type ExactChatClock = { raw: string; index: number; time: string };

function parseSpokenHour(value: string): number | undefined {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  const index = CHAT_HOUR_WORDS.indexOf(value.toLowerCase() as (typeof CHAT_HOUR_WORDS)[number]);
  return index >= 0 ? index + 1 : undefined;
}

function explicitSpokenChatClocks(text: string): ExactChatClock[] {
  const pattern = new RegExp(
    "\\b((?:quarter\\s+(?:past|to)|half(?:\\s+past)?)\\s+)?(" + CHAT_HOUR_PATTERN + "|\\d{1,2})(?:\\s+(fifteen|thirty|forty[- ]five))?(?:\\s+o['’]?clock)?(?:\\s*([ap])\\.?m\\.?|\\s+((?:in\\s+(?:the\\s+)?|this\\s+)(?:morning|afternoon|evening)|tonight))\\b",
    "gi",
  );
  const clocks: ExactChatClock[] = [];
  for (const match of text.matchAll(pattern)) {
    const hour = parseSpokenHour(match[2]);
    if (hour === undefined) continue;
    const prefix = (match[1] ?? "").trim().toLowerCase();
    const minuteWord = (match[3] ?? "").toLowerCase().replace(/[- ]/g, "");
    if (prefix && minuteWord) continue;
    let minute = minuteWord === "fifteen" ? 15 : minuteWord === "thirty" ? 30 : minuteWord === "fortyfive" ? 45 : 0;
    if (prefix.startsWith("quarter")) minute = prefix.includes(" to ") ? -15 : 15;
    else if (prefix.startsWith("half")) minute = 30;
    const meridiem = (match[4] ?? "").toLowerCase();
    const part = (match[5] ?? "").toLowerCase().replace(/^(?:in\s+(?:the\s+)?|this\s+)/, "");
    let hour24: number;
    if (meridiem) {
      if (hour < 1 || hour > 12) continue;
      hour24 = (hour % 12) + (meridiem === "p" ? 12 : 0);
    } else if (part === "morning") {
      if (hour < 1 || hour > 11) continue;
      hour24 = hour;
    } else if (part === "afternoon") {
      if (hour < 1 || hour > 12) continue;
      hour24 = hour === 12 ? 12 : hour + 12;
    } else {
      if ((part !== "evening" && part !== "tonight") || hour < 1 || hour > 11) continue;
      hour24 = hour + 12;
    }
    const total = ((hour24 * 60 + minute) % 1440 + 1440) % 1440;
    clocks.push({
      raw: match[0],
      index: match.index ?? 0,
      time: String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0"),
    });
  }
  return clocks;
}

function explicitNumericChatTime(value: string): string | undefined {
  if (/^(?:noon|midday)$/i.test(value)) return "12:00";
  if (/^midnight$/i.test(value)) return "00:00";
  const normalized = value.trim();
  const meridiem = /[ap]\.?m\.?$/i.test(normalized);
  const hour = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(normalized);
  if (!meridiem && hour && hour[1].length === 1 && Number(hour[1]) <= 12) return undefined;
  return sanitizeTime(normalized);
}

function exactChatClocks(text: string): ExactChatClock[] {
  const clocks: ExactChatClock[] = [];
  const numericClock = /\b(?:\d{1,2}(?:[:.]\d{2}\s*(?:[ap]\.?m\.?)?|\s*[ap]\.?m\.?)|noon|midday|midnight)\b/gi;
  for (const match of text.matchAll(numericClock)) {
    const time = explicitNumericChatTime(match[0]);
    if (time) clocks.push({ raw: match[0], index: match.index ?? 0, time });
  }
  clocks.push(...explicitSpokenChatClocks(text));
  const unique = new Map<string, ExactChatClock>();
  for (const clock of clocks) unique.set(clock.index + ":" + clock.time, clock);
  return [...unique.values()].sort((a, b) => a.index - b.index);
}

export function confirmedChatClock(
  messages: BookingTimeMessage[],
  endpoint: "pickup" | "return",
  time: string | undefined,
  date: string | undefined,
  bookedDate: string | undefined,
  hash: string,
): ScheduleProof | undefined {
  if (!time || !date || !bookedDate) return;
  let proposal:
    | { index: number; sender: string; dateProven: boolean }
    | undefined;
  let agreement: ScheduleProof | undefined;
  let contextualDate = date === bookedDate;
  let invalidatedThrough = -1;
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index], text = m.body_text;
    if (
      !["owner", "renter"].includes(m.sender) ||
      /\b(?:mins?|minutes?|eta|on my way|running late)\b/i.test(text)
    ) continue;
    if (
      proposal && index > proposal.index && index <= proposal.index + 3 &&
      m.sender !== proposal.sender && acceptance.test(text.trim()) && !rejection.test(text)
    ) {
      if (proposal.dateProven)
        agreement = { source: "agreed_chat", date, time, confirmedAt: m.hygglo_sent_at ?? 0, evidenceHash: hash };
      proposal = undefined;
    }
    if (proposal && m.sender !== proposal.sender) proposal = undefined;
    const context = [...text.matchAll(/\b(pick\s*up|collect(?:ion)?|return|drop\s*(?:off|of)|back)\b/gi)];
    const clocks = exactChatClocks(text);
    for (let i = 0; i < context.length; i++) {
      const c = context[i], side = /^(?:return|drop|back)/i.test(c[0]) ? "return" : "pickup";
      const nextContext = context[i + 1]?.index ?? text.length;
      const contextStart = c.index ?? 0;
      const prefixStart = Math.max(0, contextStart - 24);
      const clause = text.slice(prefixStart, nextContext);
      const hasClockAfterContext = clocks.some(clock => clock.index >= contextStart + c[0].length && clock.index < nextContext);
      const hasClockBeforeFirstContext = i === 0 && clocks.some(clock => clock.index >= prefixStart && clock.index < contextStart);
      if (side === endpoint && hasScheduleTimingLanguage(clause) && !hasClockAfterContext && !hasClockBeforeFirstContext) {
        // A later ambiguous spoken hour, daypart, or date change makes old precision unsafe.
        agreement = undefined;
        proposal = undefined;
        invalidatedThrough = Math.max(invalidatedThrough, contextStart);
      }
    }
    for (const clock of clocks) {
      const preceding = context.filter(c => (c.index ?? 0) <= clock.index).at(-1);
      const following = context.find(c => (c.index ?? 0) > clock.index);
      const c = preceding ?? following;
      if (!c) continue;
      if (clock.index < invalidatedThrough) continue;
      const side = /^(?:return|drop|back)/i.test(c[0]) ? "return" : "pickup";
      if (side !== endpoint) continue;
      const nextContext = context.find(next => (next.index ?? 0) > clock.index)?.index ?? text.length;
      const clause = text.slice(c.index! > clock.index ? Math.max(0, clock.index - 15) : c.index!, nextContext);
      if (/\b(?:around|about|approximately|ish|before|after|by)\b/i.test(clause) || /\d\s*[-–]\s*\d/.test(clause)) {
        agreement = undefined;
        proposal = undefined;
        continue;
      }
      let dateProven = contextualDate;
      const day = Number(date.slice(8, 10));
      const namedDay = clause.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
      if (namedDay)
        dateProven = Number(namedDay[1]) === day && Math.abs(Date.parse(date) - Date.parse(bookedDate)) <= 3 * 86400000;
      if (/\b(?:today|tonight|tomorrow)\b/i.test(clause) && typeof m.hygglo_sent_at === "number") {
        const label = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(m.hygglo_sent_at));
        const expected = new Date(Date.parse(label + "T12:00Z") + (/\btomorrow\b/i.test(clause) ? 86400000 : 0))
          .toISOString().slice(0, 10);
        dateProven = date === expected;
      }
      contextualDate = dateProven;
      if (clock.time !== time || !dateProven) agreement = undefined;
      proposal = clock.time === time ? { index, sender: m.sender, dateProven } : undefined;
    }
  }
  return agreement;
}

/** Recover existing saved agreement candidates without another paid model call. */
export function recoverConfirmedChatClock(
  messages: BookingTimeMessage[],
  endpoint: "pickup" | "return",
  bookedDate: string,
  hash: string,
) {
  const clocks = new Set<string>();
  for (const message of messages)
    for (const clock of exactChatClocks(message.body_text)) clocks.add(clock.time);
  const proofs: ScheduleProof[] = [];
  for (let offset = -3; offset <= 3; offset++) {
    const date = new Date(Date.parse(bookedDate + "T12:00Z") + offset * 86400000).toISOString().slice(0, 10);
    for (const time of clocks) {
      const proof = confirmedChatClock(messages, endpoint, time, date, bookedDate, hash);
      if (proof) proofs.push(proof);
    }
  }
  proofs.sort((a, b) => b.confirmedAt - a.confirmedAt);
  return proofs.length && (!proofs[1] || proofs[0].confirmedAt !== proofs[1].confirmedAt)
    ? proofs[0]
    : undefined;
}
