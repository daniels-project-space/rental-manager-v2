import type {QueryCtx} from "../_generated/server";
import type {Doc} from "../_generated/dataModel";
import {baseListingProductIds,chooseBaseListing} from "./base_listing_identity";
import {resolveListingComponents} from "./listing_inventory";
import {describeTiers,rentalQuote,tierRateForDays,type PriceTier} from "./hygglo_pricing";

/** One account/identity pricing path for searches and current reply approval.
 * This establishes price only; stock and technical qualification stay separate. */
export function ownedItemHirePriceReader(ctx:QueryCtx,accountSlug:string,listings:Doc<"online_listings">[],index:Doc<"hygglo_product_index">[],overrides:Doc<"listing_resolution_override">[],inventory:Doc<"items">[],days:number|null,quantity:number){
 const readListing=(item:Doc<"items">)=>{
  const pids=baseListingProductIds(accountSlug,String(item._id),index,overrides,inventory,listings);
  const candidateContents=new Map<number,ReturnType<typeof resolveListingComponents>>();
  const verified=listings.filter(listing=>{
   if(!pids.includes(listing.product_id))return false;
   const mapping=overrides.find(row=>row.account_slug===accountSlug&&row.product_id===listing.product_id);
   const contents=resolveListingComponents(inventory,mapping?.components.map(c=>({item_id:String(c.item_id),qty:c.qty})),String(item._id),quantity,listing.description);
   candidateContents.set(listing.product_id,contents);
   return contents.complete&&contents.owned===true;
  });
  const altListing=chooseBaseListing(verified,pids);
  return {candidateContents,altListing,altPid:altListing?.product_id};
 };
 const listingsByItem=new Map<string,ReturnType<typeof readListing>>();
 const listing=(item:Doc<"items">)=>{
  const id=String(item._id);let result=listingsByItem.get(id);
  if(!result){result=readListing(item);listingsByItem.set(id,result);}return result;
 };
 const readPrice=async(item:Doc<"items">)=>{
  const selected=listing(item);let raw:PriceTier[]=[];
  if(selected.altPid!=null){
   const hp=await ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",accountSlug).eq("productId",selected.altPid!)).unique();
   raw=(hp?.prices??[]) as PriceTier[];
  }
  return {...selected,altTiers:describeTiers(raw),altOneDay:tierRateForDays(raw,1),
   quote:days!==null&&selected.altListing?rentalQuote(raw,selected.altListing.daily_price,days,quantity):null};
 };
 const pricesByItem=new Map<string,ReturnType<typeof readPrice>>();
 const price=(item:Doc<"items">)=>{
  const id=String(item._id);let result=pricesByItem.get(id);
  if(!result){result=readPrice(item);pricesByItem.set(id,result);}return result;
 };
 return {listing,price};
}
