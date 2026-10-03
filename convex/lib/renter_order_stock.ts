import type { QueryCtx } from "../_generated/server";
import { loadListingInventory } from "./listing_inventory";
import { loadStockSources, stockForItem } from "./renter_stock";
import { withDefaultAdapters } from "./default_adapter_units";
import type { Doc } from "../_generated/dataModel";

type Line = { name: string; qty: number; item_id?: string; product_id?: number };
export type OrderPhysicalItem = { item_id:string; name:string; quantity:number };
/** One identity resolver for basket stock and preserved referral equipment.
 * Display names and listing prices do not identify the physical contents. */
export async function resolveOrderPhysicalItems(ctx:QueryCtx,account:string,lines:Line[],items?:Doc<"items">[]) {
  const inventory=items??await ctx.db.query("items").collect();
  const required=new Map<string,number>();
  for(const line of lines) {
    if(!Number.isInteger(line.qty)||line.qty<1||line.qty>20)return {items:[],available:null,reason:"invalid_quantity"} as const;
    if(line.product_id!=null) {
      const listing=await loadListingInventory(ctx,account,line.product_id,line.qty,{items:inventory});
      if(!listing.complete||listing.owned!==true)return {items:[],available:listing.owned===false?false:null,reason:"listing_not_rentable_or_unmapped"} as const;
      for(const c of listing.components.filter(c=>c.stock_required))required.set(c.item_id,(required.get(c.item_id)??0)+c.requested_units);
    }else {
      const matches=inventory.filter(i=>line.item_id?String(i._id)===line.item_id:i.name_canonical.toLowerCase()===line.name.toLowerCase());
      if(matches.length!==1)return {items:[],available:null,reason:"unresolved_order_item"} as const;
      const supplied=withDefaultAdapters([{item_id:String(matches[0]._id),qty:line.qty}],inventory);
      if(supplied.unresolved.length)return {items:[],available:null,reason:"unresolved_default_adapter"} as const;
      for(const c of supplied.components)required.set(c.item_id,(required.get(c.item_id)??0)+c.qty);
    }
  }
  if(!required.size)return {items:[],available:null,reason:"no_physical_order_items"} as const;
  const resolved:OrderPhysicalItem[]=[...required].map(([item_id,quantity])=>({item_id,quantity,name:inventory.find(i=>String(i._id)===item_id)!.name_canonical}));
  return {items:resolved.sort((a,b)=>a.item_id.localeCompare(b.item_id)),reason:"identity_resolved",available:null} as const;
}
export function sameOrderPhysicalItems(before:OrderPhysicalItem[]|undefined,after:OrderPhysicalItem[]) {
  if(!before?.length||!after.length)return false;
  const key=(items:OrderPhysicalItem[])=>JSON.stringify([...items].sort((a,b)=>a.item_id.localeCompare(b.item_id)).map(i=>[i.item_id,i.name,i.quantity]));
  return key(before)===key(after);
}
/** Check the candidate basket in the mutation's database snapshot. Shared kit
 * components are counted together; independent per-line successes are unsafe. */
export async function checkOrderRentalStock(ctx: QueryCtx, account: string, lines: Line[], start: string, end: string, thread: string, preloadedSources?: Awaited<ReturnType<typeof loadStockSources>>, times?: {pickup_time?:string;return_time?:string}) {
  const sources = preloadedSources ?? await loadStockSources(ctx);
  const resolved=await resolveOrderPhysicalItems(ctx,account,lines,sources.items);
  if(!resolved.items.length)return {available:resolved.available,reason:resolved.reason,receipts:[]};
  const receipts = resolved.items.map(({item_id,quantity}) => {
    const item = sources.items.find(i => String(i._id) === item_id)!;
    return { ...stockForItem(sources, item, { item_name: item.name_canonical, start_date: start, end_date: end, quantity, thread_id: thread, ...times }), start_date: start, end_date: end };
  });
  const available = receipts.some(r => r.available === false) ? false : receipts.every(r => r.available === true) ? true : null;
  return { available, reason: available === true ? "available" : available === false ? "component_unavailable" : "stock_unknown", receipts };
}
