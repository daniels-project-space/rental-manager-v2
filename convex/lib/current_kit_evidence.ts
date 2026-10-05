import type {QueryCtx} from "../_generated/server";
import {loadListingInventory} from "./listing_inventory";
import {listingKitContext,listingKitItem} from "./listing_kit_context";
import {resolveStockItem} from "./renter_stock";
import {renterItemNames} from "./renter_item_names";
import type {KitEvidence} from "./kit_claims";

type Line={name:string;product_id?:number|null;booked?:boolean};
/** Rebuild supplied contents from current Native records. Old draft receipts
 * and advertising titles cannot attest an inclusion at approval time. */
export async function currentKitEvidence(ctx:QueryCtx,account:string,text:string,lines:Line[]) {
 const inventory=await ctx.db.query("items").collect();
 const evidence:KitEvidence[]=[],covered=new Set<string>(),seen=new Set<string>();
 const normal=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
 const mentions=(name:string)=>renterItemNames(name).some(alias=>alias&&` ${normal(text)} `.includes(` ${normal(alias)} `));
 for(const line of lines){
  const key=line.product_id!=null?`listing:${line.product_id}`:`name:${normal(line.name)}`;
  if(seen.has(key))continue;seen.add(key);
  const physical=line.product_id!=null?await loadListingInventory(ctx,account,line.product_id,1,{items:inventory}):null;
  const resolved=!physical?resolveStockItem(line.name,inventory):null;
  const item=physical?listingKitItem(physical,inventory):resolved?.confident?resolved.match??undefined:undefined;
  if(item)covered.add(String(item._id));
  const eligible=item?.status==="active"&&!item.is_marketing_only&&item.qty>0&&physical?.owned!==false;
  const components=physical?.components??(item?[{name:item.name_canonical,units_per_listing:1}]:[]);
  const contents=eligible?(await listingKitContext(ctx,account,item,components,inventory)).kit.contents:[];
  evidence.push({names:[...new Set([line.name,physical?.listing_name,item?.name_canonical].filter((n):n is string=>!!n).flatMap(renterItemNames))],contents,booked_item:line.booked,kind:item?.kind});
 }
 // Named equipment outside the selected basket can establish only its own
 // inventory contents, never the contents of a different listing for it.
 for(const item of inventory){
  if(covered.has(String(item._id))||!mentions(item.name_canonical))continue;
  const contents=item.status==="active"&&!item.is_marketing_only&&item.qty>0
   ?(await listingKitContext(ctx,account,item,[],inventory)).kit.contents:[];
  evidence.push({names:renterItemNames(item.name_canonical),contents,kind:item.kind});
 }
 // Keep the shared claim validator active even when nothing resolves.
 return evidence.length?evidence:[{names:[],contents:[]}];
}
