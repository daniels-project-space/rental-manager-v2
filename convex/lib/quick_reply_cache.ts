/** A previous release's cached shape must not hide item checks or creation times. */
export function currentQuickReplyCache(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        row &&
        typeof row === "object" &&
        Object.prototype.hasOwnProperty.call(row, "request_created_at") &&
        Array.isArray(row.items) &&
        Array.isArray(row.requested_items) &&
        Array.isArray(row.availability?.items) &&
        row.items.length === row.availability.items.length,
    )
  );
}
