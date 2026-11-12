/** A read-only, independently checked alternative for the prepared Lab case.
 * Inventory and prices come from Rental Manager; the website confirms the
 * exact account listing and its mapped physical unit. No reservations or
 * customer records are read or changed. */
const RM = "https://hearty-oyster-600.convex.cloud/api/query";
const WEBSITE = "https://zany-wolf-18.convex.cloud/api/query";
const ORIGINAL_ID = "kn740n15w16172sn1qj8h89gx586b2xf";
const ALTERNATIVE_ID = "kn74p93r60ndmmb0qghjqg84yh86abvh";
const WEBSITE_SLUG = "sony-a7-iii-a7iii-4k-cinema-camera-full-frame-mirrorless-bod-1046235";
const WEBSITE_LISTING = "jx7a75qnq4gwpy9qnmaqz3tvbn885gq4";
const WEBSITE_UNIT = "jn7chzv64ga6g1z43pxn0h5r6n885hgd";

export type PreparedAlternative = { original_value_gbp:number; replacement_value_gbp:number; qty:number;
  daily_price_gbp:number; price_tiers:Array<{days:number;pricePerDay:number}>; source_synced_at:number };

export async function preparedAlternativeSnapshot(fetcher:typeof fetch=fetch,now=Date.now()):Promise<PreparedAlternative|null> {
  const query = async (url:string,path:string,args:unknown) => {
    const r=await fetcher(url,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({path,args,format:"json"}),signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error("Source unavailable");
    const payload=await r.json() as {status?:string;value?:unknown};
    if(payload.status!=="success")throw Error("Source unavailable");
    return payload.value;
  };
  try {
    const [products,derivation,reconcile,listing]=await Promise.all([
      query(RM,"hygglo_products:getByMasterItem",{masterItemId:ALTERNATIVE_ID}),
      query(RM,"listing_info_pool:admin_getDerivationBatch",{force:true,targets:[
        {account_slug:"dbcinema",product_id:1103089,raw_title:"Blackmagic Full Frame"},
        {account_slug:"dbcinema",product_id:1046235,raw_title:"Sony A7 III"}]}),
      query(RM,"items:listForReconcile",{}),
      query(WEBSITE,"catalog:getListingBySlug",{slug:WEBSITE_SLUG}),
    ]);
    if(!Array.isArray(products)||!Array.isArray(reconcile)||!derivation||typeof derivation!=="object"||
       !("inventory" in derivation)||!Array.isArray(derivation.inventory)||!listing||typeof listing!=="object")return null;
    const rows=products.filter((p):p is Record<string,unknown>=>!!p&&typeof p==="object"&&p.accountSlug==="dbcinema"&&p.productId===1046235);
    const inv=derivation.inventory as Array<Record<string,unknown>>;
    const original=inv.filter(i=>i.item_id===ORIGINAL_ID&&i.name_canonical==="BMPCC 6K Full Frame"&&i.kind==="camera");
    const alternative=inv.filter(i=>i.item_id===ALTERNATIVE_ID&&i.name_canonical==="Sony A7 III"&&i.kind==="camera");
    const stock=(reconcile as Array<Record<string,unknown>>).filter(i=>i._id===ALTERNATIVE_ID&&i.name==="Sony A7 III"&&i.status==="active"&&i.is_marketing_only===false);
    const site=listing as Record<string,unknown>;
    const facts=site.inventoryFacts as {owned?:unknown;reviewRequired?:unknown}|null;
    const parts=site.components as Array<{inventoryUnitId?:unknown;qty?:unknown}>|undefined;
    if(rows.length!==1||original.length!==1||alternative.length!==1||stock.length!==1||
      site._id!==WEBSITE_LISTING||site.slug!==WEBSITE_SLUG||site.bookable!==true||site.marketingOnly!==false||
      facts?.owned!==true||facts.reviewRequired!==false||!Array.isArray(parts)||parts.length!==1||
      parts[0].inventoryUnitId!==WEBSITE_UNIT||parts[0].qty!==1)return null;
    const product=rows[0], originalValue=original[0].replacement_cost_gbp, value=alternative[0].replacement_cost_gbp, qty=stock[0].qty;
    if(product.masterItemId!==ALTERNATIVE_ID||product.isPublished!==true||product.isMarketingOnly!==false||
      typeof product.lastSyncedAt!=="number"||product.lastSyncedAt>now+300000||now-product.lastSyncedAt>48*60*60*1000||
      typeof originalValue!=="number"||!Number.isFinite(originalValue)||originalValue<=0||
      typeof value!=="number"||!Number.isFinite(value)||value<=0||value>=originalValue||
      typeof qty!=="number"||!Number.isSafeInteger(qty)||qty<1||!Array.isArray(product.prices))return null;
    const tiers=(product.prices as Array<Record<string,unknown>>).flatMap(t=>
      typeof t.days==="number"&&Number.isInteger(t.days)&&t.days>=1&&t.days<=366&&
      typeof t.pricePerDay==="number"&&Number.isFinite(t.pricePerDay)&&t.pricePerDay>0
        ? [{days:t.days,pricePerDay:t.pricePerDay}] : []);
    if(new Set(tiers.map(t=>t.days)).size!==tiers.length)return null;
    const daily=tiers.find(t=>t.days===1)?.pricePerDay;
    if(!daily)return null;
    return {original_value_gbp:originalValue,replacement_value_gbp:value,qty,daily_price_gbp:daily,
      price_tiers:tiers,source_synced_at:product.lastSyncedAt};
  } catch {return null;}
}
