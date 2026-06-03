/**
 * parity-projection — VERBATIM ports of the server-side row-transform logic in
 * `convex/hygglo.ts:upsertOrderImpl`, used by parity-dryrun.ts to project a
 * core upsert arg into the ROW the server would store.
 *
 * Why this exists: the dry-run MUST compare the row the core→server pipeline
 * would land vs the row the live poller→server pipeline already landed. The
 * server does NOT store the payload verbatim — it DERIVES several fields
 * (`status` from order_step+sourceFilter, `is_obsolete`/`obsolete_reason` from
 * step, and projects `items` to a minimal shape). Replicating that transform
 * here (kept byte-for-byte in sync with convex/hygglo.ts) lets the diff isolate
 * REAL mapping deltas from server transforms that both pipelines share.
 *
 * ⚠️ Keep in sync with convex/hygglo.ts. If the server's derivation changes,
 * update these copies. Pure — no I/O.
 */

import type { HyggloOrderStepKey } from "../types";

/** Mirror of convex/order_step_semantics.ts STEP_PRIORITY (unused by the diff
 *  but kept for completeness / future regression-aware projections). */
export const STEP_PRIORITY: Record<string, number> = {
  REVIEWED: 8,
  RETURNED: 7,
  DELIVERED: 6,
  BOOKED_AFTER_VERIFIED: 5,
  VERIFIED: 4,
  FUNDS_RESERVED: 3,
  APPROVED: 2,
  REQUEST: 1,
  CANCELED: 0,
  VERIFICATION_FAILED: 0,
};

/**
 * VERBATIM from convex/hygglo.ts:deriveStatusFromStep.
 * sourceFilter is the ground-truth bucket; step is the fallback for unknown
 * buckets. Returns the `status` literal the server stores.
 */
export function deriveStatusFromStep(
  step: string | null | undefined,
  sourceFilter: string | null | undefined,
): "confirmed" | "pending_review" | "completed" | "cancelled" {
  if (sourceFilter === "obsolete") return "cancelled";
  if (sourceFilter === "pending") return "pending_review";
  if (sourceFilter === "current") {
    return step === "REVIEWED" ? "completed" : "confirmed";
  }
  if (sourceFilter === "future") return "confirmed";
  switch (step) {
    case "REQUEST":
    case "APPROVED":
    case "FUNDS_RESERVED":
      return "pending_review";
    case "VERIFIED":
    case "BOOKED_AFTER_VERIFIED":
    case "DELIVERED":
    case "RETURNED":
      return "confirmed";
    case "REVIEWED":
      return "completed";
    case "CANCELED":
    case "VERIFICATION_FAILED":
      return "cancelled";
    default:
      return "pending_review";
  }
}

/**
 * VERBATIM from convex/hygglo.ts:upsertOrderImpl obsolete-field derivation
 * (L610-625). Only sourceFilter==="obsolete" rows get is_obsolete=true; the
 * reason is inferred from the active step. Non-obsolete rows return {} (the
 * server writes neither field, and — via the un-obsolete patch — may CLEAR a
 * stale is_obsolete=true; for a fresh comparison we treat absence as not-set).
 */
export function serverObsoleteFields(
  sourceFilter: string | null | undefined,
  incomingStep: string | null | undefined,
): { is_obsolete?: boolean; obsolete_reason?: string } {
  if (sourceFilter !== "obsolete") return {};
  let reason: "owner_denied" | "renter_cancelled" | "verification_failed" | "other";
  if (incomingStep === "REQUEST") {
    reason = "owner_denied";
  } else if (incomingStep === "CANCELED") {
    reason = "renter_cancelled";
  } else if (incomingStep === "VERIFIED" || incomingStep === "FUNDS_RESERVED") {
    reason = "verification_failed";
  } else {
    reason = "other";
  }
  return { is_obsolete: true, obsolete_reason: reason };
}

/**
 * VERBATIM from convex/hygglo.ts:upsertOrderImpl items projection (baseFields):
 *   items: args.items.map((i) => ({ item_name, ...(qty !== undefined && {qty}) }))
 * The rich Hygglo metadata (image/type/product_id/slug) is intentionally NOT
 * stored on `reservations.items[]` — it lives in `hygglo_items[]`. So the row's
 * `items` only ever has item_name (+ optional qty).
 */
export function projectItems(
  items: Array<{ item_name: string; qty?: number }>,
): Array<{ item_name: string; qty?: number }> {
  return (items ?? []).map((i) =>
    i.qty !== undefined
      ? { item_name: i.item_name, qty: i.qty }
      : { item_name: i.item_name },
  );
}

/** The core's per-order `upsertOrdersAsReservationsBatch` arg (subset the diff
 *  needs). Matches ReservationUpsertArgs from ../types. */
export interface CoreReservationArg {
  account_slug?: string;
  hygglo_order_id: string;
  status: string;
  start_date: string;
  end_date: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  currency?: string;
  items: Array<{ item_name: string; qty?: number }>;
  duration_days?: number;
  order_step_extracted?: HyggloOrderStepKey;
  sourceFilter?: string;
  renter_name?: string;
  hygglo_user_id?: string;
  booking_status?: string;
  pickup_time?: string;
  return_time?: string;
  pickup_method?: string;
  return_method?: string;
  notes?: string;
  photos_urls?: string[];
  latest_activity?: number | string;
  hygglo_system_signal?: string;
  hygglo_system_signal_text?: string;
}
