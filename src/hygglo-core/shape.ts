/**
 * hygglo-core/shape — PURE mappers Hygglo order/product → Convex upsert payloads.
 *
 * ⚠️ PARITY-CRITICAL. Every function here reproduces the shaping logic in
 * `src/trigger/poll-hygglo.ts:scrapeAccount` FIELD-FOR-FIELD. The two helpers
 * `deriveHyggloSystemSignal` and `parseCreatedAtLabel` are ported VERBATIM
 * (copy of the poller's exported/private implementations). The five `orderTo*`
 * mappers slice the exact same fields, in the same precedence order, with the
 * same fallbacks and the same INSURANCE/duration/photo edge-cases.
 *
 * Mapper scope (what the poller computes inline, factored out here):
 *   orderToReservation  — the `OrderReservationPayload` push (poll-hygglo L454-546)
 *   orderToRenter       — renterMap accumulation (poll-hygglo L401-414)
 *   orderToMessages     — chat extraction (poll-hygglo L417-435)
 *   orderToConversation — conversation spec (poll-hygglo L438-451)
 *   orderToHolds        — DELEGATES to computeHoldsForReservations (poll-hygglo
 *                         L937-1019); holds are a fleet-level reconcile, not a
 *                         per-order projection, so we don't re-derive geometry.
 *
 * Pure — no fetch, no Convex, no I/O. Deterministic given (detail, sourceFilter,
 * fetchedAt). Safe for unit tests against saved fixtures.
 */

import { computeHoldsForReservations } from "../lib/reconcile-holds";
import type {
  ConversationPayload,
  HyggloActivity,
  HyggloOrderDetail,
  HyggloSystemSignal,
  ItemRow,
  MessagePayload,
  ReconcileResult,
  RenterPayload,
  ReservationInput,
  ReservationItemPayload,
  ReservationPayload,
} from "./types";

// ════════════════════════════════════════════════════════════════════════
//  Ported helpers (VERBATIM from poll-hygglo.ts)
// ════════════════════════════════════════════════════════════════════════

/**
 * Phase 3d — derive the most-recent decisive Hygglo system signal from a list
 * of order activities. PORTED VERBATIM from poll-hygglo.ts:deriveHyggloSystemSignal.
 */
export function deriveHyggloSystemSignal(acts: HyggloActivity[]): {
  signal: HyggloSystemSignal;
  text?: string;
} {
  let approvedText: string | undefined;
  for (const a of [...acts].reverse()) {
    const c = a.event?.content ?? "";
    if (!c) continue;
    if (/You have denied the rental request/i.test(c))
      return { signal: "owner_denied", text: c };
    if (/has cancelled the rental request/i.test(c))
      return { signal: "renter_cancelled", text: c };
    if (/Automatically cancelled/i.test(c))
      return { signal: "auto_cancelled", text: c };
    if (
      /did not pass our security checks/i.test(c) ||
      /pre-authorized funds.*cancelled.*rejected/i.test(c)
    )
      return { signal: "verification_failed", text: c };
    if (/Now the borrower should pay/i.test(c) && approvedText === undefined) {
      approvedText = c;
    }
  }
  if (approvedText !== undefined)
    return { signal: "approved", text: approvedText };
  return { signal: "none" };
}

/**
 * Parse Hygglo's `createdAtLabel` (e.g. "30 May, 14:58", "Yesterday 14:58",
 * "Today 09:10") into a Date. PORTED VERBATIM from poll-hygglo.ts:parseCreatedAtLabel.
 */
export function parseCreatedAtLabel(label: string): Date | null {
  if (!label) return null;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const match = label.match(
    /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:,?\s+(\d{1,2}):(\d{2}))?/,
  );
  if (match) {
    const day = parseInt(match[1], 10);
    const month = months[match[2]];
    const now = new Date();
    const year = now.getFullYear();
    const hours = match[3] ? parseInt(match[3], 10) : 0;
    const minutes = match[4] ? parseInt(match[4], 10) : 0;
    const date = new Date(year, month, day, hours, minutes);
    if (date.getTime() > now.getTime() + 86400000) date.setFullYear(year - 1);
    return date;
  }
  if (label.toLowerCase().startsWith("yesterday")) {
    const t = label.match(/(\d{1,2}):(\d{2})/);
    const d = new Date();
    d.setDate(d.getDate() - 1);
    if (t) d.setHours(parseInt(t[1], 10), parseInt(t[2], 10), 0, 0);
    return d;
  }
  if (label.toLowerCase().startsWith("today")) {
    const t = label.match(/(\d{1,2}):(\d{2})/);
    const d = new Date();
    if (t) d.setHours(parseInt(t[1], 10), parseInt(t[2], 10), 0, 0);
    return d;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  Internal field extractors (mirror poll-hygglo.ts precedence)
// ════════════════════════════════════════════════════════════════════════

/** detail.users.otherPart.name ?? detail.labels.otherPart ?? "Renter" */
export function renterNameOf(detail: HyggloOrderDetail): string {
  return detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? "Renter";
}

/** String(detail.users.otherPart.id) when present, else undefined. */
export function renterUserIdOf(detail: HyggloOrderDetail): string | undefined {
  return detail.users?.otherPart?.id !== undefined &&
    detail.users?.otherPart?.id !== null
    ? String(detail.users.otherPart.id)
    : undefined;
}

// ════════════════════════════════════════════════════════════════════════
//  Mappers
// ════════════════════════════════════════════════════════════════════════

/**
 * orderToRenter — mirrors poll-hygglo L401-414. The poller dedups across orders
 * by (hygglo_user_id ?? lowercased name); a single order yields exactly one
 * renter, so we return that one element. `display_name` is the raw name (NOT
 * lowercased — the lowercase form is only the dedup key, never the stored value).
 */
export function orderToRenter(detail: HyggloOrderDetail): RenterPayload {
  return {
    hygglo_user_id: renterUserIdOf(detail),
    display_name: renterNameOf(detail),
  };
}

/**
 * orderToMessages — mirrors poll-hygglo L417-435. Iterates detail.activities,
 * keeps only those with a non-empty chatMessage.text.content, and maps each to
 * a MessagePayload. thread_id = String(order id). sender = byMe?"owner":"renter".
 * sender_name = byMe?"Owner":renterName. hygglo_sent_at = parsed createdAtLabel
 * (ms) or undefined. `fetchedAt` is injected by the caller (the poller uses one
 * Date.now() per scrape cycle).
 */
export function orderToMessages(
  detail: HyggloOrderDetail,
  fetchedAt: number,
): MessagePayload[] {
  const otherPartName = renterNameOf(detail);
  const orderId = String(detail.id);
  const out: MessagePayload[] = [];
  for (const activity of detail.activities ?? []) {
    if (!activity.chatMessage) continue;
    const text = activity.chatMessage.text?.content ?? "";
    if (!text.trim()) continue;
    const ts = parseCreatedAtLabel(activity.createdAtLabel ?? "")?.getTime();
    out.push({
      thread_id: orderId,
      message_id: activity.key,
      sender: activity.chatMessage.byMe ? "owner" : "renter",
      sender_name: activity.chatMessage.byMe ? "Owner" : otherPartName,
      body_text: text,
      hygglo_sent_at: ts,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

/**
 * orderToConversation — mirrors poll-hygglo L438-451. Returns null when the
 * order has zero chat messages (the poller only pushes a conversation spec for
 * orders with messages). last_msg_at = max(timestamps), created_at =
 * min(timestamps); both fall back to fetchedAt when no message carried a
 * parseable timestamp. Messages with hygglo_sent_at===undefined contribute
 * `fetchedAt` to the timestamp set (matching the poller's `?? fetchedAt`).
 */
export function orderToConversation(
  detail: HyggloOrderDetail,
  fetchedAt: number,
): ConversationPayload | null {
  const orderMessages = orderToMessages(detail, fetchedAt);
  if (orderMessages.length === 0) return null;
  const timestamps = orderMessages
    .map((m) => m.hygglo_sent_at ?? fetchedAt)
    .filter((t) => t > 0);
  const lastMsgAt = timestamps.length > 0 ? Math.max(...timestamps) : fetchedAt;
  const firstMsgAt = timestamps.length > 0 ? Math.min(...timestamps) : fetchedAt;
  return {
    thread_id: String(detail.id),
    hygglo_user_id: renterUserIdOf(detail),
    display_name: renterNameOf(detail),
    last_msg_at: lastMsgAt,
    created_at: firstMsgAt,
  };
}

/**
 * orderToReservation — mirrors poll-hygglo L454-546. Returns null when the
 * order lacks rentalPeriod.startDateUTC/endDateUTC (the poller only pushes a
 * reservation payload when BOTH are present).
 *
 * `sourceFilter` is the filter bucket the order id was first seen under
 * (pending → current → future → obsolete). It drives both the `status` literal
 * AND is forwarded verbatim.
 *
 * Edge-cases reproduced exactly:
 *   - status:   obsolete→"cancelled", pending→"pending_review", else "confirmed".
 *   - gross:    breakdown.totalPrice.amount ?? price.total.
 *   - net:      breakdown.lenderEarnings.amount ?? price.ownerEarnings.
 *   - currency: price.currency ?? "GBP".
 *   - items:    filter out type==="INSURANCE"; image forwards the full image
 *               object (incl. fullSizeUrl); product_id only if number; slug only
 *               if string; qty only if number; type only if string.
 *   - duration: round((end-start)/86400000); only set when > 0 (a same-day
 *               rental → 0 → duration_days undefined).
 *   - photos:   detail.photos_urls ?? detail.detail.photos_urls; else fall back
 *               to items[].image.fullSizeUrl; undefined when empty.
 */
export function orderToReservation(
  detail: HyggloOrderDetail,
  sourceFilter: string,
  latestActivity?: number | string,
): ReservationPayload | null {
  const startUTC = detail.rentalPeriod?.startDateUTC;
  const endUTC = detail.rentalPeriod?.endDateUTC;
  if (!startUTC || !endUTC) return null;

  const otherPartName = renterNameOf(detail);
  const otherPartUserId = renterUserIdOf(detail);

  const startDate = startUTC.slice(0, 10);
  const endDate = endUTC.slice(0, 10);

  const grossPaid =
    detail.price?.breakdown?.totalPrice?.amount ?? detail.price?.total;
  const netToOwner =
    detail.price?.breakdown?.lenderEarnings?.amount ??
    detail.price?.ownerEarnings;
  const currency = detail.price?.currency ?? "GBP";

  const orderItems: ReservationItemPayload[] = (detail.items ?? [])
    .filter((i) => i.type !== "INSURANCE")
    .map((i) => ({
      item_name: i.name ?? "Unknown item",
      qty: typeof i.qty === "number" ? i.qty : undefined,
      image: i?.image
        ? {
            url: i.image.url,
            originalUrl: i.image.originalUrl,
            largeUrl: i.image.largeUrl,
            mediumUrl: i.image.mediumUrl,
            thumbnailUrl: i.image.thumbnailUrl,
            fullSizeUrl: i.image.fullSizeUrl,
          }
        : undefined,
      type: typeof i.type === "string" ? i.type : undefined,
      product_id: typeof i.productId === "number" ? i.productId : undefined,
      slug: typeof i.slug === "string" ? i.slug : undefined,
    }));

  const start = new Date(startUTC);
  const end = new Date(endUTC);
  const durationDays = Math.round(
    (end.getTime() - start.getTime()) / 86400000,
  );

  const status =
    sourceFilter === "obsolete"
      ? "cancelled"
      : sourceFilter === "pending"
        ? "pending_review"
        : "confirmed";

  const bookingStatus: string | undefined = detail.booking?.status ?? undefined;
  const pickup_time: string | undefined =
    detail.booking?.pickup_time ?? undefined;
  const return_time: string | undefined =
    detail.booking?.return_time ?? undefined;
  const pickup_method: string | undefined =
    detail.booking?.pickup_method ?? undefined;
  const return_method: string | undefined =
    detail.booking?.return_method ?? undefined;
  const notes: string | undefined =
    detail.notes ?? detail.detail?.notes ?? undefined;

  const photos_urls: string[] | undefined = (() => {
    if (Array.isArray(detail.photos_urls)) return detail.photos_urls;
    if (Array.isArray(detail.detail?.photos_urls))
      return detail.detail.photos_urls;
    const urls: string[] = [];
    for (const item of detail.items ?? []) {
      if (item?.image?.fullSizeUrl) urls.push(item.image.fullSizeUrl);
    }
    return urls.length > 0 ? urls : undefined;
  })();

  const systemSignal = deriveHyggloSystemSignal(detail.activities ?? []);

  return {
    hygglo_order_id: String(detail.id),
    status,
    start_date: startDate,
    end_date: endDate,
    gross_paid_gbp: grossPaid,
    net_to_owner_gbp: netToOwner,
    currency,
    items: orderItems,
    duration_days: durationDays > 0 ? durationDays : undefined,
    sourceFilter,
    renter_name: otherPartName || undefined,
    hygglo_user_id: otherPartUserId,
    booking_status: bookingStatus,
    pickup_time,
    return_time,
    pickup_method,
    return_method,
    notes,
    photos_urls,
    latest_activity: latestActivity,
    order: detail,
    hygglo_system_signal: systemSignal.signal,
    hygglo_system_signal_text: systemSignal.text,
  };
}

/**
 * orderToHolds — calendar holds for a set of reservations.
 *
 * IMPORTANT (parity): in poll-hygglo.ts holds are NOT a per-order projection —
 * the poller pulls the FULL reservations + items tables back from Convex and
 * runs `computeHoldsForReservations` over the whole fleet (L937-1019). A single
 * order cannot produce correct holds in isolation (item matching, forward cap,
 * past-window pruning all need the canonical item set). This wrapper therefore
 * takes the same `{ reservations, items, today, forwardCapDays }` and delegates
 * to the canonical reconciler — it adds NO new hold logic, it just gives
 * hygglo-core a named entry point so callers don't import reconcile-holds
 * directly. Default forwardCapDays=180 matches the poller.
 */
export function orderToHolds(args: {
  reservations: ReservationInput[];
  items: ItemRow[];
  today: Date;
  forwardCapDays?: number;
}): ReconcileResult {
  return computeHoldsForReservations({
    forwardCapDays: 180,
    ...args,
  });
}
