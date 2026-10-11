export type BookingTimeMessage = {
  sender: string;
  body_text: string;
  hygglo_sent_at?: number;
};

/**
 * Stable bounded fingerprint for the exact transcript window sent to the
 * extractor. Includes sender and timestamp, unlike the previous last-200-char
 * suffix which collided once long chats kept a fixed 20-message window.
 */
export function hashBookingTimeTranscript(messages: BookingTimeMessage[]): string {
  let hash = 0x811c9dc5;
  for (const message of messages) {
    const value = `${message.sender}\u001f${message.hygglo_sent_at ?? 0}\u001f${message.body_text}\u001e`;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `v2:${messages.length}:${hash.toString(16).padStart(8, "0")}`;
}

/** True when a later message changes or reopens a specific pickup/return schedule. */
export function hasScheduleTimingLanguage(text: string): boolean {
  const contexts = [...text.matchAll(/\b(pick\s*up|collect(?:ion)?|return|drop\s*(?:off|of)|back)\b/gi)];
  return contexts.some((context, index) => {
    const start = Math.max(0, (context.index ?? 0) - 32);
    const end = contexts[index + 1]?.index ?? text.length;
    const clause = text.slice(start, end);
    return transcriptHasTimeLanguage([{ sender: "owner", body_text: clause }]) ||
      /\b(?:today|tomorrow|tonight|yesterday|later|earlier|during the day|end of day|next (?:day|week)|this week|first thing|close of play|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?:st|nd|rd|th))\b/i.test(clause);
  });
}

export function transcriptHasTimeLanguage(messages: BookingTimeMessage[]): boolean {
  const joined = messages.map((message) => message.body_text).join("\n");
  const numeric = /\d{1,2}\s*(?:am|pm|[.:]\d{2}|o['’]?clock)/i.test(joined);
  const natural = /\b(?:morning|evening|afternoon|noon|midday|midnight|half past|quarter past|quarter to|half seven|seven thirty)\b/i.test(joined);
  const spokenHour = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const spokenPhrase = "(?:(?:quarter\\s+(?:past|to)|half(?:\\s+past)?)\\s+)?" + spokenHour + "(?:\\s+(?:fifteen|thirty|forty[- ]five))?";
  const contextualSpoken = new RegExp(
    "\\b(?:at|around|about|by|before|after|from|pickup|collect(?:ion)?|return|drop[- ]?off|back)\\s+(?:at\\s+)?" + spokenPhrase + "\\b",
    "i",
  ).test(joined);
  const naturalSpoken = new RegExp(
    "\\b(?:(?:quarter\\s+(?:past|to)|half(?:\\s+past)?)\\s+" + spokenHour + "|" + spokenHour + "\\s+(?:fifteen|thirty|forty[- ]five))\\b",
    "i",
  ).test(joined);
  const spelledMeridiem = new RegExp(
    "\\b" + spokenHour + "(?:\\s+o['’]?clock)?\\s*[ap]\\.?m\\.?\\b",
    "i",
  ).test(joined);
  // Keep prose and equipment quantities out of the model lane while catching spoken clocks.
  const contextualHour = /\b(?:at|around|about|by|before|after|from|pickup|collect(?:ion)?|return|drop[- ]?off)\s+(?:at\s+)?(?:[0-2]?\d)(?:\s*(?:ish))?\b/i.test(joined);
  return numeric || natural || contextualHour || contextualSpoken || naturalSpoken || spelledMeridiem;
}
