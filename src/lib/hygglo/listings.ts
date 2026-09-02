/**
 * Hygglo listing-management toolkit (server-side).
 *
 * The callable layer the Rental Manager dashboard uses to manage an account's
 * LIVE Hygglo product listings — list / read / edit price / publish / change
 * category / set opening times / (Phase 2) create. Runs entirely on Vercel
 * serverless; no VPS in the path. Auth + token come from `hygglo-core`
 * (`createClient` → vault creds → OAuth bearer, cached per instance).
 *
 * Hard-won Hygglo write mechanics (ported verbatim from the proven VPS
 * `listings.py`, 2026-06-21/22):
 *   - EDIT any field (price / category / locations / description / valuation)
 *     = GET current → merge → **PUT** the FULL payload. PATCH returns 200 but
 *     silently IGNORES price/category/locations.
 *   - PUBLISH / UNPUBLISH = **PATCH { isPublished }** only. PUT ignores an
 *     unpublish, so `editListing` enforces the requested publish state with a
 *     follow-up PATCH.
 *   - The image reference on PUT must be the **bare `<uuid>.<ext>`** filename
 *     (strip any "products/" prefix or Hygglo 500s "Failed to get file
 *     reference"). PUT reuses the existing image — no re-upload on edit.
 *   - PUT requires `cancellationTerms` as the enum string "0" | "1" | "2" plus
 *     every other field; `locationIds` must list ALL of the account's pickup
 *     locations (PUT is idempotent on them — it won't double them).
 *   - Hygglo runs an AI validation step on create/edit that can 500 with
 *     "no object generated" / "transaction is aborted" on certain content →
 *     retry once with competitor parentheticals stripped from the name.
 *   - name ≤ 255 chars. There is NO opening-hours API → opening times are
 *     managed as a "⏰ Opening times:" line inside the description.
 */
import {
  createClient,
  HyggloApiError,
  HYGGLO_API_VERSION,
  type HyggloClient,
} from "@/hygglo-core";

const COUNTRY = "GB";
const NAME_MAX = 255;
const CANCELLATION_DEFAULT = "1";
const AI_FAIL = ["no object generated", "did not match schema", "transaction is aborted"];
// Strip competitor parentheticals (e.g. "(like ARRI Alexa)") that can trip
// Hygglo's AI-on-edit step.
const COMPETITOR =
  /\s*\((?:[^)]*\b(?:like|arri|alexa|red|canon|sony|rode|dzo|similar)\b[^)]*)\)/gi;
// One "⏰ Opening times: …" line, anywhere in the description.
const OPENING_LINE = /^[⏰•\-\s]*opening times\s*[:\-].*$/gim;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Types (permissive — Hygglo product detail) ──────────────────────────────
export interface HyggloPrice {
  days: number;
  pricePerDay: number;
  price: number | null;
}
export interface HyggloListing {
  id: number;
  name?: string;
  description?: string;
  categoryId?: number;
  valuation?: number;
  isPublished?: boolean;
  minimumRentalDays?: number;
  stockLevel?: number;
  cancellationTerms?: string;
  prices?: HyggloPrice[];
  images?: Array<{ filename?: string; fullSizeUrl?: string; displayOrder?: number }>;
  listings?: Array<{ location?: { id: number; name?: string; address?: string } }>;
  publicUrl?: string;
}
export interface SlimListing {
  id?: number;
  name?: string;
  categoryId?: number;
  isPublished?: boolean;
  valuation?: number;
  prices: HyggloPrice[];
  image: string | null;
  locations: number;
  publicUrl: string | null;
}
export interface Loc {
  id: number;
  name: string;
  address?: string;
}
export interface WriteResult {
  ok: boolean;
  id?: number | string;
  status?: number;
  error?: string;
}

export type OneDayPricePreviewRow = {
  listingId: number;
  listingName: string;
  currentPricePerDay: number | null;
  targetPricePerDay: number | null;
  status: "ready" | "skipped" | "conflict";
  reason?: "missing_one_day_tier" | "duplicate_one_day_tier" | "invalid_one_day_price";
};

export type OneDayPriceAdjustmentPreview = {
  account: string;
  percent: number;
  currency: "GBP";
  readyCount: number;
  skippedCount: number;
  conflictCount: number;
  rows: OneDayPricePreviewRow[];
};

/** Editable fields accepted by `editListing`. */
export interface ListingChanges {
  name?: string;
  description?: string;
  categoryId?: number;
  prices?: HyggloPrice[];
  valuation?: number;
  isPublished?: boolean;
  locationIds?: number[];
  stockLevel?: number;
  cancellationTerms?: string;
  minimumRentalDays?: number;
}

// ── Client ──────────────────────────────────────────────────────────────────

const ALLOWED_ACCOUNTS = new Set(["leo", "dbcinema", "diogo"]);

export function isAllowedAccount(account: string): boolean {
  return ALLOWED_ACCOUNTS.has(account);
}

/** A per-account Hygglo client (mints + caches one bearer for its lifetime). */
export function listingClient(account: string): HyggloClient {
  return createClient({ slug: account, country: COUNTRY });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bare(filename?: string): string | undefined {
  return filename ? filename.split("/").pop() : filename;
}

function cleanPrices(prices?: HyggloPrice[]): HyggloPrice[] {
  const out: HyggloPrice[] = [];
  for (const p of prices ?? []) {
    if (p == null || p.price == null) continue;
    out.push({ days: p.days, pricePerDay: p.pricePerDay, price: p.price });
  }
  return out;
}

function roundGbp(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Bounds + rounding for a one-day price adjustment.
 *
 * DELIBERATE DUPLICATION of `convex/listing_price_admin.ts` (`MAX_ABS_PERCENT`,
 * `MIN_PRICE`, `roundPrice`). That module is the SOURCE OF TRUTH because it is
 * the only code path that actually writes a live listing; this preview must
 * quote the numbers that path would produce, or it is lying to the operator.
 *
 * The two cannot share a module: `listing_price_admin.ts` lives in the Convex
 * runtime and imports `./_generated/server`, while this file is Next-oriented
 * (@/hygglo-core + aws-sdk, `server-only` route) and is explicitly kept OUT of
 * Convex's dependency graph — see the note at the top of
 * `convex/listing_price_admin.ts` and `convex/online_listings_actions.ts`.
 * Importing either direction would drag one runtime's deps into the other.
 *
 * KEEP IN SYNC: if `roundPrice` / `MAX_ABS_PERCENT` / `MIN_PRICE` change in
 * `convex/listing_price_admin.ts`, change them here too. `listings.test.ts`
 * pins the shared cases.
 */
export const MAX_ABS_PRICE_PERCENT = 50;
export const MIN_ONE_DAY_PRICE_GBP = 1;

/** Nearest £0.50, floored at £1 — mirrors `listing_price_admin.roundPrice`. */
function roundOneDayPrice(value: number): number {
  return Math.max(MIN_ONE_DAY_PRICE_GBP, Math.round(value * 2) / 2);
}

/**
 * Pure, read-only plan builder for a one-day-tier change. It intentionally
 * performs no provider write: callers must persist and explicitly approve this
 * frozen preview before any live listing is changed.
 *
 * Negative percentages (price cuts) are allowed, matching the write path.
 */
export function buildOneDayPriceAdjustmentPreview(
  account: string,
  listings: HyggloListing[],
  percent: number,
): OneDayPriceAdjustmentPreview {
  if (!Number.isFinite(percent) || percent === 0) {
    throw new Error("Price adjustment percent must be a non-zero finite number");
  }
  if (Math.abs(percent) > MAX_ABS_PRICE_PERCENT) {
    throw new Error(
      `Price adjustment percent must be within ±${MAX_ABS_PRICE_PERCENT}%`,
    );
  }
  const rows = listings
    .map((listing): OneDayPricePreviewRow => {
      const oneDay = (listing.prices ?? []).filter((tier) => tier.days === 1);
      const shared = {
        listingId: listing.id,
        listingName: listing.name?.trim() || `Listing ${listing.id}`,
      };
      if (oneDay.length === 0) {
        return { ...shared, currentPricePerDay: null, targetPricePerDay: null, status: "skipped", reason: "missing_one_day_tier" };
      }
      if (oneDay.length !== 1) {
        return { ...shared, currentPricePerDay: null, targetPricePerDay: null, status: "conflict", reason: "duplicate_one_day_tier" };
      }
      const current = oneDay[0].pricePerDay;
      if (!Number.isFinite(current) || current <= 0) {
        return { ...shared, currentPricePerDay: null, targetPricePerDay: null, status: "skipped", reason: "invalid_one_day_price" };
      }
      return {
        ...shared,
        // `current` is the real observed price — reported as-is (2dp display),
        // exactly like `old_price` in the Convex diff. Only the TARGET is
        // quantised, and only once, on the final number, so errors never
        // compound.
        currentPricePerDay: roundGbp(current),
        targetPricePerDay: roundOneDayPrice(current * (1 + percent / 100)),
        status: "ready",
      };
    })
    .sort((a, b) => a.listingName.localeCompare(b.listingName) || a.listingId - b.listingId);
  return {
    account,
    percent,
    currency: "GBP",
    readyCount: rows.filter((row) => row.status === "ready").length,
    skippedCount: rows.filter((row) => row.status === "skipped").length,
    conflictCount: rows.filter((row) => row.status === "conflict").length,
    rows,
  };
}

function isAiFail(body: string): boolean {
  const b = body.toLowerCase();
  return AI_FAIL.some((k) => b.includes(k));
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function getItem(
  c: HyggloClient,
  id: number | string,
): Promise<HyggloListing | null> {
  try {
    return await c.getJson<HyggloListing>(`/${HYGGLO_API_VERSION}/my/products/${encodeURIComponent(String(id))}`);
  } catch (err) {
    if (err instanceof HyggloApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * ALL of the account's products. Hits the bare `/v4/my/products` (no
 * limit/offset) — the verified way to get the full set (leo has 250+; the
 * paged `?limit=100` form is ignored by Hygglo on offset and caps at one page).
 */
export async function listMine(c: HyggloClient): Promise<HyggloListing[]> {
  const j = await c.getJson<unknown>(`/${HYGGLO_API_VERSION}/my/products`);
  if (Array.isArray(j)) return j as HyggloListing[];
  const o = j as { products?: HyggloListing[]; data?: HyggloListing[] } | null;
  return o?.products ?? o?.data ?? [];
}

export async function categories(c: HyggloClient): Promise<Array<{ id: number; name?: string }>> {
  const cats = await c.getJson<Array<{ id: number; name?: string }>>(
    `/${HYGGLO_API_VERSION}/categories?country=${COUNTRY}`,
  );
  return (cats ?? []).map((cat) => ({ id: cat.id, name: cat.name }));
}

/** The account's pickup locations, derived from its products' `listings[]`. */
export async function locations(c: HyggloClient): Promise<Loc[]> {
  const rows = await listMine(c);
  if (!rows.length) return [];
  const detail = await getItem(c, rows[0].id);
  const seen = new Map<number, Loc>();
  for (const lst of detail?.listings ?? []) {
    const loc = lst?.location;
    if (loc?.id != null && !seen.has(loc.id)) {
      seen.set(loc.id, { id: loc.id, name: (loc.name ?? "").trim(), address: loc.address });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
}

export async function locationIds(c: HyggloClient): Promise<number[]> {
  return (await locations(c)).map((l) => l.id);
}

/** Slim list row for the dashboard (matches the legacy VPS API shape). */
export function slim(p: HyggloListing): SlimListing {
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    isPublished: p.isPublished,
    valuation: p.valuation,
    prices: cleanPrices(p.prices),
    image: p.images?.[0]?.fullSizeUrl ?? null,
    locations: (p.listings ?? []).length,
    publicUrl: p.publicUrl ?? null,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────

/** Set published state via PATCH (the proven verb; PUT ignores an unpublish). */
export async function publishListing(
  c: HyggloClient,
  id: number | string,
  published: boolean,
): Promise<WriteResult> {
  try {
    await c.sendRaw("PATCH", `/${HYGGLO_API_VERSION}/my/products/${encodeURIComponent(String(id))}?country=${COUNTRY}`, {
      isPublished: !!published,
    });
    return { ok: true, id };
  } catch (err) {
    if (err instanceof HyggloApiError) return { ok: false, status: err.status, error: err.body.slice(0, 200) };
    return { ok: false, error: String(err) };
  }
}

/**
 * Universal edit via full PUT (the ONLY way to change category / prices /
 * locations). Reuses the existing image. Publish state is enforced via a
 * follow-up PATCH because PUT ignores an unpublish.
 */
export async function editListing(
  c: HyggloClient,
  id: number | string,
  changes: ListingChanges,
): Promise<WriteResult> {
  const cur = await getItem(c, id);
  if (!cur) return { ok: false, error: `listing ${id} not found` };

  const existingBare = bare(cur.images?.[0]?.filename);
  const wantPublish = "isPublished" in changes ? !!changes.isPublished : undefined;

  // Locations: reuse the ones already on the product (idempotent), falling back
  // to a fresh lookup only if the detail carried none.
  const curLocIds = [
    ...new Set((cur.listings ?? []).map((l) => l.location?.id).filter((x): x is number => x != null)),
  ];
  const locIds = changes.locationIds ?? (curLocIds.length ? curLocIds : await locationIds(c));

  let name = (changes.name ?? cur.name ?? "").slice(0, NAME_MAX);
  let aiRetry = true;
  let lastStatus: number | undefined;
  let lastError = "exhausted retries";

  for (let attempt = 0; attempt < 4; attempt++) {
    const body = {
      name: name.slice(0, NAME_MAX),
      description: changes.description ?? cur.description ?? "",
      categoryId: changes.categoryId ?? cur.categoryId,
      valuation: changes.valuation ?? cur.valuation,
      isPublished: changes.isPublished ?? cur.isPublished ?? true,
      minimumRentalDays: changes.minimumRentalDays ?? cur.minimumRentalDays ?? 1,
      stockLevel: changes.stockLevel ?? cur.stockLevel ?? 1,
      cancellationTerms: changes.cancellationTerms ?? cur.cancellationTerms ?? CANCELLATION_DEFAULT,
      locationIds: locIds,
      prices: cleanPrices(changes.prices ?? cur.prices),
      images: [{ filename: existingBare, displayOrder: 0 }],
    };
    try {
      await c.sendRaw("PUT", `/${HYGGLO_API_VERSION}/my/products/${encodeURIComponent(String(id))}?country=${COUNTRY}`, body);
      if (wantPublish !== undefined) await publishListing(c, id, wantPublish);
      return { ok: true, id };
    } catch (err) {
      if (!(err instanceof HyggloApiError)) {
        lastError = String(err);
        if (attempt < 3) { await sleep(2000); continue; }
        return { ok: false, error: lastError };
      }
      lastStatus = err.status;
      lastError = err.body.slice(0, 300);
      const lower = (err.body ?? "").toLowerCase();
      if (isAiFail(lower) && aiRetry) {
        name = name.replace(COMPETITOR, "").trim();
        aiRetry = false;
        await sleep(1500);
        continue;
      }
      if (err.status >= 500 && attempt < 3) { await sleep(2500); continue; }
      return { ok: false, status: err.status, error: lastError };
    }
  }
  return { ok: false, status: lastStatus, error: lastError };
}

// ── Create / delete ─────────────────────────────────────────────────────────

/**
 * Upload image bytes to Hygglo's S3 via a presigned URL and return the BARE
 * `<uuid>.<ext>` filename to reference in create/edit payloads.
 */
export async function presignedUpload(
  c: HyggloClient,
  bytes: Buffer,
  mime = "image/png",
): Promise<string> {
  const { json } = await c.sendRaw(
    "POST",
    `/${HYGGLO_API_VERSION}/my/products/presigned-url?country=${COUNTRY}`,
    { mimeType: mime },
  );
  const url = (json as { url?: string })?.url;
  if (!url) throw new Error("presigned-url returned no url");
  const put = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": mime },
    // Buffer is a valid fetch body at runtime; the DOM BodyInit type omits it.
    body: bytes as unknown as BodyInit,
  });
  if (!(put.ok || put.status === 200 || put.status === 204)) {
    throw new Error(`S3 put failed: ${put.status}`);
  }
  return bare(url.split("?")[0].split("/").pop()!)!;
}

export interface CreatePayload {
  name: string;
  description?: string;
  categoryId: number;
  prices: HyggloPrice[];
  valuation?: number;
  /** Rendered listing image (PNG) — uploaded to Hygglo's S3 first. */
  pngBytes: Buffer;
  isPublished?: boolean;
  cancellationTerms?: string;
  minimumRentalDays?: number;
  stockLevel?: number;
  locationIds?: number[];
}

/** Create a new Hygglo listing (uploads the image, then POSTs the product). */
export async function createListing(c: HyggloClient, p: CreatePayload): Promise<WriteResult> {
  let name = (p.name || "").trim().slice(0, NAME_MAX);
  const locIds = p.locationIds ?? (await locationIds(c));

  let filename: string;
  try {
    filename = await presignedUpload(c, p.pngBytes);
  } catch (err) {
    return { ok: false, error: `image upload failed: ${String(err)}` };
  }

  let aiRetry = true;
  let lastStatus: number | undefined;
  let lastError = "exhausted retries";
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = {
      name: name.slice(0, NAME_MAX),
      description: p.description ?? "",
      categoryId: p.categoryId,
      valuation: p.valuation,
      isPublished: p.isPublished ?? true,
      cancellationTerms: p.cancellationTerms ?? CANCELLATION_DEFAULT,
      minimumRentalDays: p.minimumRentalDays ?? 1,
      stockLevel: p.stockLevel ?? 1,
      locationIds: locIds,
      prices: cleanPrices(p.prices),
      images: [{ filename, displayOrder: 0 }],
    };
    try {
      const { json } = await c.sendRaw("POST", `/${HYGGLO_API_VERSION}/my/products?country=${COUNTRY}`, body);
      const id = (json as { id?: number })?.id;
      // Hygglo publishes on create regardless of the body flag; enforce a
      // requested draft state with a follow-up PATCH (same as editListing).
      if (id != null && p.isPublished === false) await publishListing(c, id, false);
      return { ok: true, id };
    } catch (err) {
      if (!(err instanceof HyggloApiError)) {
        lastError = String(err);
        if (attempt < 3) { await sleep(2000); continue; }
        return { ok: false, error: lastError };
      }
      lastStatus = err.status;
      lastError = err.body.slice(0, 300);
      const lower = (err.body ?? "").toLowerCase();
      if (isAiFail(lower) && aiRetry) {
        name = name.replace(COMPETITOR, "").trim();
        aiRetry = false;
        await sleep(1500);
        continue;
      }
      if (err.status >= 500 && attempt < 3) { await sleep(2500); continue; }
      return { ok: false, status: err.status, error: lastError };
    }
  }
  return { ok: false, status: lastStatus, error: lastError };
}

/** Delete a listing. */
export async function deleteListing(c: HyggloClient, id: number | string): Promise<WriteResult> {
  try {
    await c.sendRaw("DELETE", `/${HYGGLO_API_VERSION}/my/products/${encodeURIComponent(String(id))}?country=${COUNTRY}`);
    return { ok: true, id };
  } catch (err) {
    if (err instanceof HyggloApiError) return { ok: false, status: err.status, error: err.body.slice(0, 200) };
    return { ok: false, error: String(err) };
  }
}

// ── Convenience wrappers ────────────────────────────────────────────────────

export function setPrice(c: HyggloClient, id: number | string, prices: HyggloPrice[]) {
  return editListing(c, id, { prices });
}

export function setCategory(c: HyggloClient, id: number | string, categoryId: number) {
  return editListing(c, id, { categoryId });
}

export function setLocations(c: HyggloClient, id: number | string, locationIds: number[]) {
  return editListing(c, id, { locationIds });
}

export function setPublished(c: HyggloClient, id: number | string, published: boolean) {
  return publishListing(c, id, published);
}

/** Add/update the "⏰ Opening times:" line in the description (no Hygglo API). */
export async function setOpeningTimes(
  c: HyggloClient,
  id: number | string,
  text: string,
): Promise<WriteResult> {
  const cur = await getItem(c, id);
  if (!cur) return { ok: false, error: `listing ${id} not found` };
  const desc = cur.description ?? "";
  const line = "⏰ Opening times: " + text;
  // `.match()` with a /g regex is stateless (unlike `.test()`); reuse is safe.
  const newDesc = desc.match(OPENING_LINE)
    ? desc.replace(OPENING_LINE, line)
    : desc.replace(/\s+$/, "") + "\n\n" + line;
  return editListing(c, id, { description: newDesc });
}
