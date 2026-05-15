/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Reservation predicates — single source of truth (BACKEND).
 *  Mirror: src/lib/reservations/predicates.ts (keep in sync).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Pure functions for slicing the `reservations` table consistently. Every
 * dashboard widget and chat tool should compose from these — never inline
 * filters. When semantics change (e.g. the order_step fix on 2026-05-14)
 * this file is the only place to update.
 *
 * CANONICAL DEFINITIONS — extracted from the Active Rentals widget
 * (convex/dashboard.ts:getStatsDrawerData), which Daniel designates as the
 * source of truth for ongoing/upcoming/pending semantics:
 *
 *   live     = not cancelled/declined/obsolete (i.e. "counts for anything")
 *   confirmed = status === "confirmed" with dates set, not obsolete
 *   ongoing  = confirmed AND start_date <= today (gear out OR overdue)
 *   upcoming = confirmed AND start_date > today
 *   pending  = order_step === "VERIFIED" AND NOT obsolete
 *              → renter has paid AND is currently in document verification.
 *              See convex/order_step_semantics.ts for the full step table.
 *   paid     = live AND has effectiveDate <= today (revenue earned)
 *
 * "DELIVERED rentals whose end_date has passed but owner hasn't yet marked
 * RETURNED still appear as ongoing/overdue — mirrors Hygglo filter=future".
 */

// Structural type. We avoid importing Doc<"reservations"> here so the same
// file can be mirrored to the frontend without dragging Convex generated types.
export type ReservationRow = {
  _id: string;
  _creationTime: number;
  status: string;
  start_date?: string;
  end_date?: string;
  pickup_date?: string;
  hygglo_order_id?: string;
  v1_rental_id?: string;
  account_slug?: string;
  renter_id?: string;
  renter_name?: string;
  is_obsolete?: boolean;
  order_step?: string;
  net_to_owner_gbp?: number;
  gross_paid_gbp?: number;
};

// ── core derivations ─────────────────────────────────────────

/**
 * Date that revenue/calendar logic attributes the rental to. Pickup date
 * wins over the booking-window start because rentals can be picked up early
 * or late and revenue should land on the actual handover (BF-06).
 */
export function effectiveDate(r: { pickup_date?: string; start_date?: string }): string | undefined {
  return r.pickup_date ?? r.start_date;
}

/** Net amount the owner keeps (after Hygglo's platform fee). */
export function netOf(r: { net_to_owner_gbp?: number }): number {
  return r.net_to_owner_gbp ?? 0;
}

/**
 * Stable dedup key per logical rental. Hygglo order id wins (every poll-
 * synced row has one). v1_rental_id covers the historical import. The
 * renter+dates+account composite is only a fallback for ancient rows that
 * lack both — never use it as primary because legitimate separate orders by
 * the same renter on the same dates get collapsed (Hygglo poller audit
 * found this drop ~£156/month).
 */
export function dedupKey(r: ReservationRow): string {
  if (r.hygglo_order_id) return `H:${r.hygglo_order_id}`;
  if (r.v1_rental_id)    return `V:${r.v1_rental_id}`;
  return `F:${r.renter_id ?? r.renter_name ?? "?"}|${r.account_slug ?? "?"}|${r.start_date ?? ""}|${r.end_date ?? ""}`;
}

/** Dedup an array keeping the row with the largest net_to_owner_gbp on collision. */
export function dedupByLogicalRental<T extends ReservationRow>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) {
    const k = dedupKey(r);
    const ex = seen.get(k);
    if (!ex || netOf(r) > netOf(ex)) seen.set(k, r);
  }
  return Array.from(seen.values());
}

// ── reservation predicates ──────────────────────────────────

/** Row counts toward business state at all (excludes cancellations + denials). */
export function isLive(r: ReservationRow): boolean {
  return r.status !== "cancelled" && r.status !== "declined" && !r.is_obsolete;
}

/** Row is a confirmed booking with dates (a real booking entry). */
export function isConfirmedWithDates(r: ReservationRow): boolean {
  return r.status === "confirmed" && !r.is_obsolete
      && r.start_date !== undefined && r.end_date !== undefined;
}

/** Confirmed AND start has happened (gear out today OR overdue). */
export function isOngoing(r: ReservationRow, today: string): boolean {
  return isConfirmedWithDates(r) && (r.start_date as string) <= today;
}

/** Confirmed AND start is in the future. */
export function isUpcoming(r: ReservationRow, today: string): boolean {
  return isConfirmedWithDates(r) && (r.start_date as string) > today;
}

/**
 * Pending = renter has PAID (escrow funded) AND is currently doing ID/doc
 * verification. order_step stores the ACTIVE (next-to-do) step, so this is
 * exactly order_step===VERIFIED. See convex/order_step_semantics.ts for the
 * full active-step table.
 */
export function isPendingVerification(r: ReservationRow): boolean {
  return r.order_step === "VERIFIED" && !r.is_obsolete;
}

/** Revenue attribution: this row represents real money that landed. */
export function isEarned(r: ReservationRow, today: string): boolean {
  if (!isLive(r)) return false;
  const d = effectiveDate(r);
  return d !== undefined && d <= today;
}

/**
 * Paid-for-revenue check WITH v1 legacy fallback. Rows imported from v1
 * (Postgres rental table) have no order_step but trustworthy status — the
 * v1 importer set status="completed" on every historical paid rental
 * (1490 of 1490 v1 imports), so we must accept both "confirmed" (in-
 * progress) AND "completed" (finished) here. Previously only
 * "confirmed" passed, which silently dropped 99.4% of historical
 * revenue from every per-item earnings / ROI / payback / dust-collector
 * / kit-affinity query (audit: items.ts, intel.ts call sites).
 * Used by items.ts and intel.ts for revenue + utilization + cycle counts.
 * Currently-active queries upstream-filter by date range, so accepting
 * "completed" here doesn't leak historic rentals into "out of stock
 * today" style checks.
 */
export function isPaidWithV1Legacy(r: ReservationRow): boolean {
  if (r.is_obsolete) return false;
  if (r.order_step) {
    return (["VERIFIED","BOOKED_AFTER_VERIFIED","DELIVERED","RETURNED","REVIEWED"] as string[]).includes(r.order_step);
  }
  return r.status === "confirmed" || r.status === "completed";
}

/** Account scope filter. Passes a single-account predicate when slug given. */
export function inAccount(slug: string) {
  return (r: ReservationRow) => r.account_slug === slug;
}

// ── month/range helpers ─────────────────────────────────────

/** ISO date strings: row's effective date falls in [start, end] inclusive. */
export function inDateRange(r: ReservationRow, start: string, end: string): boolean {
  const d = effectiveDate(r);
  return d !== undefined && d >= start && d <= end;
}
