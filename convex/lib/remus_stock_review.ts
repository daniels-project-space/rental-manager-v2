import type { Doc } from "../_generated/dataModel";

// Reviewed against the live owned master inventory and existing four-lens
// packing audit, 28 October 2026. These are offers for the SAME four lenses,
// never separate account-specific stock. No quantities or reservations change.
export const REMUS_STOCK_SOURCE = "Owned Remus master-stock reconciliation, 28 October 2026";
export const REMUS_OFFERS = [
  ["dbcinema",1038954,[33]], ["dbcinema",987356,[45]], ["dbcinema",987357,[65]], ["dbcinema",987359,[100]],
  ["dbcinema",987362,[45,65,100]], ["dbcinema",1038953,[33,45,65,100]], ["dbcinema",1021785,[45,65,100],true],
  ["diogo",1173472,[33]], ["diogo",1173328,[45]], ["diogo",1173583,[65]], ["diogo",1173582,[100]],
  ["diogo",1173326,[45,65,100]], ["diogo",1173305,[33,45,65,100]], ["diogo",1173577,[45,65,100],true],
  ["leo",1172348,[33]], ["leo",1116292,[45]], ["leo",1116293,[65]], ["leo",1116294,[100]],
  ["leo",1114673,[45,65,100]], ["leo",1116295,[45,65,100]], ["leo",1172353,[33,45,65,100]], ["leo",1122325,[45,65,100],true],
] as const;
const escape = (value:string) => value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

export function remusStockReview(items: Doc<"items">[], products: Doc<"hygglo_products">[]) {
  const owned = (name:string) => {
    const matches=items.filter(item=>item.name_canonical===name);
    if(matches.length!==1 || matches[0].status!=="active" || matches[0].is_marketing_only!==false || !Number.isSafeInteger(matches[0].qty) || matches[0].qty<1)
      throw Error(`Owned master needs review: ${name}`);
    return matches[0];
  };
  const lenses=new Map([33,45,65,100].map(focal=>[focal,owned(`Anamorphic Blazar Remus ${focal}mm`)]));
  const body=owned("BMPCC 6K Full Frame");
  const additions=new Map<string,NonNullable<Doc<"items">["listing_stock_rules"]>>();
  const productChanges:Array<{id:Doc<"hygglo_products">["_id"];patch:Partial<Doc<"hygglo_products">>}> = [];
  for(const [account,id,focals,camera] of REMUS_OFFERS) {
    const matches=products.filter(p=>p.accountSlug===account && p.productId===id);
    if(matches.length!==1)throw Error(`Reviewed offer missing or duplicated: ${account}#${id}`);
    const product=matches[0];
    if(!/\bremus\b/i.test(product.name??"") || product.isMarketingOnlyOverride===true)throw Error(`Offer identity/exclusion needs review: ${account}#${id}`);
    const components=[...(camera?[body]:[]),...focals.map(f=>lenses.get(f)!)];
    const primary=camera?body:lenses.get(focals[0])!;
    const pattern=`^${escape(product.name!)}$`;
    if(pattern.length>200)throw Error("Reviewed title exceeds the stock-rule limit");
    const rules=additions.get(String(primary._id))??[];
    if(!rules.some(rule=>rule.title_pattern===pattern))rules.push({
      title_pattern:pattern,source:REMUS_STOCK_SOURCE,excludes:[],
      components:components.map(item=>({item_id:item._id,qty:1})),
      description_override:`Contents: ${components.map(item=>`• 1x ${item.name_canonical}`).join(" ")}`,
    });
    additions.set(String(primary._id),rules);
    const patch:Partial<Doc<"hygglo_products">>={};
    if(product.masterItemId!==primary._id || product.stockIdentityOverride?.itemId!==primary._id || product.stockIdentityOverride?.title!==product.name)
      Object.assign(patch,{masterItemId:primary._id,stockIdentityOverride:{itemId:primary._id,title:product.name!,source:REMUS_STOCK_SOURCE}});
    // Clear the stale automatic marketing tag only on the reviewed four-lens
    // offers. Explicit owner exclusions above still stop this maintenance run.
    if(focals.length===4 && product.isMarketingOnly && product.isMarketingOnlyOverride===undefined)
      Object.assign(patch,{isMarketingOnly:false,isMarketingOnlyOverride:false,marketingOnlyUpdatedAt:Date.now()});
    if(Object.keys(patch).length)productChanges.push({id:product._id,patch});
  }
  const itemChanges=[...additions].flatMap(([id,rules])=>{
    const item=items.find(i=>String(i._id)===id)!;
    const listing_stock_rules=[...(item.listing_stock_rules??[]).filter(rule=>rule.source!==REMUS_STOCK_SOURCE),...rules];
    return JSON.stringify(item.listing_stock_rules)===JSON.stringify(listing_stock_rules)?[]:[{id:item._id,patch:{listing_stock_rules}}];
  });
  return {items:itemChanges,products:productChanges};
}
