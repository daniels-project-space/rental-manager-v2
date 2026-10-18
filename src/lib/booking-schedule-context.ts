import { sanitizeTime } from "./booking-time-extraction";
import { chronologicalBookingMessages, type BookingTimeMessage } from "./booking-time-transcript";

export type PriorScheduleClock = {time:string;date:string;confirmedAt:number};
type Endpoint = "pickup" | "return";
export const scheduleAcceptance = /^(?:yes(?:[!., ]|$)|yeah(?:[!., ]|$)|sure(?:[!., ]|$)|ok(?:ay)?(?:[!., ]|$)|alright(?:[!., ]|$)|perfect(?:[!., ]|$)|that works|sounds good|agreed|confirmed|no problem|all good|that's fine)/i;
export const scheduleRejection = /\b(?:not|no(?! problem)|can't|cannot|won't|however|but|instead|could|would|until|unfortunately)\b/i;
export const scheduleClockPattern = () => /\b(?:\d{1,2}(?:[:.]\d{2}\s*(?:[ap]\.?m\.?)?|\s*[ap]\.?m\.?)|noon|midday|midnight)\b/gi;
const contexts = () => /\b(pick\s*up|collect(?:ion)?|return|drop\s*(?:off|of)|back)\b/gi;
const sideOf = (text: string): Endpoint => /^(?:return|drop|back)/i.test(text) ? "return" : "pickup";
export const literalScheduleTime = (text: string) => /^(?:noon|midday)$/i.test(text) ? "12:00" : /^midnight$/i.test(text) ? "00:00" : sanitizeTime(text);
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

function resolveHour(hour: number, clause: string, anchor?: string): string | undefined {
  if (hour < 0 || hour > 23) return;
  if (hour > 12 || hour === 0) return `${String(hour).padStart(2, "0")}:00`;
  if (/\bmorning\b/i.test(clause)) return `${String(hour % 12).padStart(2, "0")}:00`;
  if (/\b(?:evening|afternoon|tonight)\b/i.test(clause)) return `${String(hour % 12 + 12).padStart(2, "0")}:00`;
  if (!anchor) return;
  const candidates = [hour % 12, hour % 12 + 12].map(h => `${String(h).padStart(2, "0")}:00`)
    .sort((a, b) => Math.abs(minutes(a) - minutes(anchor)) - Math.abs(minutes(b) - minutes(anchor)));
  // Only a short revision inherits an accepted clock's daypart.
  if (Math.abs(minutes(candidates[0]) - minutes(anchor)) >= 360) return;
  return candidates[0];
}

/** Resolve evidence-backed shorthand before the two-party acceptance guard.
 * Context survives small talk; source timestamps determine the latest update. */
export function contextualScheduleMessages(messages: BookingTimeMessage[], endpoint: Endpoint, bookedDate: string, prior?: PriorScheduleClock): BookingTimeMessage[] {
  const anchors: Partial<Record<Endpoint, string>> = {};
  // A long thread may have moved its original agreement outside the bounded
  // read. Only independently corroborated saved history can seed that context.
  const firstAt = Math.min(...messages.map(m => m.hygglo_sent_at ?? Infinity));
  if (prior?.date === bookedDate && prior.confirmedAt < firstAt && sanitizeTime(prior.time)) anchors[endpoint] = prior.time;
  let proposals: Array<{ side: Endpoint; time: string; sender: string; index: number }> = [];
  return chronologicalBookingMessages(messages).map((message, index) => {
    let text = message.body_text;
    if (!["owner", "renter"].includes(message.sender)) return message;
    if (scheduleAcceptance.test(text.trim()) && !scheduleRejection.test(text)) {
      for (const proposal of proposals) {
        if (proposal.sender !== message.sender && index - proposal.index <= 3) anchors[proposal.side] = proposal.time;
      }
    }
    proposals = proposals.filter(p => index - p.index <= 3 && p.sender === message.sender);
    let matches = [...text.matchAll(contexts())];
    // A lateness correction can omit the noun. Infer an endpoint only near
    // its accepted clock, on the booked London day, and without a competing
    // endpoint equally close to this message.
    if (!matches.length && anchors[endpoint] &&
        /\b(?:running (?:a (?:bit|little) )?late|later|earlier|instead|more like|change|reschedule|delayed)\b/i.test(text) &&
        /\b(?:be (?:with you|there)|arriv\w*|more like|make it)\b/i.test(text)) {
      const stamp = message.hygglo_sent_at;
      if (typeof stamp === "number") {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(stamp)).map(p => [p.type, p.value]));
        const today = `${parts.year}-${parts.month}-${parts.day}`;
        const now = Number(parts.hour) * 60 + Number(parts.minute);
        const ownDistance = Math.abs(minutes(anchors[endpoint]!) - now);
        const other = anchors[endpoint === "pickup" ? "return" : "pickup"];
        if (today === bookedDate && ownDistance <= 360 && (!other || ownDistance < Math.abs(minutes(other) - now))) {
          text = `${endpoint} ${text}`;
          matches = [...text.matchAll(contexts())];
        }
      }
    }
    // Bare hours need scheduling language plus a daypart or accepted clock.
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const match of text.matchAll(/\b(?:at|around|about|approximately|roughly|like|by|before|after|from)\s+(\d{1,2})(?:\s*(?:ish|o['’]?clock))?(?![\d:.])\b/gi)) {
      const at = match.index!;
      const tail = text.slice(at + match[0].length);
      if (/^\s*(?:[ap]\.?m|mins?\b|minutes?\b|hours?\b|days?\b|batteries\b|[-–/]|(?:st|nd|rd|th)\b)/i.test(tail)) continue;
      const context = matches.filter(c => c.index! <= at).at(-1) ?? matches.find(c => c.index! > at);
      if (!context) continue;
      const side = sideOf(context[0]);
      const end = matches.find(c => c.index! > Math.max(at, context.index!))?.index ?? text.length;
      const value = resolveHour(Number(match[1]), text.slice(context.index!, end), anchors[side]);
      if (!value) continue;
      const digitAt = at + match[0].indexOf(match[1]);
      replacements.push({ start: digitAt, end: digitAt + match[1].length, value: /^ish/i.test(text.slice(digitAt + match[1].length)) ? value + " " : value });
    }
    for (const replacement of replacements.reverse()) text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
    matches = [...text.matchAll(contexts())];
    const next: typeof proposals = [];
    for (const clock of text.matchAll(scheduleClockPattern())) {
      const context = matches.filter(c => c.index! <= clock.index!).at(-1) ?? matches.find(c => c.index! > clock.index!);
      if (!context) continue;
      const clauseStart = Math.min(context.index!, clock.index!);
      const clauseEnd = matches.find(c => c.index! > Math.max(context.index!, clock.index!))?.index ?? text.length;
      const clause = text.slice(Math.max(0, clauseStart - 12), clauseEnd);
      if (/\b(?:before|after|by|eta|minutes?|mins?|can't|cannot|not)\b|\d\s*[-–]\s*\d/i.test(clause)) continue;
      const time = literalScheduleTime(clock[0]);
      if (time) next.push({ side: sideOf(context[0]), time, sender: message.sender, index });
    }
    if (next.length) proposals = next;
    return { ...message, body_text: text };
  });
}
