/**
 * reconcile-holds.ts
 *
 * Pure-function helper: turns order-level ReservationInput rows into
 * item-day HoldInput rows, mirroring v1's reconciliation logic.
 *
 * No Convex imports. No side effects. Safe to unit-test in isolation.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReservationInput {
  _id: string;                        // Convex Id<"reservations"> as string
  hygglo_order_id?: string;
  account_slug: string;
  start_date: string | null;          // YYYY-MM-DD
  end_date: string | null;
  pickup_at?: number;                 // ms epoch override for start
  return_at?: number;                 // ms epoch override for end
  order_step?: string;                // REQUEST | APPROVED | FUNDS_RESERVED | …
  status?: string;                    // legacy: confirmed | pending_review | cancelled
  is_obsolete?: boolean;
  items?: Array<{ item_name: string }>;
  renter_name?: string;
}

export interface ItemRow {
  _id: string;                        // Convex Id<"items"> as string
  name: string;                       // canonical
  aliases?: string[];
  account_slug?: string;
  qty?: number;
}

export interface HoldInput {
  item_id: string;
  date: string;                       // YYYY-MM-DD
  reservation_id: string;
  account_slug: string;
  status: "confirmed" | "completed";
  qty_held?: number;
  renter_name?: string;
}

export interface ReconcileResult {
  holds: HoldInput[];
  deleteReservationIds: string[];
  unmatchedItemNames: string[];
  stats: {
    reservations_processed: number;
    holds_generated: number;
    skipped_pending: number;
    skipped_obsolete: number;
    forward_cap_skipped: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Steps where the renter has already paid (mirrors convex/hygglo.ts PAID_ORDER_STEPS).
 * Hardcoded here to keep this module free of Convex imports.
 */
const PAID_STEPS = new Set([
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
]);

/** Steps that terminate a reservation — remove existing holds. */
const DEAD_STEPS = new Set(["CANCELED", "VERIFICATION_FAILED"]);

/** Steps that mark a hold as "completed" rather than "confirmed". */
const COMPLETED_STEPS = new Set(["RETURNED", "REVIEWED"]);

const MS_PER_DAY = 86_400_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a YYYY-MM-DD string to a UTC midnight Date. */
function parseDate(s: string): Date {
  // Avoid local-timezone offset: parse as UTC directly.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date to a YYYY-MM-DD ISO string (UTC). */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Expand [startMs, endMs] into an array of YYYY-MM-DD strings using v1's
 * inclusive date math:  Math.max(1, Math.round(diff / MS_PER_DAY) + 1)
 */
function expandDates(startMs: number, endMs: number): string[] {
  const diffMs = endMs - startMs;
  const count = Math.max(1, Math.round(diffMs / MS_PER_DAY) + 1);
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    dates.push(formatDate(new Date(startMs + i * MS_PER_DAY)));
  }
  return dates;
}

/**
 * Resolve item_name → ItemRow.
 * Priority: account_slug-matching items first, then any.
 * Match order: exact canonical name (case-insensitive), then aliases.
 */
function resolveItem(
  itemName: string,
  items: ItemRow[],
  accountSlug: string
): ItemRow | null {
  const lower = itemName.toLowerCase().trim();

  // Two-pass: prefer account-matching items
  const pools: ItemRow[][] = [
    items.filter((r) => r.account_slug === accountSlug),
    items,
  ];

  for (const pool of pools) {
    // Exact name match
    const byName = pool.find((r) => r.name.toLowerCase().trim() === lower);
    if (byName) return byName;
    // Alias match
    const byAlias = pool.find((r) =>
      r.aliases?.some((a) => a.toLowerCase().trim() === lower)
    );
    if (byAlias) return byAlias;
  }
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeHoldsForReservations(args: {
  reservations: ReservationInput[];
  items: ItemRow[];
  today: Date;
  forwardCapDays?: number;
}): ReconcileResult {
  const { reservations, items, today, forwardCapDays = 180 } = args;

  const todayMs = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  );
  const forwardCapMs = todayMs + forwardCapDays * MS_PER_DAY;
  const pastWindowMs = todayMs - 30 * MS_PER_DAY;

  const holds: HoldInput[] = [];
  const deleteReservationIds: string[] = [];
  const unmatchedItemNames: string[] = [];

  let skipped_pending = 0;
  let skipped_obsolete = 0;
  let forward_cap_skipped = 0;

  for (const res of reservations) {
    const { _id, order_step, status, is_obsolete, account_slug } = res;

    // ── Rule 1a: Obsolete / dead steps → queue for deletion ──────────────────
    if (is_obsolete || (order_step && DEAD_STEPS.has(order_step))) {
      deleteReservationIds.push(_id);
      skipped_obsolete++;
      continue;
    }

    // ── Rule 1b: Determine if this reservation is "paid/active" ──────────────
    let isPaid: boolean;
    if (order_step) {
      isPaid = PAID_STEPS.has(order_step);
    } else {
      // Legacy fallback: no order_step present
      isPaid = status === "confirmed";
    }

    if (!isPaid) {
      skipped_pending++;
      continue;
    }

    // ── Rule 2 + 3: Resolve date range ────────────────────────────────────────
    let startMs: number;
    let endMs: number;

    if (res.pickup_at != null) {
      startMs = Date.UTC(
        new Date(res.pickup_at).getUTCFullYear(),
        new Date(res.pickup_at).getUTCMonth(),
        new Date(res.pickup_at).getUTCDate()
      );
    } else if (res.start_date) {
      startMs = parseDate(res.start_date).getTime();
    } else {
      // Missing start → skip
      continue;
    }

    if (res.return_at != null) {
      endMs = Date.UTC(
        new Date(res.return_at).getUTCFullYear(),
        new Date(res.return_at).getUTCMonth(),
        new Date(res.return_at).getUTCDate()
      );
    } else if (res.end_date) {
      endMs = parseDate(res.end_date).getTime();
    } else {
      // Missing end → skip
      continue;
    }

    // ── Rule 4: Forward cap + past window ─────────────────────────────────────
    const dateStrings = expandDates(startMs, endMs);
    const filteredDates: string[] = [];

    for (const ds of dateStrings) {
      const dMs = parseDate(ds).getTime();
      if (dMs > forwardCapMs) {
        forward_cap_skipped++;
        continue;
      }
      if (dMs < pastWindowMs) {
        forward_cap_skipped++;
        continue;
      }
      filteredDates.push(ds);
    }

    if (filteredDates.length === 0) continue;

    // ── Rule 7: Determine hold status ─────────────────────────────────────────
    const holdStatus: "confirmed" | "completed" =
      order_step && COMPLETED_STEPS.has(order_step) ? "completed" : "confirmed";

    // ── Rule 5: Resolve items ─────────────────────────────────────────────────
    const itemList = res.items ?? [];

    if (itemList.length === 0) {
      // No items array — skip silently (nothing to hold)
      continue;
    }

    for (const { item_name } of itemList) {
      if (!item_name?.trim()) continue;

      const resolved = resolveItem(item_name, items, account_slug);
      if (!resolved) {
        if (!unmatchedItemNames.includes(item_name)) {
          unmatchedItemNames.push(item_name);
        }
        continue;
      }

      // ── Rule 6: 1 hold per (item_id, date) per reservation ───────────────
      for (const date of filteredDates) {
        holds.push({
          item_id: resolved._id,
          date,
          reservation_id: _id,
          account_slug,
          status: holdStatus,
          // qty_held intentionally omitted (Wave-2.5)
          renter_name: res.renter_name || undefined,
        });
      }
    }
  }

  return {
    holds,
    deleteReservationIds,
    unmatchedItemNames,
    stats: {
      reservations_processed: reservations.length,
      holds_generated: holds.length,
      skipped_pending,
      skipped_obsolete,
      forward_cap_skipped,
    },
  };
}
