export type QuickReplySort =
  | "priority"
  | "earnings"
  | "waiting"
  | "newest"
  | "oldest";
type Row = {
  thread_id: string;
  last_sender: string | null;
  last_renter_msg_at: number;
  last_activity_at: number;
  request_created_at?: number | null;
  net_to_owner_gbp: number | null;
  estimate_earnings_gbp: number | null;
  availability?: { status: string } | null;
};
const validTime = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
const earnings = (row: Row) => {
  const value = row.net_to_owner_gbp ?? row.estimate_earnings_gbp;
  return value != null && Number.isFinite(value) ? value : null;
};
/** Independent sorts have no earnings/time cross weighting; only Priority blends. */
export function compareQuickReplies(
  a: Row,
  b: Row,
  sort: QuickReplySort,
  now: number,
): number {
  const stable = () => a.thread_id.localeCompare(b.thread_id);
  if (sort === "earnings") {
    const av = earnings(a),
      bv = earnings(b);
    return av === null
      ? bv === null
        ? stable()
        : 1
      : bv === null
        ? -1
        : bv - av || stable();
  }
  if (sort === "waiting") {
    const av =
      a.last_sender === "renter" ? validTime(a.last_renter_msg_at) : null;
    const bv =
      b.last_sender === "renter" ? validTime(b.last_renter_msg_at) : null;
    return av === null
      ? bv === null
        ? stable()
        : 1
      : bv === null
        ? -1
        : av - bv || stable();
  }
  if (sort === "newest" || sort === "oldest") {
    const av = validTime(
        sort === "oldest" ? a.request_created_at : a.last_activity_at,
      ),
      bv = validTime(
        sort === "oldest" ? b.request_created_at : b.last_activity_at,
      );
    return av === null
      ? bv === null
        ? stable()
        : 1
      : bv === null
        ? -1
        : (sort === "oldest" ? av - bv : bv - av) || stable();
  }
  const score = (row: Row) =>
    2 * Math.log1p(Math.max(0, earnings(row) ?? 0)) +
    3 *
      Math.log1p(
        row.last_sender === "renter" && validTime(row.last_renter_msg_at)
          ? Math.max(0, (now - row.last_renter_msg_at) / 3_600_000)
          : 0,
      ) +
    (row.availability?.status === "available"
      ? 2
      : row.availability?.status === "conflict"
        ? -2
        : 0);
  return score(b) - score(a) || stable();
}
