export type ReturnPresenceRow = {
  account: string;
  orderIds: string[];
};

export type ReturnStateRow = {
  status?: string;
  account_slug?: string;
  hygglo_order_id?: string;
  end_date?: string;
  order_step?: string;
  case_open?: boolean;
  is_obsolete?: boolean;
  platform_close_pending?: boolean;
  platform_closed_at?: number;
};

/** A locally completed return whose final Hygglo workflow still has work. */
export function isPlatformClosePending(row: ReturnStateRow): boolean {
  return (
    row.status === "completed" &&
    row.platform_close_pending === true &&
    row.platform_closed_at == null
  );
}

/**
 * Shared Return Hub state predicate. Completed rows are deliberately narrow:
 * they remain visible only while their idempotent Hygglo close is pending and
 * Hygglo still describes the order as physically out/returned. A completed row
 * that is fully closed must never re-enter the ordinary return flow.
 */
export function isOutstandingReturnState(row: ReturnStateRow, today: string): boolean {
  if (row.case_open || row.is_obsolete || row.order_step === "REVIEWED") return false;

  const physicallyOut =
    row.order_step === "DELIVERED" ||
    row.order_step === "RETURNED";

  if (row.status === "completed") {
    return isPlatformClosePending(row) && physicallyOut;
  }

  return (
    row.status === "confirmed" &&
    (physicallyOut || (!row.order_step && row.end_date !== undefined && row.end_date <= today))
  );
}

/** Exact current-feed membership. Used for completed close-pending rows. */
export function isInCurrentOrderPresence(
  row: Pick<ReturnStateRow, "account_slug" | "hygglo_order_id">,
  presenceRows: ReturnPresenceRow[],
): boolean {
  if (!row.account_slug || !row.hygglo_order_id) return false;
  const snapshot = presenceRows.find((presence) => presence.account === row.account_slug);
  return !!snapshot?.orderIds.includes(row.hygglo_order_id);
}

/** Keep Hygglo rentals present in the last complete `current` snapshot. */
export function filterByCurrentOrderPresence<
  T extends { account_slug?: string; hygglo_order_id?: string },
>(candidates: T[], presenceRows: ReturnPresenceRow[]): T[] {
  const currentIdsByAccount = new Map(
    presenceRows.map((row) => [row.account, new Set(row.orderIds)]),
  );
  return candidates.filter((row) => {
    if (!row.account_slug || !row.hygglo_order_id) return true;
    const currentIds = currentIdsByAccount.get(row.account_slug);
    // Preserve sources/accounts that are not populated by the Hygglo poller.
    return currentIds ? currentIds.has(row.hygglo_order_id) : true;
  });
}
