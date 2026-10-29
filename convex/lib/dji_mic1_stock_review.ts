import type { Doc, Id } from "../_generated/dataModel";

export const DJI_MIC1_OFFERS = [["dbcinema", 852812]] as const;
export const DJI_MIC1_REVIEW_SOURCE = "owner-confirmed DJI Mic 1 identity — 2026-10-28";
const STALE_PRODUCT_MASTER_NAMES = ["Audio boom mic Sennheiser", "Rode Video Mic Go"] as const;
const DJI_MIC1_LEGACY_MASTER_PARTS = ["2x transmitter", "1x receiver", "1x charging case"] as const;
const DJI_MIC1_MASTER_PARTS = [
  "2x transmitter",
  "1x receiver",
  "1x audio cable",
  "1x charging case",
  "1x carrying case",
  "2x lavalier microphones",
] as const;
const DJI_MIC1_LEGACY_SUPPLIED_PARTS = [
  { name: "DJI Mic transmitters", qty: 2 },
  { name: "DJI Mic receiver", qty: 1 },
  { name: "DJI Mic charging case", qty: 1 },
  { name: "Lavalier microphones", qty: 2 },
] as const;
const DJI_MIC1_LEGACY_DESCRIPTION_OVERRIDE = "Contents: • 2x transmitters • 1x receiver • 1x charging case • 2x lavalier microphones";
// Exact rule observed on the reviewed live listing. The seller's synced
// description below independently verifies each of these six base contents.
const DJI_MIC1_OBSERVED_SUPPLIED_PARTS = [
  { name: "DJI Mic transmitters", qty: 2 },
  { name: "DJI Mic receiver", qty: 1 },
  { name: "DJI audio cable", qty: 1 },
  { name: "DJI Mic charging case", qty: 1 },
  { name: "DJI Mic carrying case", qty: 1 },
  { name: "DJI Lavalier microphones", qty: 2 },
] as const;
const DJI_MIC1_OBSERVED_DESCRIPTION_OVERRIDE = "Contents: • 1x DJI Wireless Mics";
const DJI_MIC1_DESCRIPTION_OVERRIDE = "Contents: • 2x transmitters • 1x receiver • 1x audio cable • 1x charging case • 1x carrying case • 2x lavalier microphones";
const DJI_MIC1_SUPPLIED_PARTS = [
  { name: "DJI Mic transmitters", qty: 2 },
  { name: "DJI Mic receiver", qty: 1 },
  { name: "Audio cable", qty: 1 },
  { name: "DJI Mic charging case", qty: 1 },
  { name: "DJI Mic carrying case", qty: 1 },
  { name: "Lavalier microphones", qty: 2 },
] as const;

function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function djiMic1StockReview(items: Doc<"items">[], products: Doc<"hygglo_products">[], overrides: Doc<"listing_resolution_override">[]) {
  const masters = items.filter(item => item.name_canonical === "DJI Wireless Mics");
  if (masters.length !== 1 || masters[0].status !== "active" || masters[0].is_marketing_only !== false ||
      !Number.isSafeInteger(masters[0].qty) || masters[0].qty !== 1 || masters[0].unit_kind !== "set")
    throw Error("Owner-confirmed DJI Mic 1 master identity or quantity needs review");
  const master = masters[0];
  const parts = master.compatibility?.included_with_rental ?? [];
  const allowedMasterParts = new Set([...DJI_MIC1_LEGACY_MASTER_PARTS, ...DJI_MIC1_MASTER_PARTS]);
  if (!DJI_MIC1_LEGACY_MASTER_PARTS.every(part => parts.includes(part)) || parts.some(part => !allowedMasterParts.has(part as typeof DJI_MIC1_MASTER_PARTS[number])))
    throw Error("Owner-confirmed DJI Mic 1 master contents changed");
  const secondGen = items.filter(item => item.name_canonical === "DJI Mic 2 wireless");
  if (secondGen.length !== 1 || secondGen[0]._id === master._id) throw Error("DJI Mic generations are not separate in master inventory");
  const staleMasters = STALE_PRODUCT_MASTER_NAMES.flatMap(name => {
    const matches = items.filter(item => item.name_canonical === name);
    if (matches.length > 1) throw Error("A stale DJI Mic offer master is ambiguous; review the listing before repair");
    return matches;
  });
  if (!staleMasters.length) throw Error("No reviewed stale DJI Mic offer master remains; review the listing before repair");
  const staleMasterIds = new Set(staleMasters.map(item => item._id));

  const aliases = [...new Set([...(master.aliases ?? []), "DJI Mic 1", "DJI Mic One", "DJI Mic 1st generation", "original DJI Mic"])].sort();
  const ruleChanges: NonNullable<Doc<"items">["listing_stock_rules"]> = [];
  const productChanges: Array<{ id: Doc<"hygglo_products">["_id"]; patch: Partial<Doc<"hygglo_products">> }> = [];
  const mappingChanges: Array<{ id: Doc<"listing_resolution_override">["_id"]; patch: Partial<Doc<"listing_resolution_override">> }> = [];
  const inserts: Array<{ account_slug: string; product_id: number; components: { item_id: Id<"items">; qty: number }[] }> = [];

  for (const [account, id] of DJI_MIC1_OFFERS) {
    const matches = products.filter(product => product.accountSlug === account && product.productId === id);
    if (matches.length !== 1) throw Error(`Reviewed DJI Mic 1 offer missing or duplicated: ${account}#${id}`);
    const product = matches[0], title = product.name ?? "";
    if (!/\bdji\s+mic\s+wireless\b/i.test(title) || /\bdji\s+mic\s*2\b/i.test(title) || product.isMarketingOnlyOverride === true)
      throw Error(`Reviewed DJI Mic 1 offer identity or owner exclusion needs review: ${account}#${id}`);
    const description = (product.description ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").toLowerCase().replace(/\s+/g, " ");
    const sellerListedContents = [
      /\b2\s*x\s+dji\s+mic\s+transmitters?\b/,
      /\b1\s*x\s+dji\s+mic\s+rec(?:eiver|iever)\b/,
      /\b1\s*x\s+audio\s+cable\b/,
      /\b1\s*x\s+charging\s+case\b/,
      /\b1\s*x\s+carrying\s+case\b/,
      /\b2\s*x\s+lavelier\s+lapel\s+microphones?\b/,
    ];
    if (!Number.isSafeInteger(product.descriptionSyncedAt) || !description || sellerListedContents.some(pattern => !pattern.test(description)))
      throw Error(`Reviewed DJI Mic 1 seller-listed base contents changed or are not verified: ${account}#${id}`);
    if (product.masterItemId && product.masterItemId !== master._id && !staleMasterIds.has(product.masterItemId))
      throw Error(`Reviewed DJI Mic 1 offer master changed: ${account}#${id}`);

    const existing = overrides.filter(row => row.account_slug === account && row.product_id === id);
    if (existing.length > 1) throw Error(`Duplicate reviewed DJI Mic 1 mappings: ${account}#${id}`);
    if (existing.length === 1) {
      const row = existing[0];
      const mapped = row.components.length === 1 && row.components[0].qty === 1 && row.components[0].item_id === master._id;
      const expectedStale = row.source === "manual_audit" && row.components.length === 1 && row.components[0].qty === 1 && row.components[0].item_id === secondGen[0]._id;
      if (!mapped && !expectedStale) throw Error(`Reviewed DJI Mic 1 stock allocation changed: ${account}#${id}`);
      if (expectedStale) mappingChanges.push({ id: row._id, patch: { components: [{ item_id: master._id, qty: 1 }], source: "manual_audit", note: DJI_MIC1_REVIEW_SOURCE, updated_at: Date.now() } });
    } else {
      inserts.push({ account_slug: account, product_id: id, components: [{ item_id: master._id, qty: 1 }] });
    }

    const pattern = `^${escape(title)}$`;
    if (pattern.length > 200) throw Error("Reviewed DJI Mic 1 title exceeds the stock rule limit");
    const ownerRules = (master.listing_stock_rules ?? []).filter(rule => rule.source === DJI_MIC1_REVIEW_SOURCE);
    if (ownerRules.length > 1) throw Error("The reviewed DJI Mic 1 packing rule is ambiguous");
    const currentRule = ownerRules[0];
    const finalRule = {
      title_pattern: pattern,
      source: DJI_MIC1_REVIEW_SOURCE,
      components: [{ item_id: master._id, qty: 1 }],
      excludes: [],
      ...(currentRule?.apply_to_declared_component !== undefined ? { apply_to_declared_component: currentRule.apply_to_declared_component } : {}),
      ...(currentRule?.optional_parts !== undefined ? { optional_parts: currentRule.optional_parts } : {}),
      ...(currentRule?.stock_review_required !== undefined ? { stock_review_required: currentRule.stock_review_required } : {}),
      supplied_parts: [...DJI_MIC1_SUPPLIED_PARTS],
      description_override: DJI_MIC1_DESCRIPTION_OVERRIDE,
      packing_review_required: false,
    };
    const currentIsFinal = currentRule !== undefined && stable({
      title_pattern: currentRule.title_pattern,
      source: currentRule.source,
      components: currentRule.components.map(component => ({ item_id: String(component.item_id), qty: component.qty })),
      excludes: currentRule.excludes.map(String),
      supplied_parts: currentRule.supplied_parts ?? [],
      optional_parts: currentRule.optional_parts ?? [],
      apply_to_declared_component: currentRule.apply_to_declared_component ?? false,
      description_override: currentRule.description_override ?? null,
      packing_review_required: currentRule.packing_review_required ?? false,
      stock_review_required: currentRule.stock_review_required ?? false,
    }) === stable({
      ...finalRule,
      components: finalRule.components.map(component => ({ item_id: String(component.item_id), qty: component.qty })),
      description_override: DJI_MIC1_DESCRIPTION_OVERRIDE,
      stock_review_required: false,
      optional_parts: finalRule.optional_parts ?? [],
      apply_to_declared_component: finalRule.apply_to_declared_component ?? false,
    });
    const isPriorReviewRule = currentRule !== undefined && currentRule.title_pattern === pattern &&
      currentRule.components.length === 1 && String(currentRule.components[0].item_id) === String(master._id) &&
      currentRule.components[0].qty === 1 && currentRule.excludes.length === 0 &&
      currentRule.packing_review_required === true && currentRule.stock_review_required === undefined &&
      currentRule.supplied_parts === undefined && currentRule.optional_parts === undefined &&
      currentRule.description_override === undefined && currentRule.apply_to_declared_component === undefined;
    const isPriorContentsRule = currentRule !== undefined && currentRule.title_pattern === pattern &&
      currentRule.components.length === 1 && String(currentRule.components[0].item_id) === String(master._id) &&
      currentRule.components[0].qty === 1 && currentRule.excludes.length === 0 &&
      currentRule.packing_review_required === false && currentRule.stock_review_required === undefined &&
      stable(currentRule.supplied_parts ?? []) === stable(DJI_MIC1_LEGACY_SUPPLIED_PARTS) &&
      currentRule.description_override === DJI_MIC1_LEGACY_DESCRIPTION_OVERRIDE &&
      currentRule.optional_parts === undefined && currentRule.apply_to_declared_component === undefined;
    const isObservedContentsRule = currentRule !== undefined && currentRule.title_pattern === pattern &&
      currentRule.components.length === 1 && String(currentRule.components[0].item_id) === String(master._id) &&
      currentRule.components[0].qty === 1 && currentRule.excludes.length === 0 &&
      currentRule.packing_review_required !== true && currentRule.stock_review_required !== true &&
      (currentRule.optional_parts ?? []).length === 0 &&
      stable(currentRule.supplied_parts ?? []) === stable(DJI_MIC1_OBSERVED_SUPPLIED_PARTS) &&
      currentRule.description_override === DJI_MIC1_OBSERVED_DESCRIPTION_OVERRIDE;
    if (currentRule && !currentIsFinal && !isPriorReviewRule && !isPriorContentsRule && !isObservedContentsRule)
      throw Error("The reviewed DJI Mic 1 packing rule changed; review the listing before repair");
    if (!currentIsFinal) ruleChanges.push(finalRule);
    const patch: Partial<Doc<"hygglo_products">> = {};
    if (product.masterItemId !== master._id || product.stockIdentityOverride?.itemId !== master._id || product.stockIdentityOverride?.title !== title)
      Object.assign(patch, { masterItemId: master._id, stockIdentityOverride: { itemId: master._id, title, source: DJI_MIC1_REVIEW_SOURCE } });
    // This is an owner-reviewed physical kit. If the importer's automatic
    // marketing heuristic hid it, persist a manual rentable classification;
    // upsertProductsBatch preserves this override on future catalogue syncs.
    if (product.isMarketingOnly && product.isMarketingOnlyOverride === undefined)
      Object.assign(patch, { isMarketingOnly: false, isMarketingOnlyOverride: false, marketingOnlyUpdatedAt: Date.now() });
    if (Object.keys(patch).length) productChanges.push({ id: product._id, patch });
  }

  const listing_stock_rules = ruleChanges.length
    ? [...(master.listing_stock_rules ?? []).filter(rule => rule.source !== DJI_MIC1_REVIEW_SOURCE), ...ruleChanges]
    : master.listing_stock_rules ?? [];
  const itemPatch: Partial<Doc<"items">> = {};
  if (stable(master.aliases ?? []) !== stable(aliases)) itemPatch.aliases = aliases;
  if (stable(master.listing_stock_rules ?? []) !== stable(listing_stock_rules)) itemPatch.listing_stock_rules = listing_stock_rules;
  const compatibility = master.compatibility ?? {};
  const reviewedCompatibility = { ...compatibility, included_with_rental: [...DJI_MIC1_MASTER_PARTS] };
  if (stable(compatibility) !== stable(reviewedCompatibility)) itemPatch.compatibility = reviewedCompatibility;
  const itemChanges = Object.keys(itemPatch).length ? [{ id: master._id, patch: itemPatch }] : [];
  return { items: itemChanges, products: productChanges, mappingChanges, inserts };
}
