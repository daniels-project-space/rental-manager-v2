export const LAB_CATALOG_ACCOUNTS = ["leo", "diogo", "dbcinema"] as const;
export type LabCatalogAccount = (typeof LAB_CATALOG_ACCOUNTS)[number];

export type LabCatalogItem = {
  source_id: string;
  name: string;
  display_name: string;
  aliases: string[];
  kind: string;
  qty: number;
  status: string;
  is_marketing_only: boolean;
  unit_kind: string;
  included_with_rental: string[];
  contents_source?: string;
  rental_facts?: { name: string; source: string };
  replacement_cost_gbp?: number;
};

export type LabCatalogComponent = { source_item_id: string; qty: number };
export type LabCatalogListing = {
  account_slug: LabCatalogAccount;
  product_id: number;
  name: string;
  description?: string;
  description_synced_at?: number;
  public_url?: string;
  is_published: boolean;
  is_marketing_only: boolean;
  marketing_only_override?: boolean;
  last_synced_at: number;
  minimum_rental_days?: number;
  valuation_gbp?: number;
  unavailable_dates: unknown[];
  prices: Array<{ days: number; pricePerDay: number }>;
  components: LabCatalogComponent[];
  unavailable_reason: string | null;
  source_receipt: {
    product_master_item_id: string | null;
    override_present: boolean;
    mapping_source: string | null;
    website_bookable?: boolean;
    website_review_required?: boolean;
  };
};

export type LabCatalogSnapshot = {
  items: LabCatalogItem[];
  listings: LabCatalogListing[];
  fetched_at: number;
  source_receipts: Array<{ source: string; fetched_at: number; row_count: number }>;
  source_counts: { inventory: number; listings: number; exact_overrides: number; website_listings: number };
  eligible_listings: number;
};

const MAX_SOURCE_AGE_MS = 48 * 60 * 60 * 1000;
const RENTAL_MANAGER_QUERY = "https://hearty-oyster-600.convex.cloud/api/query";
const DB_CINEMA_QUERY = "https://zany-wolf-18.convex.cloud/api/query";

// Explicit owner confirmations take precedence over stale per-item prose in
// the Rental Manager snapshot. These are item facts shared by every listing
// that maps to the same physical body, not account-specific chat rules.
const OWNER_CONFIRMED_CONTENTS: Record<string, string[]> = {
  "kn737xq0jcc8a011f6x2m6srt986az25": [
    "5× NP-F570 batteries", "1× 2TB SSD", "1× camera cage", "1× hard carrying case",
  ],
  "kn7bw2cr1ye5hqj3x770b332ks86atzw": [
    "3× Sony NP-FZ100 batteries", "1× 320GB CFexpress Type A card", "Sony dual battery charger",
  ],
  "kn74p93r60ndmmb0qghjqg84yh86abvh": [
    "3× Sony NP-FZ100 batteries", "2× 128GB SD cards", "Sony dual battery charger",
  ],
  "kn71951h7f9z8p3cea06v6zjjx86bgn4": [
    "3× Sony NP-FZ100 batteries", "1× 256GB SDXC V90 card", "Sony dual battery charger",
  ],
  "kn71src7p25m5ppzkxnjwadm1s86azfk": [
    "2× 128GB SD cards", "Sony dual battery charger",
  ],
};

// Preserve the stock row's source identity and quantity while enriching the
// generic storage label with the physical detail Daniel confirmed. Listing
// kit reconciliation consumes this fact so the 320GB card is not left as an
// unresolved mismatch against the FX3 kit description.
const OWNER_CONFIRMED_RENTAL_FACTS: Record<string, { name: string; source: string }> = {
  "kn78qeqezcrpjr12gzmynyfgb986b1rn": {
    name: "320GB CFexpress Type A card",
    source: "owner-confirmed physical stock detail",
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validTimestamp(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value <= now + 300_000 && now - value <= MAX_SOURCE_AGE_MS;
}

function validUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return new URL(value).hostname === "hygglo.com" ? value : undefined; } catch { return undefined; }
}

function productKey(account: string, id: number): string { return `${account}#${id}`; }

function websiteProductId(slug: unknown): number | null {
  if (typeof slug !== "string") return null;
  const match = slug.match(/-(\d{5,})$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Join read-only owner sources before the Lab writes its isolated catalogue.
 * Exact listing overrides are authoritative for product-to-stock identity;
 * the product masterItemId is retained as evidence only because it can be a
 * fuzzy match. DB Cinema's website decides whether its listing may be offered.
 */
export function buildLabCatalogSnapshot(input: {
  inventory: unknown;
  inventoryDetails: unknown;
  overrides: unknown;
  productsByAccount: Record<LabCatalogAccount, unknown>;
  dbCinemaWebsiteListings: unknown;
  now?: number;
}): LabCatalogSnapshot {
  const now = input.now ?? Date.now();
  if (!Array.isArray(input.inventory) || !Array.isArray(input.inventoryDetails) || !Array.isArray(input.overrides) ||
      !Array.isArray(input.dbCinemaWebsiteListings)) throw new Error("Lab catalog source response is incomplete");

  const itemRows = input.inventory.flatMap((raw) => {
    const row = record(raw);
    const id = nonempty(row?._id), name = nonempty(row?.name);
    if (!row || !id || !name || typeof row.qty !== "number" || !Number.isSafeInteger(row.qty) || row.qty < 0 ||
        typeof row.status !== "string" || typeof row.is_marketing_only !== "boolean") return [];
    return [{ row, id, name }];
  });
  if (itemRows.length !== input.inventory.length || new Set(itemRows.map((x) => x.id)).size !== itemRows.length ||
      new Set(itemRows.map((x) => x.name)).size !== itemRows.length) {
    throw new Error("Lab catalog inventory identities are malformed or ambiguous");
  }
  const detailsById = new Map<string, Record<string, unknown>>();
  for (const raw of input.inventoryDetails) {
    const row = record(raw), id = nonempty(row?.item_id);
    if (row && id) detailsById.set(id, row);
  }
  const items: LabCatalogItem[] = itemRows.map(({ row, id, name }) => {
    const detail = detailsById.get(id);
    const kind = nonempty(detail?.kind) ?? "unknown";
    const aliases = Array.isArray(row.aliases) ? row.aliases.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    const detailedAliases = Array.isArray(detail?.aliases) ? detail.aliases.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    const replacementCost = detail?.replacement_cost_gbp;
    const ownerConfirmedContents = OWNER_CONFIRMED_CONTENTS[id];
    const ownerConfirmedRentalFacts = OWNER_CONFIRMED_RENTAL_FACTS[id];
    const includedWithRental = ownerConfirmedContents ?? (Array.isArray(detail?.included_with_rental)
      ? detail.included_with_rental.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
    const contentsSource = ownerConfirmedContents ? "owner-confirmed kit contents" : undefined;
    return {
      source_id: id,
      name,
      display_name: nonempty(row.display_name) ?? name,
      aliases: [...new Set([...aliases, ...detailedAliases])],
      kind,
      qty: row.qty as number,
      status: row.status as string,
      is_marketing_only: row.is_marketing_only as boolean,
      unit_kind: kind === "bundle" || includedWithRental.length > 0 ? "kit" : "unit",
      included_with_rental: includedWithRental,
      ...(contentsSource ? { contents_source: contentsSource } : {}),
      ...(ownerConfirmedRentalFacts ? { rental_facts: ownerConfirmedRentalFacts } : {}),
      ...(typeof replacementCost === "number" && Number.isFinite(replacementCost) && replacementCost > 0
        ? { replacement_cost_gbp: replacementCost } : {}),
    };
  });
  const itemById = new Map(items.map((item) => [item.source_id, item]));

  const overrideByKey = new Map<string, { components: LabCatalogComponent[]; present: boolean; source: string }>();
  for (const raw of input.overrides) {
    const row = record(raw);
    if (!row || typeof row.account_slug !== "string" || !LAB_CATALOG_ACCOUNTS.includes(row.account_slug as LabCatalogAccount) ||
        typeof row.product_id !== "number" || !Number.isSafeInteger(row.product_id) || !Array.isArray(row.components)) continue;
    const key = productKey(row.account_slug, row.product_id);
    if (overrideByKey.has(key)) throw new Error(`Duplicate exact listing override: ${key}`);
    const parsedComponents = row.components.flatMap((rawComponent) => {
      const component = record(rawComponent);
      if (!component || typeof component.item_id !== "string" || typeof component.qty !== "number" ||
          !Number.isSafeInteger(component.qty) || component.qty < 1 || !itemById.has(component.item_id)) return [];
      return [{ source_item_id: component.item_id, qty: component.qty }];
    });
    const aggregated = new Map<string, number>();
    for (const component of parsedComponents) aggregated.set(component.source_item_id,
      (aggregated.get(component.source_item_id) ?? 0) + component.qty);
    const components = [...aggregated].map(([source_item_id, qty]) => ({ source_item_id, qty }));
    overrideByKey.set(key, { components: parsedComponents.length === row.components.length ? components : [], present: true,
      source: "Rental Manager exact listing override" });
  }

  const websiteByProduct = new Map<number, Record<string, unknown>>();
  for (const raw of input.dbCinemaWebsiteListings) {
    const row = record(raw), id = websiteProductId(row?.slug);
    if (row && id != null) {
      if (websiteByProduct.has(id)) throw new Error(`Duplicate DB Cinema website listing id: ${id}`);
      websiteByProduct.set(id, row);
    }
  }

  const listings: LabCatalogListing[] = [];
  for (const account of LAB_CATALOG_ACCOUNTS) {
    const products = input.productsByAccount[account];
    if (!Array.isArray(products)) throw new Error(`Missing ${account} product snapshot`);
    const seen = new Set<number>();
    for (const raw of products) {
      const product = record(raw);
      if (!product || product.accountSlug !== account || typeof product.productId !== "number" || !Number.isSafeInteger(product.productId)) continue;
      const productId = product.productId;
      if (seen.has(productId)) throw new Error(`Duplicate ${account} product: ${productId}`);
      seen.add(productId);
      const name = nonempty(product.name);
      if (!name) continue;
      let override = overrideByKey.get(productKey(account, productId));
      // These two exact FX3 listings have owner-confirmed physical identity
      // from the prepared Lab examples. Keep this exception narrow to the
      // exact account/product/item tuple; never promote a fuzzy link globally.
      const preparedFx3 = (account === "leo" && productId === 1097510) || (account === "diogo" && productId === 1173763);
      if (!override && preparedFx3 && product.masterItemId === "kn7bw2cr1ye5hqj3x770b332ks86atzw" &&
          /\bsony\s+fx3\b/i.test(name)) {
        override = { present: true, source: "owner-confirmed prepared Lab Sony FX3 mapping",
          components: [{ source_item_id: "kn7bw2cr1ye5hqj3x770b332ks86atzw", qty: 1 }] };
      }
      const components = override?.components ?? [];
      const allPhysical = components.length > 0 && components.every((component) => {
        const item = itemById.get(component.source_item_id);
        return item?.status === "active" && !item.is_marketing_only && item.qty >= component.qty;
      });
      const website = account === "dbcinema" ? websiteByProduct.get(productId) : undefined;
      const websiteOwned = record(website?.inventoryFacts);
      const websiteAvailable = account === "dbcinema" && website?.bookable === true && website?.marketingOnly === false &&
        website?.displayOnly !== true && websiteOwned?.owned === true && websiteOwned.reviewRequired === false;
      const effectiveOwnerMarketingOnly = typeof product.isMarketingOnlyOverride === "boolean"
        ? product.isMarketingOnlyOverride : product.isMarketingOnly === true;
      const published = product.isPublished === true;
      const sourceAvailable = account === "dbcinema" ? websiteAvailable : published && !effectiveOwnerMarketingOnly;
      const lastSyncedAt = typeof product.lastSyncedAt === "number" ? product.lastSyncedAt : 0;
      const descriptionSyncedAt = typeof product.descriptionSyncedAt === "number" ? product.descriptionSyncedAt : undefined;
      const fresh = validTimestamp(lastSyncedAt, now) && validTimestamp(descriptionSyncedAt, now);
      const description = nonempty(product.description);
      const prices = Array.isArray(product.prices) ? product.prices.flatMap((rawTier) => {
        const tier = record(rawTier);
        if (!tier || typeof tier.days !== "number" || !Number.isSafeInteger(tier.days) || tier.days < 1 || tier.days > 366 ||
            typeof tier.pricePerDay !== "number" || !Number.isFinite(tier.pricePerDay) || tier.pricePerDay <= 0) return [];
        return [{ days: tier.days, pricePerDay: tier.pricePerDay }];
      }) : [];
      const oneDayPrice = prices.find((tier) => tier.days === 1);
      const validTiers = new Set(prices.map((tier) => tier.days)).size === prices.length;
      const eligible = published && sourceAvailable && fresh && !!description && !!oneDayPrice && validTiers &&
        !!override?.present && components.length > 0 && allPhysical;
      const websiteBlockReason = !website ? "website_listing_missing"
        : websiteOwned?.reviewRequired !== false ? "website_requires_review"
          : websiteOwned?.owned !== true ? "website_inventory_not_owned"
            : website?.bookable !== true || website?.marketingOnly !== false || website?.displayOnly === true ? "website_not_bookable" : null;
      const unavailableReason = !published ? "listing_not_published"
        : !sourceAvailable ? account === "dbcinema" ? websiteBlockReason ?? "website_not_bookable" : "owner_marked_unavailable"
          : !override?.present || components.length === 0 ? "exact_stock_mapping_missing"
            : !allPhysical ? "mapped_stock_not_available" : !fresh || !description ? "listing_details_stale_or_missing"
              : !oneDayPrice || !validTiers ? "listing_price_missing_or_invalid" : null;
      const masterItemId = typeof product.masterItemId === "string" ? product.masterItemId : null;
      listings.push({
        account_slug: account,
        product_id: productId,
        name,
        ...(description && fresh ? { description } : {}),
        ...(descriptionSyncedAt != null && fresh ? { description_synced_at: descriptionSyncedAt } : {}),
        ...(validUrl(product.publicUrl) ? { public_url: validUrl(product.publicUrl) } : {}),
        is_published: published,
        is_marketing_only: !eligible,
        ...(account === "dbcinema" ? { marketing_only_override: !eligible } :
          typeof product.isMarketingOnlyOverride === "boolean" ? { marketing_only_override: product.isMarketingOnlyOverride } : {}),
        last_synced_at: lastSyncedAt,
        ...(typeof product.minimumRentalDays === "number" && Number.isSafeInteger(product.minimumRentalDays) && product.minimumRentalDays > 0
          ? { minimum_rental_days: product.minimumRentalDays } : {}),
        ...(typeof product.valuation === "number" && Number.isFinite(product.valuation) && product.valuation > 0
          ? { valuation_gbp: product.valuation } : {}),
        unavailable_dates: Array.isArray(product.unavailableDates) ? product.unavailableDates.slice(0, 500) : [],
        prices: validTiers ? prices : [],
        components,
        unavailable_reason: unavailableReason,
        source_receipt: {
          product_master_item_id: masterItemId,
          override_present: !!override?.present,
          mapping_source: override?.source ?? null,
          ...(account === "dbcinema" ? {
            website_bookable: website?.bookable === true,
            website_review_required: websiteOwned?.reviewRequired !== false,
          } : {}),
        },
      });
    }
  }
  return {
    items,
    listings,
    fetched_at: now,
    source_receipts: [
      { source: "rental_manager_inventory", fetched_at: now, row_count: items.length },
      { source: "rental_manager_exact_listing_mappings", fetched_at: now,
        row_count: [...overrideByKey.values()].filter((row) => row.present).length },
      ...LAB_CATALOG_ACCOUNTS.map((account) => ({ source: `rental_manager_listings:${account}`, fetched_at: now,
        row_count: listings.filter((listing) => listing.account_slug === account).length })),
      { source: "db_cinema_website_catalog", fetched_at: now, row_count: websiteByProduct.size },
      { source: "owner-confirmed kit contents", fetched_at: now, row_count: Object.keys(OWNER_CONFIRMED_CONTENTS).length },
    ],
    source_counts: {
      inventory: items.length,
      listings: listings.length,
      exact_overrides: [...overrideByKey.values()].filter((row) => row.present).length,
      website_listings: websiteByProduct.size,
    },
    eligible_listings: listings.filter((listing) => !listing.is_marketing_only && listing.is_published).length,
  };
}

/** Read the complete current Rental Manager catalogue and DB Cinema's public
 * bookability catalogue. This intentionally never requests reservations,
 * renter profiles, conversations, or message history. */
export async function fetchLabCatalogSnapshot(
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<LabCatalogSnapshot> {
  const read = async (base: string, path: string, args: unknown): Promise<unknown> => {
    const response = await fetcher(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Lab catalogue source request failed");
    const payload = record(await response.json());
    if (payload?.status !== "success" || !("value" in payload))
      throw new Error("Lab catalogue source returned an invalid response");
    return payload.value;
  };

  const [inventory, detailResponse, overrides, leo, diogo, dbcinema, website] = await Promise.all([
    read(RENTAL_MANAGER_QUERY, "items:listForReconcile", {}),
    read(RENTAL_MANAGER_QUERY, "listing_info_pool:admin_getDerivationBatch", { force: true, targets: [] }),
    read(RENTAL_MANAGER_QUERY, "listing_overrides:getAll", {}),
    read(RENTAL_MANAGER_QUERY, "hygglo_products:list", { accountSlug: "leo" }),
    read(RENTAL_MANAGER_QUERY, "hygglo_products:list", { accountSlug: "diogo" }),
    read(RENTAL_MANAGER_QUERY, "hygglo_products:list", { accountSlug: "dbcinema" }),
    read(DB_CINEMA_QUERY, "catalog:listListings", {}),
  ]);
  const detail = record(detailResponse);
  if (!Array.isArray(detail?.inventory)) throw new Error("Lab catalogue inventory detail snapshot is missing");
  return buildLabCatalogSnapshot({
    inventory,
    inventoryDetails: detail.inventory,
    overrides,
    productsByAccount: { leo, diogo, dbcinema },
    dbCinemaWebsiteListings: website,
    now,
  });
}

/**
 * Prepared conversations may add a missing, owner-confirmed accessory pool,
 * but they must never rewrite a source-synced physical item's identity or
 * owned quantity. Scenario descriptions are listing-specific and belong on
 * the listing, not on shared inventory rows.
 */
export function preparedLabItemPatch(
  existing: Record<string, unknown> | null,
  proposed: Record<string, unknown>,
  suppliedStock: Array<{ item_id: string; qty: number; source: string }> | undefined,
  now: number,
): Record<string, unknown> {
  if (existing && typeof existing.lab_source_inventory_id === "string") {
    return {
      ...((!Array.isArray(existing.supplied_stock) || existing.supplied_stock.length === 0) && suppliedStock?.length
        ? { supplied_stock: suppliedStock } : {}),
      updated_at: now,
    };
  }
  return {
    ...proposed,
    ...(suppliedStock?.length ? { supplied_stock: suppliedStock } : {}),
    updated_at: now,
  };
}
