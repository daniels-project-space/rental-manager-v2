type Message = { sender: string; hygglo_sent_at?: number; fetched_at?: number };
const valid = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? value! : 0;
/** Genuine renter activity only. Creation is a stable fallback for requests without chat. */
export function renterMessageWatermark(messages: readonly Message[], cached: number | undefined, created: number) {
  const renterTimes = messages.filter(message => message.sender === "renter")
    .map(message => valid(message.hygglo_sent_at) || valid(message.fetched_at));
  return Math.max(valid(cached), ...renterTimes) || valid(created);
}
