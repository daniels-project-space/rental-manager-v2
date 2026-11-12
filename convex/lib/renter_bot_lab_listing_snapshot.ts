import { renterBotLabScenario } from "./renter_bot_lab_scenarios";
/** Read-only listing-price snapshots for the isolated Lab's prepared examples. */
const SOURCE = "https://hearty-oyster-600.convex.cloud/api/query";
const MAX_SYNC_AGE_MS = 48 * 60 * 60 * 1000;
const SOURCES: Record<string, { account: string; productId: number; masterItemId: string }> = {
  "bmpcc-6k-full-frame-kit": { account: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf" },
  "verification-failed": { account: "dbcinema", productId: 1103089, masterItemId: "kn740n15w16172sn1qj8h89gx586b2xf" },
  "sony-fx3-batteries": { account: "leo", productId: 1097510, masterItemId: "kn7bw2cr1ye5hqj3x770b332ks86atzw" },
};

/** Prepared source IDs are usable only with the matching server-owned item. */
export function matchesPreparedListing(account: string, productId: number, itemName: string): boolean {
  return Object.entries(SOURCES).some(([scenarioId, source]) => source.account === account &&
    source.productId === productId && renterBotLabScenario(scenarioId)?.item.name_canonical === itemName);
}

export type PreparedListingPrice = {
  product_id: number;
  daily_price_gbp: number;
  price_tiers: Array<{ days: number; pricePerDay: number }>;
  source_synced_at: number;
  checked_at: number;
  mapping_verified?: boolean;
};

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
        product.lastSyncedAt > now + 300000 || now - product.lastSyncedAt > MAX_SYNC_AGE_MS || !Array.isArray(product.prices)) return null;
    const tiers = (product.prices as unknown[]).flatMap((tier) => {
      if (!tier || typeof tier !== "object" || !("days" in tier) || !("pricePerDay" in tier) ||
          typeof tier.days !== "number" || !Number.isInteger(tier.days) || tier.days < 1 || tier.days > 366 ||
          typeof tier.pricePerDay !== "number" || !Number.isFinite(tier.pricePerDay) || tier.pricePerDay <= 0) return [];
      return [{ days: tier.days, pricePerDay: tier.pricePerDay }];
    });
    if (new Set(tiers.map((tier) => tier.days)).size !== tiers.length) return null;
    const oneDay = tiers.find((tier) => tier.days === 1);
    if (!oneDay) return null;
    let mappingVerified = false;
    if (source.account === "dbcinema" && source.productId === 1103089) {
      try {
        const mappingResponse = await fetcher(SOURCE, { method:"POST", headers:{"Content-Type":"application/json"},
          body:JSON.stringify({path:"listing_overrides:getRevision",args:{account_slug:account,product_id:source.productId},format:"json"}),
          signal:AbortSignal.timeout(5000) });
        const result = await mappingResponse.json() as {status?:string;value?:{available?:boolean;revision?:string}};
        const mapping = result.value?.revision ? JSON.parse(result.value.revision) : null;
        mappingVerified = mappingResponse.ok && result.status === "success" && result.value?.available === true &&
          mapping?.account_slug === account && mapping?.product_id === source.productId &&
          Array.isArray(mapping?.components) && mapping.components.length === 1 &&
          mapping.components[0]?.item_id === source.masterItemId && mapping.components[0]?.qty === 1;
      } catch { /* A price is not proof of a current physical mapping. */ }
    }
    return { product_id: source.productId, daily_price_gbp: oneDay.pricePerDay, price_tiers: tiers,
      source_synced_at: product.lastSyncedAt, checked_at: now, mapping_verified: mappingVerified };
  } catch {
    return null;
  }
}
