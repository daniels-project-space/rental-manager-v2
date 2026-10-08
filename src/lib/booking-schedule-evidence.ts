import { sanitizeTime } from "./booking-time-extraction";
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
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index],
      text = m.body_text;
    if (
      !["owner", "renter"].includes(m.sender) ||
      /\b(?:mins?|minutes?|eta|on my way|running late)\b/i.test(text)
    )
      continue;
    if (
      proposal &&
      index > proposal.index &&
      index <= proposal.index + 3 &&
      m.sender !== proposal.sender &&
      acceptance.test(text.trim()) &&
      !rejection.test(text)
    ) {
      if (proposal.dateProven)
        agreement = {
          source: "agreed_chat",
          date,
          time,
          confirmedAt: m.hygglo_sent_at ?? 0,
          evidenceHash: hash,
        };
      proposal = undefined;
    }
    if(proposal && m.sender !== proposal.sender) proposal = undefined;
    const context = [
      ...text.matchAll(
        /\b(pick\s*up|collect(?:ion)?|return|drop\s*(?:off|of)|back)\b/gi,
      ),
    ];
    for(let i=0;i<context.length;i++){
      const c=context[i],side=/^(?:return|drop|back)/i.test(c[0])?"return":"pickup";
      const clause=text.slice(c.index!,context[i+1]?.index??text.length);
      if(side===endpoint && !/\d{1,2}(?:[:.]\d{2}|\s*[ap]\.?m)|noon|midday|midnight/i.test(clause) && /morning|evening|afternoon|during the day|tonight|tomorrow|\d+(?:st|nd|rd|th)/i.test(clause)){agreement=undefined;proposal=undefined;}
    }
    for (const clock of text.matchAll(
      /\b(?:\d{1,2}(?:[:.]\d{2}\s*(?:[ap]\.?m\.?)?|\s*[ap]\.?m\.?)|noon|midday|midnight)\b/gi,
    )) {
      const preceding = context.filter((c) => c.index! <= clock.index!).at(-1),
        following = context.find((c) => c.index! > clock.index!);
      const c = preceding ?? following;
      if (!c) continue;
      const side = /^(?:return|drop|back)/i.test(c[0]) ? "return" : "pickup";
      if (side !== endpoint) continue;
      const explicit = /^(?:noon|midday)$/i.test(clock[0])?"12:00":/^midnight$/i.test(clock[0])?"00:00":sanitizeTime(clock[0]);
      if (!explicit) continue;
      const clause = text.slice(
        c.index!>clock.index!?Math.max(0,clock.index!-15):c.index!,
        context.find((next) => next.index! > clock.index!)?.index ??
          text.length,
      );
      if (
        /\b(?:around|about|approximately|ish|before|after|by)\b/i.test(clause) ||
        /\d\s*[-–]\s*\d/.test(clause)
      ) {
        agreement = undefined;
        proposal = undefined;
        continue;
      }
      let dateProven = contextualDate;
      const day = Number(date.slice(8, 10));
      const namedDay = clause.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
      if (namedDay)
        dateProven =
          Number(namedDay[1]) === day &&
          Math.abs(Date.parse(date) - Date.parse(bookedDate)) <= 3 * 86400000;
      if (
        /\b(?:today|tonight|tomorrow)\b/i.test(clause) &&
        typeof m.hygglo_sent_at === "number"
      ) {
        const label = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/London",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(m.hygglo_sent_at));
        const expected = new Date(
          Date.parse(label + "T12:00Z") +
            (/\btomorrow\b/i.test(clause) ? 86400000 : 0),
        )
          .toISOString()
          .slice(0, 10);
        dateProven = date === expected;
      }
      contextualDate = dateProven;
      // A later different proposal invalidates a stale model candidate instead of freeing stock early.
      if (explicit !== time || !dateProven) agreement = undefined;
      proposal =
        explicit === time ? { index, sender: m.sender, dateProven } : undefined;
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
  for (const m of messages)
    for (const token of m.body_text.matchAll(
      /\b(?:\d{1,2}(?:[:.]\d{2}\s*(?:[ap]\.?m\.?)?|\s*[ap]\.?m\.?)|noon|midday|midnight)\b/gi,
    )) {
      const time = /^(?:noon|midday)$/i.test(token[0])?"12:00":/^midnight$/i.test(token[0])?"00:00":sanitizeTime(token[0]);
      if (time) clocks.add(time);
    }
  const proofs: ScheduleProof[] = [];
  for (let offset = -3; offset <= 3; offset++) {
    const date = new Date(
      Date.parse(bookedDate + "T12:00Z") + offset * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    for (const time of clocks) {
      const proof = confirmedChatClock(
        messages,
        endpoint,
        time,
        date,
        bookedDate,
        hash,
      );
      if (proof) proofs.push(proof);
    }
  }
  // An unresolved date interpretation must stay conservative.
  proofs.sort((a, b) => b.confirmedAt - a.confirmedAt);
  return proofs.length &&
    (!proofs[1] || proofs[0].confirmedAt !== proofs[1].confirmedAt)
    ? proofs[0]
    : undefined;
}
