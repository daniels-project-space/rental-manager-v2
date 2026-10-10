import type {QueryCtx} from "../_generated/server";
import type {Doc} from "../_generated/dataModel";
import {dedupByLogicalRental} from "./reservations/predicates";
import {buildProductIndexMap,reservationItemUnits} from "./reservations/itemUnits";
import {loadCanonicalListingAllocation} from "./canonical_listing_allocation";
import {stockOccupancyForItem,shiftStockDate} from "./renter_stock";
import {londonToday} from "./effectiveDates";
import {londonStockInstant} from "./confirmed_schedule";
import {loadStockRepairs} from "./stock_repairs";
import {STOCK_FORECAST_VERSION,type StockForecastSnapshot} from "../../src/lib/stock-forecast";

/** One bounded source set shared by the live widget and its hourly producer.
 * Physical stock is shared across accounts; no per-account quantity fiction.
 * Fail explicitly on catalogue/import growth instead of silently truncating. */
export async function buildStockForecast(ctx:QueryCtx,days:number,prefetched?:{items:Doc<"items">[];confirmed:Doc<"reservations">[]}):Promise<StockForecastSnapshot>{
 if(!Number.isInteger(days)||days<1||days>90)throw Error("Stock outlook must be between 1 and 90 days");
 const [items,confirmed,ongoing,website,index,overrides,repairs]=await Promise.all([
  prefetched?.items??ctx.db.query("items").withIndex("by_canonical_name").take(2001),
  prefetched?.confirmed??ctx.db.query("reservations").withIndex("by_status",q=>q.eq("status","confirmed")).take(2001),
  ctx.db.query("reservations").withIndex("by_status",q=>q.eq("status","ongoing")).take(2001),
  ctx.db.query("reservations").withIndex("by_account_status",q=>q.eq("account_slug","dbcinema_web").eq("status","pending_review")).take(2001),
  ctx.db.query("hygglo_product_index").withIndex("by_account_product").take(4001),
  ctx.db.query("listing_resolution_override").withIndex("by_account_product").take(4001),
  loadStockRepairs(ctx),
 ]);
 if(items.length>2000||confirmed.length>2000||ongoing.length>2000||website.length>2000||index.length>4000||overrides.length>4000)throw Error("Stock outlook source requires paged reconciliation");
 const reservations=dedupByLogicalRental([...confirmed,...ongoing,...website.filter(r=>r.order_step==="VERIFIED")].filter(r=>!r.is_obsolete&&!r.hygglo_order_id?.startsWith("__probe__")));
 const productIndex=buildProductIndexMap(index),allocation=await loadCanonicalListingAllocation(ctx,items,overrides,reservations);
 const units=new Map(reservations.map(r=>[String(r._id),reservationItemUnits(r,productIndex,allocation,items)]));
 const sources={items,reservations,productIndex,overrides:allocation,reservationUnits:units};
 const today=londonToday(),end=shiftStockDate(today,days);
 const inputs=await Promise.all(items.filter(i=>i.status==="active"&&!i.is_marketing_only&&i.qty>0).map(async item=>{
  const groups=new Map<string,number>();
  const windows=stockOccupancyForItem(sources,item,{item_name:item.name_canonical,start_date:today,end_date:end}).map(w=>{
   let group:number|undefined;
   if(w.extension_key){if(!groups.has(w.extension_key))groups.set(w.extension_key,groups.size);group=groups.get(w.extension_key);}
   return {start:w.startInstant!,end:w.endInstant!,qty:w.qty,...(group===undefined?{}:{group})};
  });
  const product=item.image_url?null:await ctx.db.query("hygglo_products").withIndex("by_master_item",q=>q.eq("masterItemId",item._id)).first();
  return {item_id:String(item._id),name:item.name_canonical,qty:item.qty,inRepair:repairs.get(String(item._id))??0,windows,image:item.image_url??product?.images?.[0]?.fullSizeUrl??product?.images?.[0]?.thumbnailUrl??null};
 }));
 return {stockWindowVersion:STOCK_FORECAST_VERSION,horizonEnd:londonStockInstant(end+"T00:00","end"),inputs};
}
