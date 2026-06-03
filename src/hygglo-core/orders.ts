/**
 * hygglo-core/orders — orders v4 surface.
 *
 * READS (live in Phase 1):
 *   - listOrders(client, filter)  → GET /v4/my/orders?role=owner&filter=…
 *   - getOrder(client, id)        → GET /v4/my/orders/{id}?timezone=Europe/London
 *   - listAllOrders(client)       → all four filters, deduped (first filter wins),
 *                                   mirroring poll-hygglo.ts's accumulation order.
 *
 * WRITES (typed, NOT live — throw notEnabledYet until Phase 4):
 *   - approve / decline / changeDates / changePrice / removeItem
 *
 * The `chat` action is INTENTIONALLY ABSENT. There is no sendMessage here and
 * never will be — renter messaging stays impossible (see guards.chatDisabled).
 *
 * Pure fetch via the client wrapper. No Hygglo mutation is reachable in Phase 1.
 */

import type { HyggloClient } from "./client";
import { notEnabledYet } from "./guards";
import type {
  HyggloOrderDetail,
  HyggloOrderFilter,
  HyggloOrderListItem,
  OrderWithFilter,
  HyggloWriteResult,
} from "./types";

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
//  WRITES — typed, NOT live in Phase 1 (throw notEnabledYet)
// ════════════════════════════════════════════════════════════════════════

/** Approve a rental request. PATCH /v4/my/orders/{id} { action:"approve", data:{} } */
export async function approve(
  _client: HyggloClient,
  _id: number | string,
): Promise<HyggloWriteResult> {
  return notEnabledYet("approve");
}

/** Decline a rental request. data: { reason, refund? } */
export async function decline(
  _client: HyggloClient,
  _id: number | string,
  _data: { reason?: string; refund?: boolean | number },
): Promise<HyggloWriteResult> {
  return notEnabledYet("decline");
}

/** Change rental dates. data: { rentalStartDate, rentalEndDate } */
export async function changeDates(
  _client: HyggloClient,
  _id: number | string,
  _data: { rentalStartDate: string; rentalEndDate: string },
): Promise<HyggloWriteResult> {
  return notEnabledYet("changeDates");
}

/** Change order price. data: { price } */
export async function changePrice(
  _client: HyggloClient,
  _id: number | string,
  _data: { price: number },
): Promise<HyggloWriteResult> {
  return notEnabledYet("changePrice");
}

/** Remove an item from an order. data: { itemId } or { productId } */
export async function removeItem(
  _client: HyggloClient,
  _id: number | string,
  _data: { itemId?: number; productId?: number },
): Promise<HyggloWriteResult> {
  return notEnabledYet("removeItem");
}

// NB: there is deliberately NO `chat` / `sendMessage` export here. Renter
// messaging is permanently disabled (see guards.chatDisabled).
