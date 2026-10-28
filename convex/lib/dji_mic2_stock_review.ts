import type { Doc } from "../_generated/dataModel";

/** Seller descriptions share one physical Mic 2. Wired lavaliers are listed
 * by two sellers, but have no independently recorded master stock pool. */
export const DJI_MIC2_REVIEW_SOURCE = "DJI Mic 2 owned master and seller packing review, 28 October 2026";
export const DJI_MIC2_OFFERS = [["dbcinema",1044310],["diogo",1173784],["leo",1097516]] as const;
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;
const escape = (text:string) => text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

export function djiMic2StockReview(items:Doc<"items">[],products:Doc<"hygglo_products">[],overrides:Doc<"listing_resolution_override">[]) {
  const masters=items.filter(item=>item.name_canonical==="DJI Mic 2 wireless");
  if(masters.length!==1 || masters[0].status!=="active" || masters[0].is_marketing_only!==false || !Number.isSafeInteger(masters[0].qty) || masters[0].qty<1 || masters[0].unit_kind!=="set") throw Error("Owned DJI Mic 2 master identity needs review");
  const master=masters[0], parts=master.compatibility?.included_with_rental??[];
  if(!["2x transmitter","1x receiver","1x charging case"].every(part=>parts.includes(part))) throw Error("DJI Mic 2 master contents changed");
  const rules:NonNullable<Doc<"items">["listing_stock_rules"]>=[];
  const productChanges:Array<{id:Doc<"hygglo_products">["_id"];patch:Partial<Doc<"hygglo_products">>}>=[];
  const inserts:Array<{account_slug:string;product_id:number;components:{item_id:Doc<"items">["_id"];qty:number}[]}>=[];
  for(const [account,id] of DJI_MIC2_OFFERS) {
    const matches=products.filter(product=>product.accountSlug===account&&product.productId===id);
    if(matches.length!==1)throw Error(`Reviewed offer missing or duplicated: ${account}#${id}`);
    const product=matches[0], title=product.name??"";
    if(!/\bdji\s+mic\s*2\b/i.test(title) || product.isMarketingOnlyOverride===true) throw Error(`Offer identity or owner exclusion needs review: ${account}#${id}`);
    const existing=overrides.filter(row=>row.account_slug===account&&row.product_id===id);
    if(existing.length>1 || existing.length===1 && (existing[0].components.length!==1 || existing[0].components[0].item_id!==master._id || existing[0].components[0].qty!==1)) throw Error(`Existing owner mapping needs review: ${account}#${id}`);
    if(!existing.length) inserts.push({account_slug:account,product_id:id,components:[{item_id:master._id,qty:1}]});
    const pattern=`^${escape(title)}$`;
    if(pattern.length>200)throw Error("Reviewed title exceeds the stock rule limit");
    if(!rules.some(rule=>rule.title_pattern===pattern)) rules.push({title_pattern:pattern,source:DJI_MIC2_REVIEW_SOURCE,components:[{item_id:master._id,qty:1}],excludes:[],packing_review_required:true});
    const patch:Partial<Doc<"hygglo_products">>={};
    if(product.masterItemId!==master._id || product.stockIdentityOverride?.itemId!==master._id || product.stockIdentityOverride?.title!==title)
      Object.assign(patch,{masterItemId:master._id,stockIdentityOverride:{itemId:master._id,title,source:DJI_MIC2_REVIEW_SOURCE}});
    if(product.isMarketingOnly && product.isMarketingOnlyOverride===undefined)
      Object.assign(patch,{isMarketingOnly:false,isMarketingOnlyOverride:false,marketingOnlyUpdatedAt:Date.now()});
    if(Object.keys(patch).length)productChanges.push({id:product._id,patch});
  }
  const listing_stock_rules=[...(master.listing_stock_rules??[]).filter(rule=>rule.source!==DJI_MIC2_REVIEW_SOURCE),...rules];
  const itemChanges=JSON.stringify(stable(master.listing_stock_rules))===JSON.stringify(stable(listing_stock_rules))?[]:[{id:master._id,patch:{listing_stock_rules}}];
  return {items:itemChanges,products:productChanges,inserts};
}
