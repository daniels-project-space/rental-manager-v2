/**
 * Customer-segmentation metrics (Phase 5b).
 *
 *   computeRenterMetrics  → unique / repeat / new renter counts for a week.
 *   computeAvgResponseTime → mean minutes from first renter message to first
 *                             owner reply, across rentals in the week.
 *
 * Pure functions — no Convex ctx, no I/O. Caller provides pre-fetched rows.
 */

import type { Doc, Id } from "../_generated/dataModel";

export type RenterMetrics = {
  unique_renters: number;
  repeat_renter_count: number;
  new_renter_count: number;
};

/**
 * Stable renter key for grouping. Prefers renter_id → hygglo_user_id (via
 * renter_id is the v2 FK we already attached; legacy rows fall back to a
 * composite hash on renter_name/account_slug).
 */
function renterKey(r: Doc<"reservations">): string | null {
  if (r.renter_id) return `R:${String(r.renter_id)}`;
  // legacy fallback — never collide across accounts
  if (r.renter_name) return `N:${r.account_slug ?? "?"}|${r.renter_name}`;
  return null;
}

/**
 * Determine unique / repeat / new renter counts in a given week.
 *
 *   - unique_renters     : distinct renterKeys present in reservationsInWeek
 *   - repeat_renter_count: renters whose FIRST historical rental predates the
 *                          week's start (i.e. they had a prior rental).
 *   - new_renter_count   : renters whose FIRST historical rental falls inside
 *                          the week.
 *
 * Historical bound: we use start_date as the rental's effective date. Both
 * "in-week" sets share the same definition (start_date in [weekStart, weekEnd]).
 */
export function computeRenterMetrics(
  reservationsInWeek: Array<Doc<"reservations">>,
  allHistoricalReservations: Array<Doc<"reservations">>,
  weekStartISO: string,
): RenterMetrics {
  // First-rental map across the entire history.
  const firstRentalDate = new Map<string, string>();
  for (const r of allHistoricalReservations) {
    const k = renterKey(r);
    if (!k) continue;
    const d = r.start_date;
    if (!d) continue;
    const prev = firstRentalDate.get(k);
    if (prev === undefined || d < prev) firstRentalDate.set(k, d);
  }

  const inWeekKeys = new Set<string>();
  for (const r of reservationsInWeek) {
    const k = renterKey(r);
    if (k) inWeekKeys.add(k);
  }

  let repeat = 0;
  let neu = 0;
  for (const k of inWeekKeys) {
    const first = firstRentalDate.get(k);
    if (!first) continue;
    if (first < weekStartISO) repeat += 1;
    else neu += 1;
  }

  return {
    unique_renters: inWeekKeys.size,
    repeat_renter_count: repeat,
    new_renter_count: neu,
  };
}

/**
 * Average response time (minutes) — from the first renter message in a thread
 * to the first owner reply, averaged across the week's rentals.
 *
 *   - Skip rentals with no thread, no renter message, or no owner reply.
 *   - Use hygglo_messages indexed by thread_id. Owner = "me"/"owner"; renter
 *     = anything else (we accept "renter", "user", or sender_name matching
 *     reservation.renter_name).
 */
export function computeAvgResponseTime(
  reservationsInWeek: Array<Doc<"reservations">>,
  messagesByThread: Map<string, Array<Doc<"hygglo_messages">>>,
): { avg_response_time_minutes: number; sample_size: number } {
  const deltas: number[] = [];
  for (const r of reservationsInWeek) {
    const tid = r.hygglo_order_id;
    if (!tid) continue;
    const msgs = messagesByThread.get(tid);
    if (!msgs || msgs.length === 0) continue;

    // Sort ascending by hygglo_sent_at (fall back to fetched_at).
    const sorted = [...msgs].sort((a, b) => {
      const at = a.hygglo_sent_at ?? a.fetched_at;
      const bt = b.hygglo_sent_at ?? b.fetched_at;
      return at - bt;
    });

    // Find first renter message.
    let firstRenterTs: number | null = null;
    for (const m of sorted) {
      if (isRenter(m, r.renter_name)) {
        firstRenterTs = m.hygglo_sent_at ?? m.fetched_at;
        break;
      }
    }
    if (firstRenterTs === null) continue;

    // Find first owner reply AFTER firstRenterTs.
    let ownerTs: number | null = null;
    for (const m of sorted) {
      const ts = m.hygglo_sent_at ?? m.fetched_at;
      if (ts <= firstRenterTs) continue;
      if (isOwner(m)) {
        ownerTs = ts;
        break;
      }
    }
    if (ownerTs === null) continue;

    const diffMin = (ownerTs - firstRenterTs) / 60000;
    if (diffMin >= 0 && diffMin < 60 * 24 * 14) {
      // Cap at 14 days — anything longer is operationally irrelevant.
      deltas.push(diffMin);
    }
  }

  if (deltas.length === 0) {
    return { avg_response_time_minutes: 0, sample_size: 0 };
  }
  const sum = deltas.reduce((a, b) => a + b, 0);
  return {
    avg_response_time_minutes: sum / deltas.length,
    sample_size: deltas.length,
  };
}

function isOwner(m: Doc<"hygglo_messages">): boolean {
  const s = (m.sender ?? "").toLowerCase();
  return s === "me" || s === "owner" || s === "self";
}

function isRenter(
  m: Doc<"hygglo_messages">,
  renterName?: string,
): boolean {
  if (isOwner(m)) return false;
  const s = (m.sender ?? "").toLowerCase();
  if (s === "renter" || s === "user" || s === "other") return true;
  if (renterName && m.sender_name && m.sender_name === renterName) return true;
  // default: any non-owner message is a renter message
  return true;
}

/**
 * Helper for batch callers: group a flat list of hygglo_messages by thread_id.
 */
export function groupMessagesByThread(
  messages: Array<Doc<"hygglo_messages">>,
): Map<string, Array<Doc<"hygglo_messages">>> {
  const m = new Map<string, Array<Doc<"hygglo_messages">>>();
  for (const msg of messages) {
    if (!msg.thread_id) continue;
    let arr = m.get(msg.thread_id);
    if (!arr) {
      arr = [];
      m.set(msg.thread_id, arr);
    }
    arr.push(msg);
  }
  return m;
}

export type ReservationLite = Pick<
  Doc<"reservations">,
  "_id" | "renter_id" | "renter_name" | "account_slug" | "start_date" | "hygglo_order_id"
>;
