import type { Doc } from "../_generated/dataModel";

const SOURCE = "review:mixed-wireless-microphone-bundle-20261028";
const PRODUCT_ID = 1027212;
const expectedTitle = "3x Dji mic wireless receiver Transmitter +2x rode wireless pro microphone sound";
const escape = (value:string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Preserve the actual declared RØDE sets in rental allocations while the DJI
 * transmitter/receiver count remains ambiguous and must not be sold as verified. */
export function mixedMicrophoneStockReview(items:Doc<"items">[], product:Doc<"hygglo_products">, override:Doc<"listing_resolution_override">) {
  const one=(name:string, minimum:number)=>{
    const found=items.filter(item=>item.name_canonical===name);
    if(found.length!==1 || found[0].status!=="active" || found[0].is_marketing_only!==false || !Number.isSafeInteger(found[0].qty) || found[0].qty<minimum || found[0].unit_kind!=="set") throw Error(`Review master stock: ${name}`);
    return found[0];
  };
  const dji=one("DJI Wireless Mics",1), rode=one("Rode Wireless Mic Pro set",2);
  if(product.accountSlug!=="dbcinema" || product.productId!==PRODUCT_ID || product.name!==expectedTitle || product.masterItemId!==rode._id || product.isMarketingOnlyOverride===true) throw Error("Mixed offer identity or owner exclusion changed");
  if(override.account_slug!=="dbcinema" || override.product_id!==PRODUCT_ID)throw Error("Mixed offer mapping changed");
  const original=[{item_id:dji._id,qty:1}], desired=[...original,{item_id:rode._id,qty:2}];
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,stable(entry)])):value;
  const same=(a:unknown,b:unknown)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
  if(!same(override.components,original)&&!same(override.components,desired))throw Error("Mixed offer existing mapping needs review");
  const rule={title_pattern:`^${escape(expectedTitle)}$`,components:desired,excludes:[],source:SOURCE,packing_review_required:true,stock_review_required:true};
  const existing=rode.listing_stock_rules??[];
  if(existing.some(r=>r.source===SOURCE&&!same(r,rule)))throw Error("Mixed offer review rule changed");
  return {item:existing.some(r=>r.source===SOURCE)?null:{id:rode._id,listing_stock_rules:[...existing,rule]},override:same(override.components,desired)?null:{id:override._id,components:desired}};
}
