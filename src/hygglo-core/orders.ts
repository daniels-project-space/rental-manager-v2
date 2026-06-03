/**
 * hygglo-core/orders — orders v4 surface.
 *
 * READS (live in Phase 1):
 *   - listOrders(client, filter)  → GET /v4/my/orders?role=owner&filter=…
 *   - getOrder(client, id)        → GET /v4/my/orders/{id}?timezone=Europe/London
 *   - listAllOrders(client)       → all four filters, deduped (first filter wins),
 *                                   mirroring poll-hygglo.ts's accumulation order.
 *
 * WRITES (Phase 4 — thin delegations to src/lib/hygglo-write.ts, the single
 * write chokepoint; each is gated by READ_ONLY_MODE there and returns
 * `{ status:'skipped' }` with NO fetch unless writes are explicitly allowed):
 *   - approve / decline / changeDates / changePrice / removeItem
 *
 * The `chat` action is INTENTIONALLY ABSENT. There is no sendMessage here and
 * never will be — renter messaging stays impossible (see guards.chatDisabled).
 *
 * Reads are pure fetch via the client wrapper. Writes forward the account slug
 * + order id to hygglo-write.ts so there is exactly ONE module that can emit a
 * non-GET to Hygglo.
 */

import type { HyggloClient } from "./client";
import type {
  HyggloOrderDetail,
  HyggloOrderFilter,
  HyggloOrderListItem,
  OrderWithFilter,
  HyggloWriteResult,
} from "./types";
// Phase 4: writes delegate to the single chokepoint in src/lib/hygglo-write.ts.
// That module owns the gate (READ_ONLY_MODE) + the exact action verb / data
// shapes verified from the 422 union-probe. hygglo-core never re-implements a
// write — it forwards the account slug + order id so there is ONE place that
// can ever emit a non-GET to Hygglo.
import {
  acceptOrder as writeAccept,
  declineOrder as writeDecline,
  changeOrderDates as writeChangeDates,
  changeOrderPrice as writeChangePrice,
  removeOrderItem as writeRemoveItem,
} from "../lib/hygglo-write";

const TIMEZONE = "Europe/London";

/** poll-hygglo.ts accumulation order — first filter to see an order id wins on
 *  dedup (so a current/future order isn't overwritten by its obsolete twin). */
export const ALL_FILTERS: readonly HyggloOrderFilter[] = [
  "pending",
  "current",
  "future",
  "obsolete",
] as const;

/** Probe the candidate latest-activity field names, first non-undefined wins.
 *  Mirrors poll-hygglo.ts:scrapeAccount exactly. */
function pickLatestActivity(
  o: HyggloOrderListItem,
): number | string | undefined {
  return (
    o.latest_activity ??
    o.latestActivity ??
    o.last_activity_at ??
    o.lastActivityAt ??
    o.updated_at ??
    o.updatedAt
  );
}

/** Normalise the orders-list response: Hygglo returns a bare array, but some
 *  versions wrap it as `{ items: [...] }`. */
function asListArray(data: unknown): HyggloOrderListItem[] {
  if (Array.isArray(data)) return data as HyggloOrderListItem[];
  const items = (data as { items?: HyggloOrderListItem[] })?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * List orders for one filter bucket. Returns the carrier shape
 * ({ id, sourceFilter, latest_activity }) used by the mappers + dedup.
 */
export async function listOrders(
  client: HyggloClient,
  filter: HyggloOrderFilter,
): Promise<OrderWithFilter[]> {
  const data = await client.getJson<unknown>(
    `/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=50`,
  );
  return asListArray(data).map((o) => ({
    id: o.id,
    sourceFilter: filter,
    latest_activity: pickLatestActivity(o),
  }));
}

/**
 * List every owner order across all four filters and dedup by id (first-seen
 * filter wins — pending → current → future → obsolete). Byte-for-byte the same
 * accumulation + dedup the poller does.
 */
export async function listAllOrders(
  client: HyggloClient,
): Promise<OrderWithFilter[]> {
  const all: OrderWithFilter[] = [];
  for (const filter of ALL_FILTERS) {
    try {
      all.push(...(await listOrders(client, filter)));
    } catch {
      // Mirror poll-hygglo: a failed filter (`!res.ok`) is skipped, not fatal.
      continue;
    }
  }
  const seen = new Set<number>();
  return all.filter((o) => {
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
}

/** Fetch one order's full detail (timezone-pinned to Europe/London). */
export async function getOrder(
  client: HyggloClient,
  id: number | string,
): Promise<HyggloOrderDetail> {
  return client.getJson<HyggloOrderDetail>(
    `/v4/my/orders/${encodeURIComponent(String(id))}?timezone=${TIMEZONE}`,
  );
}

// ════════════════════════════════════════════════════════════════════════
//  WRITES — Phase 4: thin delegations to src/lib/hygglo-write.ts.
//
//  These are NOT a second write path. Each forwards to the corresponding
//  hygglo-write.ts function, which is the SOLE module allowed to emit a
//  non-GET to Hygglo and which gates every call behind `writesAllowed()`
//  (READ_ONLY_MODE !== 'true'). When READ_ONLY_MODE is set (the default in
//  every non-canary environment) these return `{ status:'skipped' }` and no
//  fetch is performed. Action verbs + data shapes are owned and documented in
//  hygglo-write.ts (verified against the 422 union-probe).
// ════════════════════════════════════════════════════════════════════════

/** Approve a rental request → hygglo-write.acceptOrder (action "approve"). */
export async function approve(
  client: HyggloClient,
  id: number | string,
): Promise<HyggloWriteResult> {
  return writeAccept({
    accountSlug: client.account.slug,
    hyggloOrderId: String(id),
  });
}

/** Decline a rental request → hygglo-write.declineOrder (action "decline"). */
export async function decline(
  client: HyggloClient,
  id: number | string,
  data: { reason?: string; refund?: boolean | number },
): Promise<HyggloWriteResult> {
  return writeDecline({
    accountSlug: client.account.slug,
    hyggloOrderId: String(id),
    reason: data.reason ?? "",
  });
}

/**
 * Change rental dates → hygglo-write.changeOrderDates.
 * NB: the dispatcher action verb is `selectDates` (the order-detail `actions`
 * map key is `changeDates`; the wire verb differs — see hygglo-write.ts).
 * data: { rentalStartDate, rentalEndDate }
 */
export async function changeDates(
  client: HyggloClient,
  id: number | string,
  data: { rentalStartDate: string; rentalEndDate: string },
): Promise<HyggloWriteResult> {
  return writeChangeDates({
    accountSlug: client.account.slug,
    hyggloOrderId: String(id),
    rentalStartDate: data.rentalStartDate,
    rentalEndDate: data.rentalEndDate,
  });
}

/** Change order price → hygglo-write.changeOrderPrice. data: { price } */
export async function changePrice(
  client: HyggloClient,
  id: number | string,
  data: { price: number },
): Promise<HyggloWriteResult> {
  return writeChangePrice({
    accountSlug: client.account.slug,
    hyggloOrderId: String(id),
    price: data.price,
  });
}

/**
 * Remove an item from an order → hygglo-write.removeOrderItem.
 * data: { itemId } — itemId is required (number). `productId` is NOT a
 * removeItem field (it belongs to `addProduct`); it is accepted on the public
 * signature for backwards compat but ignored, and itemId must be supplied.
 */
export async function removeItem(
  client: HyggloClient,
  id: number | string,
  data: { itemId: number; productId?: number },
): Promise<HyggloWriteResult> {
  return writeRemoveItem({
    accountSlug: client.account.slug,
    hyggloOrderId: String(id),
    itemId: data.itemId,
  });
}

// NB: there is deliberately NO `chat` / `sendMessage` export here. Renter
// messaging is permanently disabled (see guards.chatDisabled).
