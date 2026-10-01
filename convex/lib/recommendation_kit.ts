type Item = { _id: unknown; name_canonical: string; kind?: string; compatibility?: { included_with_rental?: string[] } };
type Mapping = { components: Array<{ item_id: unknown; qty: number }> };

/** Advertising title/description never proves inclusions. Use the same body
 * records and physical mapping as selected-listing context. */
export function recommendationKit(item: Item, mapping: Mapping | undefined, inventory: Item[]) {
  const components = mapping?.components.map(c => ({ item: inventory.find(i => String(i._id) === String(c.item_id)), qty: c.qty }));
  const complete = !!components?.length && components.every(c => !!c.item && Number.isInteger(c.qty) && c.qty > 0);
  const recorded = item.compatibility?.included_with_rental ?? [];
  const contents = [...new Set([...(complete ? components!.map(c => `${c.qty} × ${c.item!.name_canonical}`) : []), ...recorded])];
  return { contents, included: contents.length ? contents.join(", ") : null,
    includes_lens: item.kind === "camera" && complete ? components!.some(c => c.item?.kind === "lens") : null,
    mapping_complete: complete, source: complete ? "physical_mapping_and_inventory" : recorded.length ? "inventory_record" : "unknown" };
}
