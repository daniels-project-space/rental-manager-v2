const HOUR = 3600000;

function windows(rows: any[], kind: "claim" | "site"): string | null {
  if (!Array.isArray(rows) || !rows.length || rows.length > 512) return null;
  const totals = new Map<string, number>();
  for (const row of rows) {
    const itemId = row?.item_id;
    const end = kind === "site" && row?.endExclusive === true && row?.stockWindowVersion === 2
      ? row.end + (60 - (row.turnaroundBufferMinutes ?? 0)) * 60000
      : kind === "site" ? row?.end + HOUR : row?.end;
    if (typeof itemId !== "string" || !itemId || !Number.isSafeInteger(row?.start) || !Number.isSafeInteger(end) || end <= row.start || !Number.isSafeInteger(row?.qty) || row.qty < 1) return null;
    const key = JSON.stringify([itemId, row.start, end]);
    const total = (totals.get(key) ?? 0) + row.qty;
    if (!Number.isSafeInteger(total)) return null;
    totals.set(key, total);
  }
  return JSON.stringify([...totals].sort(([left], [right]) => left.localeCompare(right)));
}

export function isExactPaidClaimMirror(claim: any, reservations: any[]): boolean {
  const args = claim?.request_payload?.args;
  if (claim?.request_payload?.operation !== "acquirePaidBooking" || claim.holds_stock !== true || claim.status !== "execution_started" ||
      typeof claim.booking_id !== "string" || args?.bookingId !== claim.booking_id || args?.requestId !== `booking_${claim.booking_id}` ||
      claim.request_id !== args.requestId || claim.execution_key !== `booking_execution_${claim.booking_id}` || args.verificationState !== "pending" || !Number.isSafeInteger(args.bookingRevision)) return false;
  const evidence = args.paymentEvidence;
  if (!evidence || !Number.isSafeInteger(evidence.paidAt) || !(evidence.status === "succeeded" && typeof evidence.paymentIntentId === "string" && evidence.paymentIntentId || evidence.status === "no_payment_required" && typeof evidence.checkoutSessionId === "string" && evidence.checkoutSessionId)) return false;
  if (!Array.isArray(args.items)) return false;
  const requested = windows(args.items.map((item: any) => ({item_id:item.itemId,start:item.start,end:item.returnAt + HOUR,qty:item.quantity})), "claim");
  const rows = reservations.filter(row => row.account_slug === "dbcinema_web" && row.hygglo_order_id === claim.booking_id && !row.is_obsolete && ["pending_review", "confirmed", "ongoing"].includes(row.status) && row.order_step !== "REVIEWED");
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0].site_revision) || rows[0].site_revision < args.bookingRevision) return false;
  const claimed = windows(claim.items, "claim"), mirrored = windows(rows[0].site_item_windows, "site");
  return claimed !== null && claimed === mirrored && claimed === requested;
}
