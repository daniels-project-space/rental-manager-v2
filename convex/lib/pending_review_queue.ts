type PendingReviewRow = {
  status?: string | null;
  order_step?: string | null;
  is_obsolete?: boolean | null;
  start_date?: string | null;
  end_date?: string | null;
  return_date?: string | null;
  return_time?: string | null;
};

export type RentalLifecycleState = {
  status?: string | null;
  order_step?: string | null;
  is_obsolete?: boolean | null;
  last_sender?: string | null;
  human_requested?: boolean;
  is_request?: boolean;
};

const TERMINAL_STATUSES = new Set(["cancelled", "canceled", "declined", "denied"]);
const TERMINAL_ORDER_STEPS = new Set([
  "CANCELED", "CANCELLED", "DENIED", "VERIFICATION_FAILED", "REVIEWED",
]);

export function isClosedRentalLifecycle(state: RentalLifecycleState): boolean {
  return state.is_obsolete === true ||
    TERMINAL_STATUSES.has((state.status ?? "").toLowerCase()) ||
    TERMINAL_ORDER_STEPS.has((state.order_step ?? "").toUpperCase());
}

export function isAwaitingOwnerReply(state: RentalLifecycleState): boolean {
  if (isClosedRentalLifecycle(state)) return false;
  if (state.human_requested) return true;
  if (state.last_sender === "owner") return false;
  if (state.last_sender === "renter") return true;
  return state.is_request === true;
}

export function isOpenPendingReviewBooking(
  row: PendingReviewRow,
  today: string,
  timeNow: string,
): boolean {
  if (row.status !== "pending_review" || isClosedRentalLifecycle(row)) return false;

  const endDate = row.return_date ?? row.end_date ?? row.start_date;
  if (!endDate || endDate > today) return true;
  if (endDate < today) return false;
  const returnTime = row.return_time?.slice(0, 5);
  return !returnTime || returnTime > timeNow;
}

export function needsOwnerReply(
  conversation: RentalLifecycleState | null | undefined,
  booking?: Pick<PendingReviewRow, "status" | "order_step" | "is_obsolete">,
): boolean {
  return isAwaitingOwnerReply({
    ...booking,
    ...conversation,
    is_request: conversation?.is_request ?? booking?.status === "pending_review",
  });
}
