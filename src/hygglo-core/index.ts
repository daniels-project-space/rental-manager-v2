/**
 * hygglo-core — the single Hygglo integration layer for rental-manager-v2.
 *
 * Phase 1 (additive, read + shape only):
 *   - auth      : ported OAuth2 password-grant + vault credential resolution.
 *   - client    : typed Bearer fetch wrapper (base URL, error handling, public).
 *   - orders    : listOrders/getOrder (live); approve/decline/changeDates/
 *                 changePrice/removeItem (Phase 4 — delegate to hygglo-write.ts,
 *                 gated by READ_ONLY_MODE, skip+no-fetch by default). NO chat.
 *   - catalog   : listProducts/getProduct/getPublicListing (live); writes typed,
 *                 throw until Phase 4.
 *   - shape     : pure parity mappers order→{reservation,renter,conversation,
 *                 messages,holds}.
 *   - domain    : re-exported canonical constants/predicates (single source).
 *
 * Renter messaging (the Hygglo `chat` action) is intentionally NOT implemented
 * anywhere and never will be — `guards.chatDisabled` is its only surface.
 *
 * Pure fetch — runs in Convex V8, Trigger Node, and Next.
 */

import { createClient, type HyggloClient } from "./client";
import { type HyggloAccount, toAccount } from "./auth-account";
import * as orders from "./orders";
import * as catalog from "./catalog";
import * as shape from "./shape";
import { chatDisabled } from "./guards";
import type {
  HyggloOrderDetail,
  HyggloOrderFilter,
  OrderWithFilter,
  HyggloProductDetail,
  HyggloProductListItem,
  HyggloPublicListing,
} from "./types";

// ── Re-exports ───────────────────────────────────────────────────
export * from "./types";
export * from "./auth";
export * from "./auth-account";
export * from "./guards";
export { HyggloApiError, createClient, type HyggloClient } from "./client";
export * as orders from "./orders";
export * as catalog from "./catalog";
export * as shape from "./shape";
export * as domain from "./domain";
export * as competitors from "./competitors";
export * from "./competitor-aggregate";

/**
 * The bound Hygglo core for one account. Read + shape methods are live; writes
 * throw until Phase 4; `chat` is permanently disabled.
 */
export interface HyggloCore {
  readonly account: HyggloAccount;
  readonly client: HyggloClient;

  // ── orders (reads) ──
  listOrders(filter: HyggloOrderFilter): Promise<OrderWithFilter[]>;
  listAllOrders(): Promise<OrderWithFilter[]>;
  getOrder(id: number | string): Promise<HyggloOrderDetail>;

  // ── catalog (reads) ──
  listProducts(): Promise<HyggloProductListItem[]>;
  getProduct(id: number | string): Promise<HyggloProductDetail>;
  getPublicListing(
    id: number | string,
    country?: string,
  ): Promise<HyggloPublicListing>;

  // ── shape (pure) ──
  readonly shape: typeof shape;

  // ── writes (typed, NOT live in Phase 1) ──
  readonly orders: typeof orders;
  readonly catalog: typeof catalog;

  /** Permanently disabled — throws. Renter messaging is never implemented. */
  sendMessage(): never;
}

/**
 * Factory: build the Hygglo core bound to an account (slug string or
 * `{ slug, country }`). Defaults country to GB. The underlying client mints
 * its Bearer token lazily and caches it.
 */
export function createHyggloCore(
  accountInput: HyggloAccount | string,
): HyggloCore {
  const account = toAccount(accountInput);
  const client = createClient(account);

  return {
    account,
    client,

    listOrders: (filter) => orders.listOrders(client, filter),
    listAllOrders: () => orders.listAllOrders(client),
    getOrder: (id) => orders.getOrder(client, id),

    listProducts: () => catalog.listProducts(client),
    getProduct: (id) => catalog.getProduct(client, id),
    getPublicListing: (id, country) =>
      catalog.getPublicListing(client, id, country),

    shape,
    orders,
    catalog,

    sendMessage: () => chatDisabled(),
  };
}
