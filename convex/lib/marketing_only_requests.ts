import type { QueryCtx } from "../_generated/server";
import { normalizeItemName } from "./item_matcher";
import { buildProductIndexMap, buildOverrideMap, reservationItemUnits, type ResolvableRes } from "./reservations/itemUnits";

type Request = ResolvableRes & {
  hygglo_order_id?: string;
  items?: Array<{ item_name?: string }>;
};
type InventoryItem = { _id: string; name_canonical?: string; is_marketing_only?: boolean };

/** Only explicit internal inventory labels exclude demand; unknown items stay. */
export function marketingOnlyRequestIds(
  reservations: Request[], items: InventoryItem[], productIndex: Map<string, string>,
  overrides?: ReturnType<typeof buildOverrideMap>,
): Set<string> {
  const marketingIds = new Set(items.filter((i) => i.is_marketing_only).map((i) => String(i._id)));
  const names = items.filter((i) => i.name_canonical).map((i) => ({
    id: String(i._id), name: normalizeItemName(i.name_canonical!),
  })).sort((a, b) => b.name.length - a.name.length);
  const excluded = new Set<string>();
  for (const r of reservations) {
    if (!r.hygglo_order_id) continue;
    const units = reservationItemUnits(r, productIndex, overrides);
    let marketing = [...units.keys()].some((id) => marketingIds.has(id));
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

export async function loadMarketingOnlyRequestIds(ctx: QueryCtx, reservations: Request[]) {
  const [items, productRows, overrideRows] = await Promise.all([
    ctx.db.query("items").collect(),
    ctx.db.query("hygglo_product_index").collect(),
    ctx.db.query("listing_resolution_override").collect(),
  ]);
  return marketingOnlyRequestIds(reservations, items, buildProductIndexMap(productRows), buildOverrideMap(overrideRows));
}
