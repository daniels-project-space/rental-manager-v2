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

export function transcriptHasTimeLanguage(messages: BookingTimeMessage[]): boolean {
  const joined = messages.map((message) => message.body_text).join("\n");
  const numeric = /\d{1,2}\s*(?:am|pm|[.:]\d{2}|o['’]?clock)/i.test(joined);
  const natural = /\b(?:morning|evening|afternoon|noon|midday|midnight|half past|quarter past|quarter to|half seven|seven thirty)\b/i.test(joined);
  // Catch common shorthand such as "pickup around 7" without treating rental
  // durations, quantities or dates as time language and spending an LLM call.
  const contextualHour = /\b(?:at|around|about|by|before|after|from|pickup|collect(?:ion)?|return|drop[- ]?off)\s+(?:at\s+)?(?:[0-2]?\d)(?:\s*(?:ish))?\b/i.test(joined);
  return numeric || natural || contextualHour;
}
