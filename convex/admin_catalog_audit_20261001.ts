import { internalQuery } from "./_generated/server";
import { isStandardAccessory } from "./lib/reservations/itemUnits";

export const run = internalQuery({ args: {}, handler: async ctx => {
  const [items, mappings, indexes] = await Promise.all([ctx.db.query("items").collect(), ctx.db.query("listing_resolution_override").collect(), ctx.db.query("hygglo_product_index").collect()]);
  const byId = new Map(items.map(i => [String(i._id), i]));
  const byProduct = new Map(indexes.map(i => [`${i.account_slug}#${i.product_id}`, i]));
  const incorrectPrimary = [], invalidMappings = [];
  for (const m of mappings) {
    if (m.components.some(c => !byId.has(String(c.item_id)) || !Number.isInteger(c.qty) || c.qty < 1)) { invalidMappings.push({ account: m.account_slug, product_id: m.product_id }); continue; }
    const independent = [...new Set(m.components.filter(c => { const i = byId.get(String(c.item_id))!; return !isStandardAccessory(i.kind, i.name_canonical); }).map(c => String(c.item_id)))];
    const cameras = independent.filter(id => byId.get(id)?.kind === "camera");
    const primary = cameras.length === 1 ? cameras[0] : independent.length === 1 ? independent[0] : null;
    const index = byProduct.get(`${m.account_slug}#${m.product_id}`);
    if (primary && index && String(index.item_id) !== primary) incorrectPrimary.push({ account: m.account_slug, product_id: m.product_id, indexed: byId.get(String(index.item_id))?.name_canonical ?? String(index.item_id), mapped: byId.get(primary)!.name_canonical });
  }
  return { items: items.length, mappings: mappings.length, indexes: indexes.length, incorrectPrimary, invalidMappings };
} });
