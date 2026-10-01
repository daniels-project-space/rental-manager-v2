import { isStandardAccessory } from "./reservations/itemUnits";

type Inventory = { _id: unknown; kind?: string; name_canonical: string };
type Mapping = { account_slug: string; product_id: number; components: Array<{ item_id: unknown; qty: number }> };

/** A base camera listing can include its cards/batteries, but not another
 * independently rented item or two bodies. A manual mapping wins over index. */
export function baseListingProductIds(account: string, itemId: string,
  index: Array<{ account_slug: string; product_id: number; item_id: unknown }>,
  overrides: Mapping[], inventory: Inventory[]): number[] {
  const items = new Map(inventory.map((i) => [String(i._id), i]));
  const mappings = new Map(overrides.filter((o) => o.account_slug === account).map((o) => [o.product_id, o]));
  const qualifies = (o: Mapping) => o.components.some((c) => String(c.item_id) === itemId && c.qty === 1) &&
    o.components.every((c) => {
      if (String(c.item_id) === itemId) return c.qty === 1;
      const item = items.get(String(c.item_id));
      return !!item && isStandardAccessory(item.kind, item.name_canonical);
    });
  const pids = new Set<number>();
  for (const row of index) {
    if (row.account_slug !== account || String(row.item_id) !== itemId) continue;
    const mapped = mappings.get(row.product_id);
    if (!mapped || qualifies(mapped)) pids.add(row.product_id);
  }
  for (const o of mappings.values()) if (qualifies(o)) pids.add(o.product_id);
  return [...pids];
}
