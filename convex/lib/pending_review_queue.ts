type PendingReviewRow = {
  status?: string | null;
  order_step?: string | null;
  is_obsolete?: boolean | null;
  start_date?: string | null;
  end_date?: string | null;
  return_date?: string | null;
  return_time?: string | null;
};

export function isOpenPendingReviewBooking(
  row: PendingReviewRow,
  today: string,
  timeNow: string,
): boolean {
  if (row.status !== "pending_review" || row.is_obsolete === true) return false;
  if (["CANCELED", "VERIFICATION_FAILED", "REVIEWED"].includes(row.order_step ?? "")) return false;

  const endDate = row.return_date ?? row.end_date ?? row.start_date;
  if (!endDate || endDate > today) return true;
  if (endDate < today) return false;
  const returnTime = row.return_time?.slice(0, 5);
  return !returnTime || returnTime > timeNow;
}

export function needsOwnerReply(conversation: { last_sender?: string | null } | null | undefined): boolean {
  return conversation?.last_sender === "renter";
}
