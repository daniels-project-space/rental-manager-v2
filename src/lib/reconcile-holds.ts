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
  /**
   * LLM-resolved or bundle-expanded item ids (preferred path). When present,
   * reconcile uses these directly and skips the naive name match — that
   * matcher cannot map raw Hygglo titles ("PIONEER RX3 – ALL IN ONE DJ DECK
   * – DJ CONTROLLER – …") to our canonical item names ("DJ RX3 Pioneer
   * controller") and silently emits no holds.
   */
  resolved_items?: Array<{ item_id: string; qty?: number }>;
  expanded_items?: Array<{ item_id: string; qty?: number }>;
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

import { PAID_ORDER_STEPS, DEAD_ORDER_STEPS } from "./order_step_semantics";

// Source-of-truth sets sourced from the canonical predicate module so any
// semantics change in predicates.ts (e.g. the active-step fix on 2026-05-14)
// propagates here without a separate edit.
const PAID_STEPS = new Set<string>(PAID_ORDER_STEPS);
const DEAD_STEPS = new Set<string>(DEAD_ORDER_STEPS);

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
    // Preferred path: trust the LLM resolver / bundle expander. expanded_items
    // is bundle-decomposed (e.g. "Sony FX3 kit" → FX3 + 24-70mm lens),
    // resolved_items is the per-position output. Either gives the item_id
    // directly so we don't have to canonicalise Hygglo titles ourselves —
    // the legacy resolveItem() exact-name match can't handle modern Hygglo
    // titles like "PIONEER RX3 – ALL IN ONE DJ DECK – …".
    const expanded = res.expanded_items ?? [];
    const resolved = res.resolved_items ?? [];
    const idEntries = expanded.length > 0 ? expanded : resolved;
    if (idEntries.length > 0) {
      const itemById = new Map(items.map((i) => [i._id, i]));
      const writtenItemIds = new Set<string>();
      for (const e of idEntries) {
        const idStr = String(e.item_id);
        if (writtenItemIds.has(idStr)) continue;
        const item = itemById.get(idStr);
        if (!item) continue;
        if (item.account_slug && item.account_slug !== account_slug) continue;
        writtenItemIds.add(idStr);
        for (const date of filteredDates) {
          holds.push({
            item_id: idStr,
            date,
            reservation_id: _id,
            account_slug,
            status: holdStatus,
            renter_name: res.renter_name || undefined,
          });
        }
      }
      continue;
    }

    // Legacy fallback: only used when neither expanded_items nor resolved_items
    // exist on the row (e.g. ancient v1 imports without LLM resolution).
    const itemList = res.items ?? [];
    if (itemList.length === 0) continue;

    for (const { item_name } of itemList) {
      if (!item_name?.trim()) continue;

      const found = resolveItem(item_name, items, account_slug);
      if (!found) {
        if (!unmatchedItemNames.includes(item_name)) {
          unmatchedItemNames.push(item_name);
        }
        continue;
      }

      // ── Rule 6: 1 hold per (item_id, date) per reservation ───────────────
      for (const date of filteredDates) {
        holds.push({
          item_id: found._id,
          date,
          reservation_id: _id,
          account_slug,
          status: holdStatus,
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
