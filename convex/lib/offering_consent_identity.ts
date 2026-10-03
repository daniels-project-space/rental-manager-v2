import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadListingInventory } from "./listing_inventory";
import { renterItemNames } from "./renter_item_names";
import { isStandardAccessory } from "./reservations/itemUnits";

/** Native components establish identity; advertising comparison models never
 * become aliases. Every alias of a bundle retains all its principal items. */
export async function offeringConsentIdentity(ctx: QueryCtx, account: string, line: {
  product_id?: number; item_id?: unknown; name: string;
}, inventory: Doc<"items">[]) {
  const mapping=line.product_id!=null ? await loadListingInventory(ctx,account,line.product_id,1,{items:inventory}) : null;
  const mapped=mapping?.complete ? mapping.components.map(c=>({item:inventory.find(i=>String(i._id)===c.item_id),qty:c.units_per_listing})) : [];
  let core=mapped.filter(c=>c.item && !isStandardAccessory(c.item.kind,c.item.name_canonical));
  if(!core.length && mapped.length===1 && mapped[0].item)core=mapped;
  if(!core.length){const item=inventory.find(i=>String(i._id)===String(line.item_id));if(item)core=[{item,qty:1}];}
  if(!core.length || core.some(c=>!c.item))return null;
  const groups=core.map(c=>[...new Set([...renterItemNames(c.item!.name_canonical),...(c.item!.aliases??[])])]
    .map(name=>`${c.qty>1?`${c.qty}x `:""}${name}`));
  let aliases=[""];
  for(const group of groups)aliases=aliases.flatMap(prefix=>group.map(name=>prefix?`${prefix} + ${name}`:name)).slice(0,64);
  const cameras=core.filter(c=>["camera","camera_body"].includes(c.item!.kind??"") && c.qty===1);
  const primary_removal_aliases=core.length>1 && cameras.length===1 ? renterItemNames(cameras[0].item!.name_canonical) : [];
  if(primary_removal_aliases.length)aliases.push(...primary_removal_aliases.map(name=>`${name} kit`));
  const name=core.map(c=>`${c.qty>1?`${c.qty}x `:""}${c.item!.name_canonical}`).join(" + ");
  return {identity_name:name,aliases,primary_removal_aliases};
}
