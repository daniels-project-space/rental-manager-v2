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
 *   ongoing  = confirmed AND start_date <= today <= end_date (gear out today).
 *              Past-end rentals drop out of the active widget even if the owner
 *              hasn't ticked RETURNED yet — Daniel does not want them lingering.
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
  return_date?: string;
  hygglo_order_id?: string;
  v1_rental_id?: string;
  account_slug?: string;
  renter_id?: string;
  renter_name?: string;
  is_obsolete?: boolean;
  order_step?: string;
  net_to_owner_gbp?: number;
  gross_paid_gbp?: number;
  // Item arrays — used by groupLogicalRentals to match the exact item set+qty.
  expanded_items?: Array<{ item_id?: string; qty?: number }>;
  resolved_items?: Array<{ item_id?: string; qty?: number }>;
  // Raw Hygglo listing identity. Fallback merge key when the internal catalog
  // item set is unresolved (resolution can lag the poller); product_id/slug
  // still uniquely identify the listing, so two bookings of the same Hygglo
  // product by the same renter can still be recognised as one logical rental.
  hygglo_items?: Array<{ product_id?: number | string; slug?: string }>;
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

/**
 * Effective pickup date for ACTIVE-state placement: prefer the negotiated
 * `pickup_date` (either earlier OR later than the Hygglo start_date), else
 * `start_date`. Mirrors convex/lib/effectiveDates.ts:displayPickupDate — kept
 * INLINE here (not imported) so this file stays cross-layer-mirrorable to
 * src/lib/reservations/predicates.ts with zero Convex dependency.
 */
export function displayPickupDate(r: { pickup_date?: string; start_date?: string }): string {
  return (r.pickup_date ?? r.start_date) ?? "";
}

/**
 * Effective return date: prefer AI-extracted `return_date` (extension agreed in
 * chat) over the raw Hygglo `end_date`. Mirrors
 * convex/lib/effectiveDates.ts:displayReturnDate (inlined — see above).
 */
export function displayReturnDate(r: { return_date?: string; end_date?: string }): string {
  return (r.return_date ?? r.end_date) ?? "";
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

/**
 * Confirmed AND today falls within [effective pickup, effective return].
 * Honors the negotiated pickup_date / return_date (display dates) so an early/
 * late handover or chat-agreed extension moves the active window. Rentals whose
 * effective return has passed disappear from the active widget here even if the
 * owner has not yet marked them RETURNED on Hygglo — that's deliberate.
 *
 * NOTE: this intentionally does NOT exclude order_step==="VERIFIED". A genuine
 * "pending-verification" item is status!=="confirmed" (it lives at
 * status="pending_review") and is therefore already excluded by
 * isConfirmedWithDates. A confirmed booking, however, passes transiently through
 * order_step VERIFIED / BOOKED_AFTER_VERIFIED between payment and handover —
 * adding !isPendingVerification here deleted those legitimate upcoming/ongoing
 * rentals from Active AND the calendar (regression 2026-06-02). order_step is
 * the NEXT-action step, not a "this row is fake" flag, so status is the correct
 * gate. See convex/order_step_semantics.ts.
 */
export function isOngoing(r: ReservationRow, today: string): boolean {
  return isConfirmedWithDates(r)
    && displayPickupDate(r) <= today
    && displayReturnDate(r) >= today;
}

/** Confirmed AND effective pickup is in the future. */
export function isUpcoming(r: ReservationRow, today: string): boolean {
  return isConfirmedWithDates(r) && displayPickupDate(r) > today;
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

// ── logical-rental grouping (extension / back-to-back merge) ─────────────────

/**
 * Canonical item-set key: sorted `item_id:totalQty`. Two rentals merge only if
 * this is byte-identical (exact item set AND quantities). Empty when the rental
 * has no resolved/expanded items — such rows never merge (we can't prove the
 * items match).
 */
export function itemSetKey(r: {
  expanded_items?: Array<{ item_id?: string; qty?: number }>;
  resolved_items?: Array<{ item_id?: string; qty?: number }>;
  hygglo_items?: Array<{ product_id?: number | string; slug?: string }>;
}): string {
  const src =
    r.expanded_items && r.expanded_items.length
      ? r.expanded_items
      : r.resolved_items ?? [];
  const byId = new Map<string, number>();
  for (const x of src) {
    if (!x.item_id) continue;
    byId.set(x.item_id, (byId.get(x.item_id) ?? 0) + (x.qty ?? 1));
  }
  if (byId.size > 0) {
    return Array.from(byId.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([id, q]) => `${id}:${q}`)
      .join(",");
  }
  // FALLBACK: internal catalog ids unresolved (resolution lags the poller, or
  // the listing was never mapped). Hygglo product_id (or slug) still uniquely
  // identifies the listing, so back-to-back bookings of the same Hygglo product
  // by the same renter can still merge. Prefixed "H#" so a Hygglo key can never
  // collide with an internal item_id key.
  const hy = r.hygglo_items ?? [];
  const byHy = new Map<string, number>();
  for (const x of hy) {
    const id = x.product_id != null ? String(x.product_id) : x.slug;
    if (!id) continue;
    byHy.set(id, (byHy.get(id) ?? 0) + 1);
  }
  if (byHy.size === 0) return "";
  return Array.from(byHy.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, q]) => `H#${id}:${q}`)
    .join(",");
}

export type LogicalRental = {
  /** Deterministic id = earliest member's reservation _id. */
  group_id: string;
  member_ids: string[];
  members: ReservationRow[];
  renter_id?: string;
  renter_name?: string;
  account_slug?: string;
  item_key: string;
  /** min effective pickup across members. */
  span_start: string;
  /** max effective return across members. */
  span_end: string;
  /** Σ net_to_owner across members (revenue is preserved, never dropped). */
  net_sum: number;
};

/**
 * Merge CONTIGUOUS rentals that share the same renter, account, and exact item
 * set+qty into one "large rental". Contiguity = the next effective pickup <= the
 * running effective return of the chain (same-day handover or overlap; a ≥1-day
 * gap starts a new rental). Rows are deduped first via dedupByLogicalRental.
 *
 * DISPLAY/COUNT grouping ONLY — callers keep raw rows for revenue-per-booking,
 * availability qty, and conflict detection. The group's `net_sum` preserves the
 * total (sum of members), so £ rollups are unchanged; only the rental COUNT
 * collapses.
 */
/**
 * Max idle gap (in days) still treated as ONE continuous rental. A Hygglo
 * return on day N followed by a re-pickup on day N+1 is a back-to-back
 * extension — the gear never goes back on the shelf — but Hygglo records it as
 * two separate orders. A >=2-day gap is a genuinely separate rental.
 */
const MERGE_GAP_DAYS = 1;

/** Add `n` days to an ISO yyyy-mm-dd date, returning ISO yyyy-mm-dd. */
function addDaysISO(iso: string, n: number): string {
  if (!iso) return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function groupLogicalRentals(rows: ReservationRow[]): LogicalRental[] {
  const deduped = dedupByLogicalRental(rows);
  const buckets = new Map<string, ReservationRow[]>();
  for (const r of deduped) {
    const ik = itemSetKey(r);
    if (ik === "") {
      // No resolved items → can't prove a match → never merge (own singleton).
      buckets.set(`solo:${r._id}`, [r]);
      continue;
    }
    const rk =
      r.renter_id ??
      (r.renter_name ? `n:${r.renter_name.trim().toLowerCase()}` : `u:${r._id}`);
    const key = `${rk}|${r.account_slug ?? "?"}|${ik}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  const out: LogicalRental[] = [];
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const pa = displayPickupDate(a);
      const pb = displayPickupDate(b);
      if (pa !== pb) return pa < pb ? -1 : 1;
      const ra = displayReturnDate(a);
      const rb = displayReturnDate(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    let chain: ReservationRow[] = [];
    let chainEnd = "";
    const flush = () => {
      if (chain.length) out.push(buildLogicalRental(chain));
      chain = [];
      chainEnd = "";
    };
    for (const r of arr) {
      const p = displayPickupDate(r);
      const e = displayReturnDate(r);
      if (chain.length === 0) {
        chain = [r];
        chainEnd = e;
      } else if (p <= addDaysISO(chainEnd, MERGE_GAP_DAYS)) {
        // contiguous, overlapping, OR a <=1-day handover gap (return day N,
        // re-pickup day N+1) — same physical gear across back-to-back orders.
        chain.push(r);
        if (e > chainEnd) chainEnd = e;
      } else {
        flush();
        chain = [r];
        chainEnd = e;
      }
    }
    flush();
  }
  return out;
}

function buildLogicalRental(members: ReservationRow[]): LogicalRental {
  const first = members[0];
  let span_start = displayPickupDate(first);
  let span_end = "";
  let net_sum = 0;
  for (const m of members) {
    const p = displayPickupDate(m);
    const e = displayReturnDate(m);
    if (p && (span_start === "" || p < span_start)) span_start = p;
    if (e > span_end) span_end = e;
    net_sum += netOf(m);
  }
  return {
    group_id: first._id,
    member_ids: members.map((m) => m._id),
    members,
    renter_id: first.renter_id,
    renter_name: first.renter_name,
    account_slug: first.account_slug,
    item_key: itemSetKey(first),
    span_start,
    span_end,
    net_sum,
  };
}

/**
 * reservation _id → logical group_id. Convenience for server queries that tag
 * each block/chip with the group it belongs to, so the frontend can re-key its
 * existing per-reservation Maps with zero merge logic in React.
 */
export function logicalGroupIds(rows: ReservationRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groupLogicalRentals(rows)) {
    for (const id of g.member_ids) m.set(id, g.group_id);
  }
  return m;
}

/**
 * Group ids for "ONE booking" = same renter + account whose rental periods
 * OVERLAP or sit within a 1-day handover — regardless of which items/listings.
 * A renter who books several listings together (and may negotiate an early/late
 * pickup of part of the gear) becomes a single calendar entry; genuinely
 * separate, non-overlapping rentals stay separate. Daniel, 2026-06-24
 * ("pull the listings together … only for same renter and same time period").
 */
export function renterPeriodGroupIds(rows: ReservationRow[]): Map<string, string> {
  const m = new Map<string, string>();
  const buckets = new Map<string, ReservationRow[]>();
  for (const r of rows) {
    const rk =
      r.renter_id ??
      (r.renter_name ? `n:${r.renter_name.trim().toLowerCase()}` : `u:${r._id}`);
    const key = `${rk}|${r.account_slug ?? "?"}`;
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const pa = displayPickupDate(a);
      const pb = displayPickupDate(b);
      if (pa !== pb) return pa < pb ? -1 : 1;
      const ra = displayReturnDate(a);
      const rb = displayReturnDate(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    // Pull together everything the same renter booked for the same overlapping
    // period into ONE tile — even when one order is COLLECTED and another
    // DELIVERED (Ella Griffith 2026-06-26: monitor collection + Ninja/transmitter
    // delivery). They're one rental; the merged tile combines all items and
    // surfaces delivery via preferDeliveryMethod so neither the transmitter nor
    // the delivery is lost. (Earlier we split on method conflict — that left her
    // gear in two fragments instead of pulled together; reverted 2026-06-26.)
    let chain: ReservationRow[] = [];
    let chainEnd = "";
    const flush = () => {
      if (chain.length) {
        const gid = chain[0]._id;
        for (const r of chain) m.set(r._id, gid);
      }
      chain = [];
      chainEnd = "";
    };
    for (const r of arr) {
      const p = displayPickupDate(r);
      const e = displayReturnDate(r);
      if (chain.length === 0) {
        chain = [r];
        chainEnd = e;
      } else if (p <= addDaysISO(chainEnd, MERGE_GAP_DAYS)) {
        chain.push(r);
        if (e > chainEnd) chainEnd = e;
      } else {
        flush();
        chain = [r];
        chainEnd = e;
      }
    }
    flush();
  }
  return m;
}
