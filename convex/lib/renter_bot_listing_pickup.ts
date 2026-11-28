/** Owner-verified, listing-scoped pickup state. Transient reasons expire. */
export const PICKUP_AVAILABILITY_STATUSES = [
  "account_area_only",
  "currently_on_rental",
  "in_repair",
  "assigned_to_set",
  "unknown",
] as const;

export type PickupAvailabilityStatus = (typeof PICKUP_AVAILABILITY_STATUSES)[number];

export interface PickupAvailabilityFact {
  status: PickupAvailabilityStatus;
  customer_explanation?: string;
  source: string;
  source_url?: string;
  verified_at: number;
  valid_until?: number;
  applies_start_date?: string;
  applies_end_date?: string;
}

export type OwnerPickupAvailabilityStatus = Exclude<PickupAvailabilityStatus, "unknown">;

export interface ListingSourceReceipt {
  account_slug: string;
  product_id: number;
  listing_name: string;
  checked_at: number;
  listing_source?: string;
  public_url?: string;
  listing_synced_at?: number;
  listing_description_synced_at?: number;
  listing_description_source?: string;
  listing_description_updated_at?: number;
  inventory_name?: string;
  inventory_updated_at?: number;
  mapping_complete?: boolean;
  kit_source?: string;
  kit_contents?: string[];
  kit_contents_source?: string;
  kit_contents_recorded_at?: number;
  inventory_components: Array<{
    name: string;
    requested_units: number;
    source_updated_at?: number;
  }>;
}

export interface PickupFactReceipt extends PickupAvailabilityFact {
  account_slug: string;
  product_id: number;
  listing_name: string;
  pickup_area?: string;
  checked_at: number;
}

const MAX_STANDING_FACT_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_TRANSIENT_FACT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CUSTOMER_EXPLANATION_CHARS = 80;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Only return a pickup reason if its provenance and time window are valid.
 * Standing account-area policy can age for six months; rental, repair and set
 * status must carry a short expiry and an owner-written customer explanation.
 */
export function currentPickupAvailability(
  value: unknown,
  now = Date.now(),
): PickupAvailabilityFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    !PICKUP_AVAILABILITY_STATUSES.includes(record.status as PickupAvailabilityStatus) ||
    typeof record.source !== "string" ||
    !record.source.trim() ||
    typeof record.verified_at !== "number" ||
    !Number.isFinite(record.verified_at) ||
    record.verified_at > now + FUTURE_CLOCK_SKEW_MS
  ) return null;

  const status = record.status as PickupAvailabilityStatus;
  const customerExplanation = typeof record.customer_explanation === "string"
    ? record.customer_explanation.trim()
    : "";
  const sourceUrl = typeof record.source_url === "string" && record.source_url.trim()
    ? record.source_url.trim()
    : undefined;
  const validUntil = typeof record.valid_until === "number" && Number.isFinite(record.valid_until)
    ? record.valid_until
    : undefined;
  const appliesStartDate = isIsoDay(record.applies_start_date) ? record.applies_start_date : undefined;
  const appliesEndDate = isIsoDay(record.applies_end_date) ? record.applies_end_date : undefined;

  if (status === "account_area_only") {
    if (now - record.verified_at > MAX_STANDING_FACT_AGE_MS || (validUntil != null && now >= validUntil)) return null;
  } else {
    if (
      status === "unknown" ||
      !customerExplanation ||
      customerExplanation.length > MAX_CUSTOMER_EXPLANATION_CHARS ||
      !appliesStartDate ||
      !appliesEndDate ||
      appliesStartDate > appliesEndDate ||
      validUntil == null ||
      validUntil <= now ||
      now - record.verified_at > MAX_TRANSIENT_FACT_AGE_MS ||
      validUntil - record.verified_at > MAX_TRANSIENT_FACT_AGE_MS
    ) return null;
  }

  return {
    status,
    ...(customerExplanation ? { customer_explanation: customerExplanation } : {}),
    source: record.source.trim().slice(0, 300),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    verified_at: record.verified_at,
    ...(validUntil != null ? { valid_until: validUntil } : {}),
    ...(appliesStartDate ? { applies_start_date: appliesStartDate } : {}),
    ...(appliesEndDate ? { applies_end_date: appliesEndDate } : {}),
  };
}

/** Validate and timestamp a pickup explanation before it is written by an owner. */
export function buildOwnerVerifiedPickupAvailability(
  input: unknown,
  now = Date.now(),
): PickupAvailabilityFact {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Pickup status details are required");
  }
  const record = input as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string" || !PICKUP_AVAILABILITY_STATUSES.includes(status as PickupAvailabilityStatus) || status === "unknown") {
    throw new Error("Choose a supported, owner-confirmed pickup status");
  }
  const source = boundedString(record.source, 300);
  if (!source) throw new Error("Record the source used to confirm this pickup status");
  const sourceUrl = boundedString(record.source_url, 1000);
  if (record.source_url != null && !sourceUrl) throw new Error("The pickup evidence link is invalid");
  if (sourceUrl) {
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { throw new Error("The pickup evidence link must be a full HTTP(S) URL"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("The pickup evidence link must be a full HTTP(S) URL");
    }
  }
  if (status === "account_area_only") {
    return {
      status,
      source,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      verified_at: now,
    };
  }

  const rawExplanation = record.customer_explanation;
  const customerExplanation = typeof rawExplanation === "string" ? rawExplanation.trim() : "";
  if (!customerExplanation || customerExplanation.length > MAX_CUSTOMER_EXPLANATION_CHARS) {
    throw new Error(`Enter a renter-facing explanation of ${MAX_CUSTOMER_EXPLANATION_CHARS} characters or fewer`);
  }
  const startDate = record.applies_start_date;
  const endDate = record.applies_end_date;
  if (!isIsoDay(startDate) || !isIsoDay(endDate) || startDate > endDate) {
    throw new Error("Enter a valid pickup-status date range covering the renter's requested dates");
  }
  const validUntil = record.valid_until;
  if (typeof validUntil !== "number" || !Number.isFinite(validUntil) || validUntil <= now || validUntil - now > MAX_TRANSIENT_FACT_AGE_MS) {
    throw new Error("Temporary pickup status must expire within 14 days; reconfirm it if still current");
  }
  return {
    status: status as Exclude<PickupAvailabilityStatus, "account_area_only" | "unknown">,
    customer_explanation: customerExplanation,
    source,
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    verified_at: now,
    valid_until: validUntil,
    applies_start_date: startDate,
    applies_end_date: endDate,
  };
}

/** Transient reasons are usable only for a rental period covered by the owner record. */
export function pickupAvailabilityAppliesToRental(
  fact: PickupAvailabilityFact,
  startDate: unknown,
  endDate: unknown,
): boolean {
  if (fact.status === "account_area_only") return true;
  return isIsoDay(startDate) && isIsoDay(endDate) && startDate <= endDate &&
    !!fact.applies_start_date && !!fact.applies_end_date &&
    fact.applies_start_date <= startDate && fact.applies_end_date >= endDate;
}

function boundedString(value: unknown, limit = 300): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Reduce raw listing-context output to auditable, account/listing-scoped receipts. */
export function buildListingSourceReceipts(
  value: unknown,
  accountSlug?: string | null,
  now = Date.now(),
): ListingSourceReceipt[] {
  if (!Array.isArray(value)) return [];
  const receipts: ListingSourceReceipt[] = [];
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.account_slug !== "string" || !row.account_slug.trim() ||
        (accountSlug && row.account_slug !== accountSlug) ||
        typeof row.product_id !== "number" || !Number.isSafeInteger(row.product_id) ||
        row.product_id <= 0) continue;
    const listingName = boundedString(row.listing_name) ?? boundedString(row.name);
    if (!listingName) continue;
    const url = boundedString(row.public_url, 1000);
    const components = Array.isArray(row.inventory_components)
      ? row.inventory_components.slice(0, 24).flatMap((component) => {
          if (!component || typeof component !== "object" || Array.isArray(component)) return [];
          const item = component as Record<string, unknown>;
          const name = boundedString(item.name);
          const requestedUnits = item.requested_units;
          if (!name || typeof requestedUnits !== "number" || !Number.isFinite(requestedUnits) || requestedUnits <= 0) return [];
          const sourceUpdatedAt = finiteTimestamp(item.source_updated_at);
          return [{ name, requested_units: requestedUnits, ...(sourceUpdatedAt != null ? { source_updated_at: sourceUpdatedAt } : {}) }];
        })
      : [];
    const rawKitContents = Array.isArray(row.included_with_rental)
      ? row.included_with_rental.slice(0, 24).flatMap((entry) => {
          const content = boundedString(entry, 240);
          return content ? [content] : [];
        })
      : [];
    const kitContentsSource = boundedString(row.included_with_rental_source);
    const kitContentsRecordedAt = finiteTimestamp(row.included_with_rental_recorded_at);
    const verifiedKitContents = rawKitContents.length && kitContentsSource && kitContentsRecordedAt != null
      ? rawKitContents
      : undefined;
    const listingSyncedAt = finiteTimestamp(row.listing_synced_at);
    const descriptionSyncedAt = finiteTimestamp(row.listing_description_synced_at);
    const inventoryUpdatedAt = finiteTimestamp(row.inventory_updated_at);
    receipts.push({
      account_slug: row.account_slug.trim(),
      product_id: row.product_id,
      listing_name: listingName,
      checked_at: now,
      ...(boundedString(row.listing_source) ? { listing_source: boundedString(row.listing_source) } : {}),
      ...(url?.startsWith("https://") ? { public_url: url } : {}),
      ...(listingSyncedAt != null ? { listing_synced_at: listingSyncedAt } : {}),
      ...(descriptionSyncedAt != null ? { listing_description_synced_at: descriptionSyncedAt } : {}),
      ...(boundedString(row.listing_description_source) ? { listing_description_source: boundedString(row.listing_description_source) } : {}),
      ...(finiteTimestamp(row.listing_description_updated_at) != null ? { listing_description_updated_at: finiteTimestamp(row.listing_description_updated_at) } : {}),
      ...(boundedString(row.inventory_name) ? { inventory_name: boundedString(row.inventory_name) } : {}),
      ...(inventoryUpdatedAt != null ? { inventory_updated_at: inventoryUpdatedAt } : {}),
      ...(typeof row.mapping_complete === "boolean" ? { mapping_complete: row.mapping_complete } : {}),
      ...(boundedString(row.kit_source) ? { kit_source: boundedString(row.kit_source) } : {}),
      ...(verifiedKitContents ? {
        kit_contents: verifiedKitContents,
        kit_contents_source: kitContentsSource,
        kit_contents_recorded_at: kitContentsRecordedAt,
      } : {}),
      inventory_components: components,
    });
  }
  return receipts;
}

/** Keep only current pickup facts for the exact active account/listing and rental dates. */
export function buildPickupFactReceipts(
  value: unknown,
  accountSlug: string | null | undefined,
  startDate: unknown,
  endDate: unknown,
  pickupArea: string | undefined,
  now = Date.now(),
): PickupFactReceipt[] {
  if (!Array.isArray(value) || !accountSlug) return [];
  const receipts: PickupFactReceipt[] = [];
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.account_slug !== accountSlug || typeof row.product_id !== "number" || !Number.isSafeInteger(row.product_id) || row.product_id <= 0) continue;
    const fact = currentPickupAvailability(row.pickup_availability, now);
    const listingName = boundedString(row.listing_name) ?? boundedString(row.name);
    if (!fact || !listingName || !pickupAvailabilityAppliesToRental(fact, startDate, endDate)) continue;
    receipts.push({
      ...fact,
      account_slug: accountSlug,
      product_id: row.product_id,
      listing_name: listingName,
      ...(pickupArea?.trim() ? { pickup_area: pickupArea.trim().slice(0, 120) } : {}),
      checked_at: now,
    });
  }
  return receipts;
}

/**
 * A transient pickup reason belongs to one exact listing. Do not select one
 * by explanation text alone: a basket may contain several unrelated listings
 * whose reasons must not be applied to each other.
 */
export function verifiedPickupReasonForSingleListing(
  listingSources: unknown,
  pickupFacts: unknown,
  accountSlug: string | null | undefined,
  now = Date.now(),
): string | undefined {
  if (!accountSlug || !Array.isArray(listingSources) || !Array.isArray(pickupFacts)) return undefined;

  const productIds = new Set<number>();
  for (const raw of listingSources) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.account_slug !== accountSlug || typeof row.product_id !== "number" ||
        !Number.isSafeInteger(row.product_id) || row.product_id <= 0) continue;
    productIds.add(row.product_id);
  }
  if (productIds.size !== 1) return undefined;

  const [productId] = productIds;
  const reasons: string[] = [];
  for (const raw of pickupFacts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.account_slug !== accountSlug || row.product_id !== productId) continue;
    const fact = currentPickupAvailability(row, now);
    if (!fact || fact.status === "unknown") continue;
    if (fact.status === "account_area_only") {
      const pickupArea = boundedString(row.pickup_area, 120);
      if (!pickupArea) continue;
      // This standing owner-confirmed fact is itself the reason the listing
      // cannot be handed off elsewhere. Describe that arrangement directly;
      // do not invent a temporary rental, repair, or set conflict.
      reasons.push(`This kit is only available for pickup and return from the ${pickupArea}.`);
      continue;
    }
    if (!fact.customer_explanation) continue;
    reasons.push(fact.customer_explanation);
  }
  return reasons.length === 1 ? reasons[0] : undefined;
}

/** A neutral customer-safe fallback when no verified item-specific reason exists. */
export function pickupAreaFallback(area: string): string {
  return `For this rental, collection and return are arranged from the ${area} area. Would collecting and returning there work for your dates?`;
}
