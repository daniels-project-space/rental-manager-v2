export type QuickReplySort =
  | "priority"
  | "earnings"
  | "waiting"
  | "newest"
  | "oldest";
export type QuickReplySection = "todo" | "requests" | "all";
type Row = {
  thread_id: string;
  last_sender: string | null;
  last_renter_msg_at: number;
  last_activity_at: number;
  request_created_at?: number | null;
  net_to_owner_gbp: number | null;
  estimate_earnings_gbp: number | null;
  is_request?: boolean;
  human_requested?: boolean;
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
/** Explicit sorts stay independent; Priority adapts its weights to the active section. */
export function compareQuickReplies(
  a: Row,
  b: Row,
  sort: QuickReplySort,
  now: number,
  section: QuickReplySection = "todo",
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
  // The To reply section is explicitly an action queue, so an unanswered
  // renter stays ahead of an answered thread. The All section intentionally
  // drops this gate and ranks every conversation from its current live signals.
  if (section === "todo") {
    const aWaiting = a.last_sender !== "owner";
    const bWaiting = b.last_sender !== "owner";
    if (aWaiting !== bWaiting) return aWaiting ? -1 : 1;
  }
  const score = (row: Row) => {
    const waitingOnOwner = row.last_sender === "renter" ||
      (row.last_sender !== "owner" && (row.human_requested || row.is_request));
    const waitingSince = row.last_sender === "renter"
      ? validTime(row.last_renter_msg_at)
      : row.last_sender !== "owner" && row.is_request
        ? validTime(row.request_created_at)
        : null;
    const waitHours = waitingOnOwner && waitingSince
      ? Math.max(0, (now - waitingSince) / 3_600_000)
      : 0;
    const availability = row.availability?.status === "available"
      ? 1
      : row.availability?.status === "conflict"
        ? -1
        : 0;
    const value = Math.log1p(Math.max(0, earnings(row) ?? 0));
    if (section === "requests") {
      // In the request section, bookability is the strongest signal; age and
      // expected owner earnings break ties so fresh viable requests surface.
      return 4 * availability + 2.5 * Math.log1p(waitHours) + 1.5 * value;
    }
    if (section === "all") {
      // Keep replied rentals in the same live ranking, where a new renter
      // message immediately restores response urgency without a hard partition.
      return 20 * Number(waitingOnOwner) + 2 * Math.log1p(waitHours) +
        2 * value + 2 * availability;
    }
    // To reply: response urgency leads, followed by stock and owner return.
    return 8 * Number(waitingOnOwner) + 3 * Math.log1p(waitHours) +
      1.5 * value + 2 * availability;
  };
  return score(b) - score(a) || stable();
}
