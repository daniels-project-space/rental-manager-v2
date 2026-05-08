// Extract v1 inventory data files into a single JSON blob for Convex seeding.
// Run with: node --experimental-strip-types scripts/extract-v1-data.mjs
// Outputs: /tmp/v1-extract.json
import { writeFileSync } from 'node:fs';

const V1 = '/home/ubuntu/rental-manager/src';

const itemSpecsMod = await import(`${V1}/data/item-specs.ts`);
const itemCompMod = await import(`${V1}/data/item-compatibility.ts`);
const bundleMod = await import(`${V1}/data/bundle-suggestions.ts`);
const marketingMod = await import(`${V1}/data/marketing-redirects.ts`);
const pricingMod = await import(`${V1}/data/pricing-catalog.ts`);
const replacementMod = await import(`${V1}/data/replacement-costs.ts`);
const acquisitionMod = await import(`${V1}/data/acquisition-costs.ts`);
const deliveryMod = await import(`${V1}/data/delivery-specs.ts`);
const photoMod = await import(`${V1}/data/listing-photo-reference.ts`);
const matcherMod = await import(`${V1}/utils/item-matcher.ts`);

const payload = {
  itemSpecs: { name: 'ITEM_SPECS', value: itemSpecsMod.ITEM_SPECS },
  itemCompatibility: { name: 'ITEM_COMPATIBILITY', value: itemCompMod.ITEM_COMPATIBILITY },
  bundles: { name: 'BUNDLE_DEFINITIONS', value: bundleMod.BUNDLE_DEFINITIONS },
  marketingRedirects: { name: 'MARKETING_REDIRECTS', value: marketingMod.MARKETING_REDIRECTS },
  pricing: { name: 'PRICING_CATALOG', value: pricingMod.PRICING_CATALOG },
  replacementCosts: { name: 'REPLACEMENT_COSTS', value: replacementMod.REPLACEMENT_COSTS },
  cameraKitTotals: { name: 'CAMERA_KIT_TOTALS', value: replacementMod.CAMERA_KIT_TOTALS },
  acquisition: { name: 'ACQUISITION_COSTS', value: acquisitionMod.ACQUISITION_COSTS },
  ownedItemCosts: { name: 'OWNED_ITEM_COSTS', value: acquisitionMod.OWNED_ITEM_COSTS ?? null },
  delivery: { name: 'DELIVERY_SPECS', value: deliveryMod.DELIVERY_SPECS },
  listingPhotos: { name: 'LISTING_PHOTO_REFERENCE', value: photoMod.LISTING_PHOTO_REFERENCE },
  masterInventory: matcherMod.MASTER_INVENTORY ?? null,
  canonicalMap: matcherMod.CANONICAL_MAP ?? null,
  brandFamilies: matcherMod.BRAND_FAMILIES ?? null,
  modKeys: {
    itemSpecs: Object.keys(itemSpecsMod),
    itemComp: Object.keys(itemCompMod),
    bundles: Object.keys(bundleMod),
    marketing: Object.keys(marketingMod),
    pricing: Object.keys(pricingMod),
    replacement: Object.keys(replacementMod),
    acquisition: Object.keys(acquisitionMod),
    delivery: Object.keys(deliveryMod),
    photo: Object.keys(photoMod),
    matcher: Object.keys(matcherMod),
  },
};

writeFileSync('/tmp/v1-extract.json', JSON.stringify(payload, null, 2));
console.log('OK wrote /tmp/v1-extract.json');
function len(v) {
  if (!v) return null;
  if (Array.isArray(v.value)) return v.value.length;
  if (v.value && typeof v.value === 'object') return Object.keys(v.value).length;
  return null;
}
console.log('Counts:', {
  itemSpecs: len(payload.itemSpecs),
  itemCompatibility: len(payload.itemCompatibility),
  bundles: len(payload.bundles),
  marketingRedirects: len(payload.marketingRedirects),
  pricing: len(payload.pricing),
  replacementCosts: len(payload.replacementCosts),
  acquisition: len(payload.acquisition),
  delivery: len(payload.delivery),
  listingPhotos: len(payload.listingPhotos),
  masterInventory: payload.masterInventory && Object.keys(payload.masterInventory).length,
});
