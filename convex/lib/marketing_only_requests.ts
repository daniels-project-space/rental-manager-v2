import { normalizeItemName } from "./item_matcher";
import { buildProductIndexMap, buildOverrideMap, reservationItemUnits, type ResolvableRes } from "./reservations/itemUnits";
import { resolveBundleMapping, declaredRentalBlockers } from "./bundle_mapping";

type Request = ResolvableRes & {
  hygglo_order_id?: string;
  items?: Array<{ item_name?: string }>;
};
type InventoryItem = { _id: string; name_canonical?: string; is_marketing_only?: boolean; kind?: string; qty?: number; status?: string; aliases?: string[]; lens_mount?: string | null };

export function declaredMarketingListingKeys(listings: Array<{account_slug: string; product_id: number; description?: string}>, items: InventoryItem[]) {
  const inventory = items.filter((i): i is InventoryItem & {name_canonical:string} => !!i.name_canonical);
  return new Set(listings.filter(l => declaredRentalBlockers(resolveBundleMapping(l.description ?? "", inventory), inventory)
    .some(blocker => blocker.reason === "marketing_only")).map(l => `${l.account_slug}#${l.product_id}`));
}

/** Only explicit internal inventory labels exclude demand; unknown items stay. */
export function marketingOnlyRequestIds(
  reservations: Request[], items: InventoryItem[], productIndex: Map<string, string>,
  overrides?: ReturnType<typeof buildOverrideMap>,
  declaredMarketingListings: Set<string> = new Set(),
): Set<string> {
  const marketingIds = new Set(items.filter((i) => i.is_marketing_only).map((i) => String(i._id)));
  const names = items.filter((i) => i.name_canonical).map((i) => ({
    id: String(i._id), name: normalizeItemName(i.name_canonical!),
  })).sort((a, b) => b.name.length - a.name.length);
  const excluded = new Set<string>();
  for (const r of reservations) {
    if (!r.hygglo_order_id) continue;
    const units = reservationItemUnits(r, productIndex, overrides);
    let marketing = [...units.keys()].some((id) => marketingIds.has(id)) ||
      (r.hygglo_items ?? []).some(i => i.product_id !== undefined && declaredMarketingListings.has(`${r.account_slug ?? ""}#${i.product_id}`));
    const allOverridden = (r.hygglo_items?.length ?? 0) > 0 &&
      (r.hygglo_items ?? []).every((i) => i.product_id !== undefined && overrides?.has(`${r.account_slug ?? ""}#${i.product_id}`));
    if (!marketing && !allOverridden) {
      // Imported orders sometimes have names but no item IDs. Use exact
      // normalised model names; do not fuzzy-match unknown demand away.
      const rawNames = [...(r.items ?? []).map((i) => i.item_name),
        ...(r.hygglo_items ?? []).filter((i) => i.product_id === undefined ||
          (!productIndex.has(`${r.account_slug ?? ""}#${i.product_id}`) && !overrides?.has(`${r.account_slug ?? ""}#${i.product_id}`)))
          .map((i) => i.name)];
      marketing = rawNames.some((name) => {
        const text = ` ${normalizeItemName(name ?? "")} `;
        const match = names.find((i) => text.includes(` ${i.name} `));
        return match !== undefined && marketingIds.has(match.id);
      });
    }
    // Any unavailable marketing-only component makes a requested kit impossible.
    if (marketing) excluded.add(`${r.account_slug ?? ""}#${r.hygglo_order_id}`);
  }
  return excluded;
}
