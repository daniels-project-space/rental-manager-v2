export type ReturnPresenceRow = {
  account: string;
  orderIds: string[];
};

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
