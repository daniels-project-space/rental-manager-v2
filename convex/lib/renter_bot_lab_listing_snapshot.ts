import { renterBotLabScenario } from "./renter_bot_lab_scenarios";
/** Read-only listing-price snapshots for the isolated Lab's prepared examples. */
const SOURCE = "https://hearty-oyster-600.convex.cloud/api/query";
const MAX_SYNC_AGE_MS = 48 * 60 * 60 * 1000;
const SOURCES: Record<string, { account: string; productId: number; masterItemId: string; inventoryName: string; listingTitlePart: string }> = {
  "bmpcc-6k-full-frame-kit": { account: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf", inventoryName: "BMPCC 6K Full Frame", listingTitlePart: "Blackmagic 6K Full Frame" },
  "verification-failed": { account: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf", inventoryName: "BMPCC 6K Full Frame", listingTitlePart: "Blackmagic 6K Full Frame" },
  "confirmed-booking": { account: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf", inventoryName: "BMPCC 6K Full Frame", listingTitlePart: "Blackmagic 6K Full Frame" },
  "sony-fx3-batteries": { account: "leo", productId: 1097510, masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw", inventoryName: "Sony FX3", listingTitlePart: "Sony FX3" },
  // The listing is a kit, but physical inventory is the Sony FX3 body. Keep
  // the account-specific kit contents on the listing so shared stock is not
  // duplicated under a second, listing-shaped item identity.
  "diogo-sony-fx3-kit": { account: "diogo", productId: 1173763, masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw", inventoryName: "Sony FX3", listingTitlePart: "Sony FX3" },
};

/** Physical source identity for a prepared example, scoped to its account. */
export function preparedScenarioSourceInventoryId(scenarioId: string, account: string): string | null {
  const source = SOURCES[scenarioId];
  return source?.account === account ? source.masterItemId : null;
}

/** Prepared source IDs are usable only with the matching server-owned item. */
export function matchesPreparedListing(account: string, productId: number, itemName: string): boolean {
  return Object.entries(SOURCES).some(([scenarioId, source]) => source.account === account &&
    source.productId === productId && renterBotLabScenario(scenarioId)?.item.name_canonical === itemName);
}

export type PreparedListingPrice = {
  account_slug: string;
  product_id: number;
  master_item_id: string;
  inventory_name: string;
  listing_name: string;
  listing_description: string;
  listing_description_synced_at: number;
  public_url: string;
  daily_price_gbp: number;
  price_tiers: Array<{ days: number; pricePerDay: number }>;
  mapping_components: Array<{ item_id: string; qty: number }>;
  mapping_source: string;
  source_synced_at: number;
  checked_at: number;
  mapping_verified?: boolean;
};

export type PreparedOrderPrice = Pick<PreparedListingPrice,
  "product_id" | "daily_price_gbp" | "price_tiers" | "source_synced_at" | "checked_at" | "mapping_verified">;

/** Translate Rental Manager inventory IDs into the isolated Lab's Convex IDs. */
export function mapPreparedComponentsToLabIds<LabId extends string>(
  sourceComponents: readonly { item_id: string; qty: number }[],
  labIdsBySourceId: ReadonlyMap<string, LabId>,
): Array<{ item_id: LabId; qty: number }> | null {
  if (!sourceComponents.length || new Set(sourceComponents.map((component) => component.item_id)).size !== sourceComponents.length) return null;
  const mapped: Array<{ item_id: LabId; qty: number }> = [];
  for (const component of sourceComponents) {
    const localId = labIdsBySourceId.get(component.item_id);
    if (!localId || !Number.isSafeInteger(component.qty) || component.qty < 1) return null;
    mapped.push({ item_id: localId, qty: component.qty });
  }
  return mapped.sort((a, b) => a.item_id.localeCompare(b.item_id));
}

/** The order contract stays price-only; listing evidence is stored separately. */
export function preparedOrderPrice(snapshot: PreparedListingPrice): PreparedOrderPrice {
  return {
    product_id: snapshot.product_id,
    daily_price_gbp: snapshot.daily_price_gbp,
    price_tiers: snapshot.price_tiers,
    source_synced_at: snapshot.source_synced_at,
    checked_at: snapshot.checked_at,
    mapping_verified: snapshot.mapping_verified,
  };
}

/** Recheck the action-provided snapshot at the local write boundary. */
export function matchesPreparedListingSnapshot(
  scenarioId: string,
  account: string,
  snapshot: PreparedListingPrice,
  now = Date.now(),
): boolean {
  const source = SOURCES[scenarioId];
  if (!source || source.account !== account || snapshot.account_slug !== account ||
      snapshot.product_id !== source.productId || snapshot.master_item_id !== source.masterItemId ||
      snapshot.inventory_name !== source.inventoryName || snapshot.mapping_verified !== true ||
      !snapshot.listing_name.toLowerCase().includes(source.listingTitlePart.toLowerCase()) ||
      !snapshot.listing_description.trim() || !Number.isFinite(snapshot.listing_description_synced_at) ||
      now - snapshot.source_synced_at < 0 || now - snapshot.source_synced_at > MAX_SYNC_AGE_MS ||
      now - snapshot.listing_description_synced_at < 0 || now - snapshot.listing_description_synced_at > MAX_SYNC_AGE_MS ||
      now - snapshot.checked_at < 0 || now - snapshot.checked_at > 5 * 60 * 1000) return false;
  if (!snapshot.mapping_components.length || !snapshot.mapping_source.trim() ||
      snapshot.mapping_components.some((component) => !component.item_id.trim() || !Number.isSafeInteger(component.qty) || component.qty < 1) ||
      new Set(snapshot.mapping_components.map((component) => component.item_id)).size !== snapshot.mapping_components.length ||
      snapshot.mapping_components.filter((component) => component.item_id === source.masterItemId && component.qty === 1).length !== 1) return false;
  try {
    return new URL(snapshot.public_url).hostname === "hygglo.com";
  } catch {
    return false;
  }
}

/** Read the exact published listing's cached tiers. Never fall back to a
 * different listing or a generic inventory price when the source is absent. */
export async function preparedListingPrice(
  scenarioId: string,
  account: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<PreparedListingPrice | null> {
  const source = SOURCES[scenarioId];
  if (!source || source.account !== account) return null;
  try {
    const response = await fetcher(SOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "hygglo_products:getByMasterItem", args: { masterItemId: source.masterItemId }, format: "json" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("status" in payload) || payload.status !== "success" ||
        !("value" in payload) || !Array.isArray(payload.value)) return null;
    const matches = (payload.value as unknown[]).filter((row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && "accountSlug" in row && "productId" in row &&
      row.accountSlug === account && row.productId === source.productId);
    if (matches.length !== 1) return null;
    const product = matches[0];
    if (product.masterItemId !== source.masterItemId || product.isPublished !== true || product.isMarketingOnly !== false ||
        typeof product.lastSyncedAt !== "number" || !Number.isFinite(product.lastSyncedAt) ||
        product.lastSyncedAt > now + 300000 || now - product.lastSyncedAt > MAX_SYNC_AGE_MS || !Array.isArray(product.prices) ||
        typeof product.name !== "string" || !product.name.toLowerCase().includes(source.listingTitlePart.toLowerCase()) ||
        typeof product.description !== "string" || !product.description.trim() ||
        typeof product.descriptionSyncedAt !== "number" || !Number.isFinite(product.descriptionSyncedAt) ||
        product.descriptionSyncedAt > now + 300000 || now - product.descriptionSyncedAt > MAX_SYNC_AGE_MS ||
        typeof product.publicUrl !== "string" || new URL(product.publicUrl).hostname !== "hygglo.com") return null;
    const tiers = (product.prices as unknown[]).flatMap((tier) => {
      if (!tier || typeof tier !== "object" || !("days" in tier) || !("pricePerDay" in tier) ||
          typeof tier.days !== "number" || !Number.isInteger(tier.days) || tier.days < 1 || tier.days > 366 ||
          typeof tier.pricePerDay !== "number" || !Number.isFinite(tier.pricePerDay) || tier.pricePerDay <= 0) return [];
      return [{ days: tier.days, pricePerDay: tier.pricePerDay }];
    });
    if (new Set(tiers.map((tier) => tier.days)).size !== tiers.length) return null;
    const oneDay = tiers.find((tier) => tier.days === 1);
    if (!oneDay) return null;
    let mappingComponents: Array<{ item_id: string; qty: number }> | null = null;
    let mappingSource = "Rental Manager exact listing override";
    let exactMappingAbsent = false;
    try {
      const mappingResponse = await fetcher(SOURCE, { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({path:"listing_overrides:getRevision",args:{account_slug:account,product_id:source.productId},format:"json"}),
        signal:AbortSignal.timeout(5000) });
      const result = await mappingResponse.json() as {status?:string;value?:{available?:boolean;revision?:string}};
      if (mappingResponse.ok && result.status === "success" && result.value?.available === true && typeof result.value.revision === "string") {
        const mapping = JSON.parse(result.value.revision) as { account_slug?: unknown; product_id?: unknown; components?: unknown } | null;
        if (mapping === null) exactMappingAbsent = true;
        else if (mapping.account_slug === account && mapping.product_id === source.productId && Array.isArray(mapping.components)) {
          const aggregated = new Map<string, number>();
          for (const raw of mapping.components) {
            if (!raw || typeof raw !== "object") { aggregated.clear(); break; }
            const component = raw as { item_id?: unknown; qty?: unknown };
            if (typeof component.item_id !== "string" || !component.item_id.trim() ||
                typeof component.qty !== "number" || !Number.isSafeInteger(component.qty) || component.qty < 1) {
              aggregated.clear(); break;
            }
            aggregated.set(component.item_id, (aggregated.get(component.item_id) ?? 0) + component.qty);
          }
          if (aggregated.size) mappingComponents = [...aggregated].map(([item_id, qty]) => ({ item_id, qty }));
        }
      }
    } catch { /* A current price is not proof of a physical stock mapping. */ }
    // This Diogo prepared offer was owner-confirmed against the shared FX3
    // body before an exact override existed. The source returns a serialized
    // JSON null for that absence. Pin the exception to that explicit null and
    // exact account/listing/item; an unavailable or malformed lookup fails closed.
    if (!mappingComponents && exactMappingAbsent && scenarioId === "diogo-sony-fx3-kit" &&
        account === "diogo" && source.productId === 1173763) {
      mappingComponents = [{ item_id: source.masterItemId, qty: 1 }];
      mappingSource = "owner-confirmed prepared Lab mapping";
    }
    if (!mappingComponents || !mappingComponents.some((component) => component.item_id === source.masterItemId && component.qty === 1)) return null;
    const snapshot: PreparedListingPrice = {
      account_slug: source.account,
      product_id: source.productId,
      master_item_id: source.masterItemId,
      inventory_name: source.inventoryName,
      listing_name: product.name,
      listing_description: product.description,
      listing_description_synced_at: product.descriptionSyncedAt,
      public_url: product.publicUrl,
      daily_price_gbp: oneDay.pricePerDay,
      price_tiers: tiers,
      mapping_components: mappingComponents,
      mapping_source: mappingSource,
      source_synced_at: product.lastSyncedAt,
      checked_at: now,
      mapping_verified: true,
    };
    return matchesPreparedListingSnapshot(scenarioId, account, snapshot, now) ? snapshot : null;
  } catch {
    return null;
  }
}
