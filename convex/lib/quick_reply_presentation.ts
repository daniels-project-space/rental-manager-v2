export type QuickReplyStage = "enquiry" | "pending" | "confirmed" | "closed";
type StageInput = {
  has_reservation: boolean;
  paid?: boolean;
  verification_started?: boolean;
  platform_booking_confirmed?: boolean;
  source?: string;
  status: string | null;
  booking_status: string | null;
  order_step: string | null;
  is_request: boolean;
};
export function quickReplyStage(tile: StageInput): QuickReplyStage {
  if (
    [tile.status, tile.booking_status].some((status) =>
      [
        "cancelled",
        "canceled",
        "declined",
        "denied",
        "rejected",
        "expired",
      ].includes((status ?? "").toLowerCase()),
    )
  )
    return "closed";
  if (!tile.has_reservation || tile.paid !== true) return "enquiry";
  if (tile.platform_booking_confirmed === true) return "confirmed";
  return tile.verification_started === true ? "pending" : "enquiry";
}
type DuplicateInput = {
  start_date?: string | null;
  end_date?: string | null;
  thread_id: string;
  renter_identity?: string | null;
  account_slug: string | null;
  source?: string;
  items: Array<{ name: string; qty: number }>;
  net_to_owner_gbp: number | null;
  estimate_earnings_gbp: number | null;
};
/** Same person, same full requested basket, across distinct rental accounts. */
export function quickReplyDuplicateIds(rows: DuplicateInput[]): Set<string> {
  const groups = new Map<string, DuplicateInput[]>();
  for (const row of rows) {
    if (!row.renter_identity || !row.account_slug || !row.items.length)
      continue;
    const basket = row.items
      .map((item) => [
        item.name
          .normalize("NFKC")
          .toLocaleLowerCase("en-GB")
          .replace(/\s+/g, " ")
          .trim(),
        item.qty,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (
      basket.some(
        (item) =>
          !item[0] || !Number.isSafeInteger(item[1]) || Number(item[1]) <= 0,
      )
    )
      continue;
    const key = JSON.stringify([
      row.renter_identity,
      basket,
      row.start_date ?? null,
      row.end_date ?? null,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const duplicates = new Set<string>();
  for (const group of groups.values()) {
    if (new Set(group.map((row) => row.account_slug)).size < 2) continue;
    const winner = [...group].sort(
      (a, b) =>
        (b.net_to_owner_gbp ?? b.estimate_earnings_gbp ?? -1) -
        (a.net_to_owner_gbp ?? a.estimate_earnings_gbp ?? -1),
    )[0];
    for (const row of group)
      if (row.account_slug !== winner.account_slug)
        duplicates.add(row.thread_id);
  }
  return duplicates;
}
