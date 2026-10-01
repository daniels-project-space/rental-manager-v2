type Item = { _id: unknown; name_canonical: string; kind?: string; compatibility?: { included_with_rental?: string[] } };
type Mapping = { components: Array<{ item_id: unknown; qty: number }> };

/** Known contents per listing. A stock mapping is not an exhaustive kit.
 * Accessory descriptions may overlap components or describe sets: do not add
 * them into individual-unit totals. */
export function recordedKit(components: Array<{ name: string | null; qty: number }>, accessories: string[]) {
  const mapped = components.filter(c => c.name && Number.isInteger(c.qty) && c.qty > 0)
    .map(c => `${c.qty} × ${c.name}`);
  const recorded = accessories.filter(c => typeof c === "string" && c.trim()).map(c => c.trim());
  const contents = [...new Set([...mapped, ...recorded])];
  return { contents, included: contents.length ? contents.join(", ") : null,
    completeness: contents.length ? "partial" as const : "unknown" as const,
    source: mapped.length ? "physical_mapping_and_inventory" : recorded.length ? "inventory_record" : "unknown" };
}

/** Advertising title/description never proves inclusions. Use the same body
 * records and physical mapping as selected-listing context. */
export function recommendationKit(item: Item, mapping: Mapping | undefined, inventory: Item[]) {
  const components = mapping?.components.map(c => ({ item: inventory.find(i => String(i._id) === String(c.item_id)), qty: c.qty }));
  const complete = !!components?.length && components.every(c => !!c.item && Number.isInteger(c.qty) && c.qty > 0);
  const recorded = item.compatibility?.included_with_rental ?? [];
  const kit = recordedKit(complete ? components!.map(c => ({ qty: c.qty, name: c.item!.name_canonical })) : [], recorded);
  const contents = kit.contents;
  return { contents, included: contents.length ? contents.join(", ") : null,
    includes_lens: item.kind === "camera" && complete ? components!.some(c => c.item?.kind === "lens") : null,
    kit_completeness: kit.completeness, mapping_complete: complete, source: complete ? "physical_mapping_and_inventory" : recorded.length ? "inventory_record" : "unknown" };
}
