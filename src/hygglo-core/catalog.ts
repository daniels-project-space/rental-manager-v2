/**
 * hygglo-core/catalog — catalog surface (Hygglo API v4).
 *
 * READS (live in Phase 1):
 *   - listProducts(client)              → GET /v4/my/products?limit&offset (paged)
 *   - getProduct(client, id)            → GET /v4/my/products/{id}
 *   - getPublicListing(client, id, ctry)→ GET /v4/product-listings/{id}?country=GB
 *
 * WRITES (typed, NOT live — throw notEnabledYet until Phase 4):
 *   - updateProduct / publishProduct / deleteProduct
 *   - setUnavailability / requestPhotoUploadUrl
 *
 * Pure fetch via the client wrapper. No mutation reachable in Phase 1.
 */

import { HYGGLO_API_VERSION } from "./auth";
import type { HyggloClient } from "./client";
import { notEnabledYet } from "./guards";
import type {
  HyggloProductDetail,
  HyggloProductListItem,
  HyggloPublicListing,
  HyggloWriteResult,
} from "./types";

const PAGE_SIZE = 100;

/** Normalise the products-list response: Hygglo returns a bare array, but some
 *  versions wrap it as `{ items: [...] }`. */
function asProductArray(data: unknown): HyggloProductListItem[] {
  if (Array.isArray(data)) return data as HyggloProductListItem[];
  const items = (data as { items?: HyggloProductListItem[] })?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * List ALL of an account's products, walking the limit/offset pages until a
 * short page is returned. (leo ≈ 110 published products → 2 pages at 100.)
 */
export async function listProducts(
  client: HyggloClient,
): Promise<HyggloProductListItem[]> {
  const out: HyggloProductListItem[] = [];
  const seen = new Set<number>();
  let offset = 0;
  // Hard cap on pages so a misbehaving endpoint can't loop forever.
  for (let page = 0; page < 100; page++) {
    const data = await client.getJson<unknown>(
      `/${HYGGLO_API_VERSION}/my/products?limit=${PAGE_SIZE}&offset=${offset}`,
    );
    const batch = asProductArray(data);

    // Defensive de-dupe + offset-ignored guard: Hygglo's `/${HYGGLO_API_VERSION}/my/products`
    // currently IGNORES `offset` and returns the SAME full page every time
    // (verified 2026-06-03 — offsets 0/100/200 all return the identical 110
    // rows). Walking pages would otherwise loop to the 100-page cap and emit
    // 100× duplicates. We accumulate only unseen product ids and stop as soon
    // as a page adds nothing new. A genuinely paged response still drains
    // normally (each page contributes new ids until a short/empty page).
    let added = 0;
    for (const p of batch) {
      if (typeof p.id === "number") {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
      }
      out.push(p);
      added++;
    }

    // Stop when the page was short (true last page) OR contributed no new
    // products (endpoint is ignoring offset / returning a repeated page).
    if (batch.length < PAGE_SIZE || added === 0) break;
    offset += PAGE_SIZE;
  }
  return out;
}

/** Fetch one product's full editable detail. */
export async function getProduct(
  client: HyggloClient,
  id: number | string,
): Promise<HyggloProductDetail> {
  return client.getJson<HyggloProductDetail>(
    `/${HYGGLO_API_VERSION}/my/products/${encodeURIComponent(String(id))}`,
  );
}

/**
 * Fetch the PUBLIC product-listing view (no auth required). Uses the client's
 * unauthenticated path so the Bearer token is never attached.
 */
export async function getPublicListing(
  client: HyggloClient,
  listingId: number | string,
  country?: string,
): Promise<HyggloPublicListing> {
  return client.getPublicJson<HyggloPublicListing>(
    `/${HYGGLO_API_VERSION}/product-listings/${encodeURIComponent(String(listingId))}`,
    country,
  );
}

// ════════════════════════════════════════════════════════════════════════
//  WRITES — typed, NOT live in Phase 1 (throw notEnabledYet)
// ════════════════════════════════════════════════════════════════════════

/** PATCH /v4/my/products/{id} — edit listing fields (title/desc/prices/…). */
export async function updateProduct(
  _client: HyggloClient,
  _id: number | string,
  _patch: Partial<HyggloProductDetail>,
): Promise<HyggloWriteResult> {
  return notEnabledYet("updateProduct");
}

/** PATCH /v4/my/products/{id} { isPublished } — publish/unpublish. */
export async function publishProduct(
  _client: HyggloClient,
  _id: number | string,
  _isPublished: boolean,
): Promise<HyggloWriteResult> {
  return notEnabledYet("publishProduct");
}

/** DELETE /v4/my/products/{id}. */
export async function deleteProduct(
  _client: HyggloClient,
  _id: number | string,
): Promise<HyggloWriteResult> {
  return notEnabledYet("deleteProduct");
}

/** PUT /v4/my/products/{id}/unavailability-dates — blocked dates. */
export async function setUnavailability(
  _client: HyggloClient,
  _id: number | string,
  _dates: string[],
): Promise<HyggloWriteResult> {
  return notEnabledYet("setUnavailability");
}

/** POST /v4/my/products/presigned-url → S3 upload URL for a new photo. */
export async function requestPhotoUploadUrl(
  _client: HyggloClient,
  _id: number | string,
  _meta: { filename: string; contentType: string },
): Promise<HyggloWriteResult> {
  return notEnabledYet("requestPhotoUploadUrl");
}
