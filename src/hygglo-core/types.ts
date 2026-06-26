/**
 * hygglo-core/types — Hygglo private REST API response types + the Convex
 * upsert payload types.
 *
 * Two families:
 *   1. `Hygglo*` types model the JSON Hygglo's API actually returns (orders v4,
 *      catalog v2). Loosely typed where Hygglo's schema is inconsistent across
 *      versions (optional everywhere) so the mappers in `shape.ts` stay total.
 *   2. `Upsert*` / `*Payload` types model the EXACT argument shapes accepted by
 *      the canonical Convex mutations in `convex/hygglo.ts`
 *      (upsertOrdersAsReservationsBatch, upsertMessages, upsertRentersBatch,
 *      upsertConversationsBatch). The mappers MUST output these field-for-field.
 *
 * Verified against fixtures in /home/ubuntu/hygglo-probe/out/*.json (2026-06-03)
 * and the validators in convex/hygglo.ts.
 */

import type { HyggloAccount } from "./auth-account";

// ════════════════════════════════════════════════════════════════════════
//  ORDERS v4 — API response types
// ════════════════════════════════════════════════════════════════════════

/** One element of an order's `activities[]`. Either a chat message OR a system
 *  event ("blue text"); some carry neither. Mirrors poll-hygglo.ts `Activity`. */
export interface HyggloActivity {
  key: string;
  chatMessage?: {
    text?: { content?: string };
    byMe?: boolean;
    hidden?: boolean;
  };
  /** Hygglo system events — drives `hygglo_system_signal` derivation. */
  event?: { title?: string; content?: string };
  createdAtLabel?: string;
}

/** Per-item image block on an order detail. Hygglo's live schema only reliably
 *  returns `fullSizeUrl` + `thumbnailUrl`; the rest are kept optional because
 *  the Convex validator accepts them and older payloads carried them. */
export interface HyggloOrderItemImage {
  url?: string;
  originalUrl?: string;
  largeUrl?: string;
  mediumUrl?: string;
  thumbnailUrl?: string;
  fullSizeUrl?: string;
}

/** One element of an order detail's `items[]`. */
export interface HyggloOrderItem {
  name?: string;
  type?: string; // "PRODUCT" | "INSURANCE" | ...
  itemId?: number;
  productId?: number;
  slug?: string;
  qty?: number;
  image?: HyggloOrderItemImage;
}

/** One step in the order lifecycle (`steps[]` on the detail endpoint). */
export interface HyggloOrderStep {
  key: string;
  active?: boolean;
  completed?: boolean;
  failure?: boolean;
  label?: string;
}

/** Amount block inside price.breakdown.* */
export interface HyggloAmount {
  amount?: number;
  amountLabel?: string;
  label?: string;
}

/** Full order-detail payload from `GET /v4/my/orders/{id}`.
 *  Loosely typed — Hygglo nests inconsistently across API versions. The
 *  mappers read defensively. `booking`/`notes`/`photos_urls`/`detail` are not
 *  present in the current GB fixture but the shaping logic probes for them
 *  (parity with poll-hygglo.ts), so they are declared optional here. */
export interface HyggloOrderDetail {
  id: number;
  activities?: HyggloActivity[];
  users?: {
    me?: { id?: number | string; name?: string };
    otherPart?: { name?: string; id?: number | string };
  };
  labels?: { otherPart?: string };
  rentalPeriod?: { startDateUTC?: string; endDateUTC?: string };
  price?: {
    currency?: string;
    total?: number;
    ownerEarnings?: number;
    breakdown?: {
      totalPrice?: HyggloAmount;
      lenderEarnings?: HyggloAmount;
    };
  };
  items?: HyggloOrderItem[];
  steps?: HyggloOrderStep[];
  /** Present on some payloads — carries booking-time/method fields. */
  booking?: {
    status?: string;
    pickup_time?: string;
    return_time?: string;
    pickup_method?: string;
    return_method?: string;
  };
  notes?: string;
  photos_urls?: string[];
  /** Some payloads nest a second `detail` object with notes/photos. */
  detail?: { notes?: string; photos_urls?: string[] };
}

/** One element of an orders LIST response (`GET /v4/my/orders?...`). Hygglo
 *  returns a bare array of these (per fixtures). Only `id` is reliable; the
 *  `latest_activity`-style fields are probed by name (none present in GB
 *  fixtures, all optional). */
export interface HyggloOrderListItem {
  id: number;
  latest_activity?: number | string;
  latestActivity?: number | string;
  last_activity_at?: number | string;
  lastActivityAt?: number | string;
  updated_at?: number | string;
  updatedAt?: number | string;
  [k: string]: unknown;
}

/** The four owner-order filters Hygglo exposes. */
export type HyggloOrderFilter = "current" | "future" | "pending" | "obsolete";

/** Result envelope for writes (Phase 4). Mirrors src/lib/hygglo-write.ts's
 *  `HyggloWriteResult` so the eventual live writers slot into the same callers. */
export interface HyggloWriteResult {
  status: "sent" | "skipped" | "failed";
  httpStatus?: number;
  error?: string;
  reason?:
    | "READ_ONLY_MODE"
    | "RETURN_WRITES_DISABLED"
    | "MANUAL_SEND_DISABLED"
    | "MANUAL_ACTION_DISABLED";
}

/** A list item enriched with the filter it was fetched under + the resolved
 *  latest_activity. Internal carrier between `listOrders` and the mappers. */
export interface OrderWithFilter {
  id: number;
  sourceFilter: HyggloOrderFilter;
  latest_activity?: number | string;
}

// ════════════════════════════════════════════════════════════════════════
//  CATALOG v2 — API response types
// ════════════════════════════════════════════════════════════════════════

export interface HyggloProductImage {
  id?: number;
  thumbnailUrl?: string;
  fullSizeUrl?: string;
  filename?: string;
  rotation?: number;
  productId?: number;
}

export interface HyggloProductPrice {
  id?: number;
  productId?: number;
  pricePerDay?: number;
  days?: number;
  price?: number;
}

export interface HyggloProductListing {
  id?: number;
  slug?: string;
  productId?: number;
  publicUrl?: string;
  location?: unknown;
}

/** Product list element from `GET /v2/my/products` (bare array per fixture). */
export interface HyggloProductListItem {
  id: number;
  name?: string;
  isPublished?: boolean;
  categoryId?: number;
  valuation?: number;
  minimumRentalDays?: number;
  highestPricePerDay?: number;
  lowestPricePerDay?: number;
  currency?: string;
  images?: HyggloProductImage[];
  prices?: HyggloProductPrice[];
  listings?: HyggloProductListing[];
  publicUrl?: string;
}

/** Full product detail from `GET /v2/my/products/{id}`. */
export interface HyggloProductDetail extends HyggloProductListItem {
  description?: string;
  ownerId?: number;
  createdAt?: string;
  updatedAt?: string;
  cancellationTerms?: string;
  stockLevel?: number;
  unavailableDates?: unknown[];
  currency?: string;
}

/** Public listing from `GET /v2/product-listings/{id}?country=GB` (no token). */
export interface HyggloPublicListing {
  id: number;
  slug?: string;
  publicUrl?: string;
  isFavorite?: boolean;
  product?: unknown;
  location?: unknown;
  labels?: unknown;
}

// ════════════════════════════════════════════════════════════════════════
//  CONVEX UPSERT PAYLOAD TYPES — must mirror convex/hygglo.ts validators
// ════════════════════════════════════════════════════════════════════════

/** Mirror of `orderItemArgs` (convex/hygglo.ts). */
export interface ReservationItemPayload {
  item_name: string;
  qty?: number;
  image?: {
    url?: string;
    originalUrl?: string;
    largeUrl?: string;
    mediumUrl?: string;
    thumbnailUrl?: string;
    fullSizeUrl?: string;
  };
  type?: string;
  product_id?: number;
  slug?: string;
}

export type HyggloSystemSignal =
  | "owner_denied"
  | "renter_cancelled"
  | "auto_cancelled"
  | "verification_failed"
  | "approved"
  | "none";

export type HyggloOrderStepKey =
  | "REQUEST"
  | "APPROVED"
  | "FUNDS_RESERVED"
  | "VERIFIED"
  | "BOOKED_AFTER_VERIFIED"
  | "DELIVERED"
  | "RETURNED"
  | "REVIEWED"
  | "CANCELED"
  | "VERIFICATION_FAILED";

/**
 * Mirror of `upsertOrderArgsFields` (convex/hygglo.ts) — the per-order element
 * of `upsertOrdersAsReservationsBatch({ orders: [...] })`.
 *
 * `account_slug`, `order` and `order_step_extracted` are appended by the
 * polling task at batch-build time, NOT by the pure mapper. `orderToReservation`
 * produces everything EXCEPT those three (it returns a `ReservationPayload`
 * shaped from the order detail; the task adds account_slug + the
 * pre-extracted-step optimisation fields). Keeping them optional here lets the
 * same type describe both the mapper output and the final mutation arg.
 */
export interface ReservationUpsertArgs {
  account_slug?: string;
  hygglo_order_id: string;
  status: string;
  start_date: string;
  end_date: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  currency?: string;
  items: ReservationItemPayload[];
  duration_days?: number;
  order?: HyggloOrderDetail;
  /** B2 — full per-order detail blob, ALWAYS carried (unlike `order`, which the
   *  hot path strips on non-denial rows). Consumer-side ONLY: feeds the
   *  listing-resolver's `hygglo_detail_payload` for newly-inserted listings; it
   *  is NEVER forwarded to `upsertOrdersAsReservationsBatch` (the task whitelists
   *  the mutation args explicitly), so it adds zero upload bandwidth + touches no
   *  money field. */
  detail_payload?: HyggloOrderDetail;
  order_step_extracted?: HyggloOrderStepKey;
  /** Reply Inbox: Hygglo `actions` map offers accept/deny (awaiting my approval). */
  awaiting_owner_action?: boolean;
  /** Granular owner actions still on the order (2026-06-26). Lets Quick Reply
   *  show only Decline once accept is gone (I've approved). Same `actions` map. */
  can_accept?: boolean;
  can_deny?: boolean;
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
  hygglo_system_signal?: HyggloSystemSignal;
  hygglo_system_signal_text?: string;
}

/**
 * The mapper's reservation output. Identical to the poll-hygglo.ts
 * `OrderReservationPayload` SHAPING SCOPE: everything the pure mapper can
 * compute from (orderDetail, sourceFilter). It always carries the raw `order`
 * (the task later strips it on the non-denial hot path) and never carries
 * `account_slug`/`order_step_extracted` (task-only fields).
 */
export interface ReservationPayload {
  hygglo_order_id: string;
  status: string;
  start_date: string;
  end_date: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  currency?: string;
  items: ReservationItemPayload[];
  duration_days?: number;
  sourceFilter: string;
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
  order: HyggloOrderDetail;
  hygglo_system_signal?: HyggloSystemSignal;
  hygglo_system_signal_text?: string;
}

/** Mirror of one element of `messageArgs` (convex/hygglo.ts upsertMessages). */
export interface MessagePayload {
  thread_id: string;
  message_id: string;
  sender: string; // "owner" | "renter"
  sender_name?: string;
  body_text: string;
  hygglo_sent_at?: number;
  fetched_at: number;
  raw?: string;
}

/** Mirror of one element of `upsertRentersBatch({ renters: [...] })`. */
export interface RenterPayload {
  hygglo_user_id?: string;
  display_name: string;
}

/** Mirror of one element of `upsertConversationsBatch({ conversations: [...] })`. */
export interface ConversationPayload {
  thread_id: string;
  hygglo_user_id?: string;
  display_name: string;
  last_msg_at: number;
  created_at: number;
  // Date-less inquiry product snapshot (renter asked "is this available?"
  // without dates → no reservation row). Lets the Reply Inbox tile show the
  // listing being asked about. Populated by corePoll via orderToInquiryItems.
  inquiry_items?: Array<{ name: string; qty: number; image_url?: string }>;
  inquiry_image_url?: string;
}

/**
 * Hold rows fed to `api.calendar.upsertHoldsBatch`. In poll-hygglo.ts these
 * are produced by `computeHoldsForReservations` (src/lib/reconcile-holds.ts),
 * NOT directly from a single order — they need the full reservation+item set.
 * `orderToHolds` therefore delegates to that canonical reconciler rather than
 * re-deriving hold geometry (see shape.ts). These re-export the reconciler's
 * canonical shapes for callers.
 */
export type {
  HoldInput,
  ReconcileResult,
  ReservationInput,
  ItemRow,
} from "../lib/reconcile-holds";

export type { HyggloAccount };
