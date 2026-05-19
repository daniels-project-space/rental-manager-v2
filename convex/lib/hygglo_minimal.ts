/**
 * Wave 3a — Minimal Hygglo client for the backup poller (failsafe).
 *
 * NOT a full clone of `src/trigger/poll-hygglo.ts`. This module is the bare
 * minimum needed for a Convex internalAction to fetch enough Hygglo data to
 * upsert reservations through `api.hygglo.upsertOrderAsReservation`.
 *
 * Differences vs the Trigger.dev primary poller:
 *   - NO chat-message scrape (no upsertMessages writes)
 *   - NO renters / conversations
 *   - NO activity / system-signal derivation
 *   - NO listing-image bank write-through
 *   - NO Playwright UI fallback
 *   - NO per-order skip-if-unchanged optimisation (we always refetch the
 *     small set we picked up — backup runs are infrequent)
 *   - Caps at 50 orders/account (sum across filters), strict per-request
 *     timeouts, designed to finish well under the 60s budget.
 *
 * Self-contained: only depends on `fetch` and the shared auth helper in
 * `src/lib/hygglo-auth.ts` (which itself uses only `fetch`). Convex actions
 * support both, so this module is safe to import from a Convex action.
 */

import {
  HYGGLO_API_BASE,
  hyggloAuthHeaders,
  getHyggloAccessToken,
} from "../../src/lib/hygglo-auth";

// ── Public payload type — mirrors `api.hygglo.upsertOrderAsReservation` args.
// Kept loose (no Convex `v`) because we build the object here and pass it
// straight through to ctx.runMutation.
export interface MinimalReservationPayload {
  hygglo_order_id: string;
  status: string;
  start_date: string;
  end_date: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  currency?: string;
  items: Array<{
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
  }>;
  duration_days?: number;
  order: unknown; // raw detail object — upsert mutation extracts order_step from it
  sourceFilter: string;
  renter_name?: string;
  booking_status?: string;
  pickup_time?: string;
  return_time?: string;
  pickup_method?: string;
  return_method?: string;
  notes?: string;
  photos_urls?: string[];
  latest_activity?: number | string;
}

interface ListOrder {
  id: number;
  sourceFilter: string;
  latest_activity?: number | string;
}

const LIST_FILTERS = ["pending", "current", "future", "obsolete"] as const;
const PER_FILTER_LIMIT = 25; // 4 filters × 25 = max 100 raw, capped to 50 unique below
const HARD_ORDER_CAP = 50;
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a minimal slice of orders for one Hygglo account and map them into
 * payloads ready for `api.hygglo.upsertOrderAsReservation`.
 *
 * Returns at most {@link HARD_ORDER_CAP} payloads. Throws on auth failure.
 * Per-order detail fetch failures are caught and counted, not thrown.
 */
export async function fetchOrdersMinimal(args: {
  accountSlug: string;
  email: string;
  password: string;
  clientSecret: string;
}): Promise<{
  payloads: MinimalReservationPayload[];
  detailErrors: string[];
}> {
  // 1. Auth
  const token = await getHyggloAccessToken({
    email: args.email,
    password: args.password,
    clientSecret: args.clientSecret,
    accountSlug: args.accountSlug,
  });
  const headers = hyggloAuthHeaders(token);

  // 2. List endpoint — collect order ids across all filter buckets.
  const collected: ListOrder[] = [];
  for (const filter of LIST_FILTERS) {
    try {
      const res = await fetchWithTimeout(
        `${HYGGLO_API_BASE}/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=${PER_FILTER_LIMIT}`,
        { headers },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      const arr: Array<Record<string, unknown> & { id: number }> = Array.isArray(
        data,
      )
        ? (data as Array<Record<string, unknown> & { id: number }>)
        : (((data as { items?: Array<Record<string, unknown> & { id: number }> })
            .items) ?? []);
      for (const o of arr) {
        const la =
          (o.latest_activity as number | string | undefined) ??
          (o.latestActivity as number | string | undefined) ??
          (o.updated_at as number | string | undefined) ??
          (o.updatedAt as number | string | undefined);
        collected.push({ id: o.id, sourceFilter: filter, latest_activity: la });
      }
    } catch {
      // skip this filter; try the next
    }
  }

  // 3. Dedupe + cap (first-seen wins → active filter beats obsolete).
  const seen = new Set<number>();
  const unique: ListOrder[] = [];
  for (const o of collected) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    unique.push(o);
    if (unique.length >= HARD_ORDER_CAP) break;
  }

  // 4. Per-order detail fetch — minimal extraction (date/items/price).
  const payloads: MinimalReservationPayload[] = [];
  const detailErrors: string[] = [];

  for (const order of unique) {
    try {
      const res = await fetchWithTimeout(
        `${HYGGLO_API_BASE}/v4/my/orders/${order.id}?timezone=Europe/London`,
        { headers },
      );
      if (!res.ok) {
        detailErrors.push(`order ${order.id}: HTTP ${res.status}`);
        continue;
      }
      const detail = (await res.json()) as any;

      const startUTC: string | undefined = detail?.rentalPeriod?.startDateUTC;
      const endUTC: string | undefined = detail?.rentalPeriod?.endDateUTC;
      // Skip rows with no rental window — upsert mutation requires both.
      if (!startUTC || !endUTC) continue;

      const startDate = startUTC.slice(0, 10);
      const endDate = endUTC.slice(0, 10);
      const start = new Date(startUTC);
      const end = new Date(endUTC);
      const durationDays = Math.round(
        (end.getTime() - start.getTime()) / 86_400_000,
      );

      const grossPaid: number | undefined =
        detail?.price?.breakdown?.totalPrice?.amount ?? detail?.price?.total;
      const netToOwner: number | undefined =
        detail?.price?.breakdown?.lenderEarnings?.amount ??
        detail?.price?.ownerEarnings;
      const currency: string = detail?.price?.currency ?? "GBP";

      const items = (Array.isArray(detail?.items) ? detail.items : [])
        .filter((i: any) => i?.type !== "INSURANCE")
        .map((i: any) => ({
          item_name: i?.name ?? "Unknown item",
          qty: typeof i?.qty === "number" ? i.qty : undefined,
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
          type: typeof i?.type === "string" ? i.type : undefined,
          product_id: typeof i?.productId === "number" ? i.productId : undefined,
          slug: typeof i?.slug === "string" ? i.slug : undefined,
        }));

      const status =
        order.sourceFilter === "obsolete"
          ? "cancelled"
          : order.sourceFilter === "pending"
            ? "pending_review"
            : "confirmed";

      const bookingStatus: string | undefined = detail?.booking?.status;

      payloads.push({
        hygglo_order_id: String(order.id),
        status,
        start_date: startDate,
        end_date: endDate,
        gross_paid_gbp: grossPaid,
        net_to_owner_gbp: netToOwner,
        currency,
        items,
        duration_days: durationDays > 0 ? durationDays : undefined,
        order: detail,
        sourceFilter: order.sourceFilter,
        booking_status: bookingStatus,
        latest_activity: order.latest_activity,
        // Wave-3a deliberately omits renter_name, photos_urls, activities-derived
        // signals etc. The primary poller is responsible for those — this is a
        // failsafe to keep dates/items/status fresh when it dies.
      });
    } catch (err) {
      detailErrors.push(
        `order ${order.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { payloads, detailErrors };
}
