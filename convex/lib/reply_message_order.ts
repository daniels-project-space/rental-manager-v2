/** Backfilled history must not move a newer reply below old messages. */
export function orderedReplyMessages<T extends { hygglo_sent_at?: number; fetched_at: number; message_id: string }>(messages: T[]): T[] {
  const at = (m: T) => Number.isFinite(m.hygglo_sent_at) ? m.hygglo_sent_at! : m.fetched_at;
  return [...messages].sort((a,b)=>at(b)-at(a)||b.message_id.localeCompare(a.message_id));
}
