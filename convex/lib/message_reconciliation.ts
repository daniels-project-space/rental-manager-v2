export type ReconciliationMessage = {
  raw?: string;
  body_text: string;
  hygglo_sent_at?: number;
  fetched_at: number;
};

export function isMatchingOptimisticOwnerMessage(
  row: ReconciliationMessage,
  body: string,
  sentAt: number,
): boolean {
  return (
    row.raw === "manual_send_optimistic" &&
    row.body_text.trim() === body.trim() &&
    Math.abs((row.hygglo_sent_at ?? row.fetched_at) - sentAt) <= 30 * 60 * 1000
  );
}
