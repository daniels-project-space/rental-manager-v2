import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth",()=>({authComponent:{registerRoutes:vi.fn(),safeGetAuthUser:vi.fn()},createAuth:vi.fn()}));
import { __service_catalogueForStorefront } from "./hygglo_products";
import { componentReplacementInventoryFingerprint } from "./lib/componentReplacementEvidence";
import { __service_listActiveForStorefront } from "./reservations";
import { storefrontRead } from "./http";
import { getFunctionName } from "convex/server";
function fixture(){
 const items:any[]=[{_id:"body",name_canonical:"Sony FX3",kind:"camera_body",status:"active",is_marketing_only:false,qty:4,replacement_cost_gbp:4000},{_id:"lens",name_canonical:"Sony GM 24-70mm f2.8",kind:"lens",status:"active",is_marketing_only:false,qty:3,replacement_cost_gbp:2000},{_id:"battery",name_canonical:"NP-FZ100 batteries",kind:"power",track_independent_stock:true,status:"active",is_marketing_only:false,qty:12,replacement_cost_gbp:70}];
 const tables:any={items,hygglo_products:[{productId:10,accountSlug:"dbcinema",name:"Two body camera and lens kit",masterItemId:"body",private_note:"PRIVATE"}],online_listings:[{account_slug:"dbcinema",product_id:10,description:"Included in this rental: • 2x Sony FX3 • 2x Sony GM 24-70mm f2.8 • 5x NP-FZ100 batteries"}],listing_resolution_override:[{account_slug:"dbcinema",product_id:10,components:[{item_id:"body",qty:2},{item_id:"lens",qty:2},{item_id:"battery",qty:5}]}],hygglo_product_index:[],reservations:[]};
 const reads:string[]=[];const db:any={query:(table:string)=>{reads.push(table);let values=tables[table]??[];const q:any={withIndex:(_:string,fn:any)=>{const s:any={eq:(k:string,v:any)=>{values=values.filter((r:any)=>r[k]===v);return s},gte:(k:string,v:any)=>{values=values.filter((r:any)=>r[k]>=v);return s}};fn(s);return q},collect:async()=>values};return q}};return {tables,db,reads};
}
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers()});
describe("actual canonical website kit snapshot and stock feed",()=>{
 it("uses one indexed snapshot with exact physical quantities and audited per-kit contents",async()=>{
  const f=fixture();const [row]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});
  expect(row.stockMapping).toMatchObject({version:1,complete:true,owned:true});expect(row.stockMapping.components.map((c:any)=>[c.masterItemId,c.qty,c.quantityOwned,c.replacementCost])).toEqual([["body",2,4,4000],["lens",2,3,2000],["battery",5,12,70]]);expect(f.reads).toEqual(["hygglo_products","items","listing_resolution_override","online_listings"]);
 });
 it("exports reviewed replacement evidence without enabling checkout or exposing the review note",async()=>{
  const f=fixture();f.tables.items.push({_id:"other-lens",name_canonical:"Alternative lens",status:"active",is_marketing_only:false,qty:1,replacement_cost_gbp:2500});
  const weights=[{item_id:"body",weight_grams:1000},{item_id:"lens",weight_grams:800},{item_id:"battery",weight_grams:200},{item_id:"other-lens",weight_grams:900}];
  const extensionRates=Array.from({length:30},(_,index)=>(index+1)*125);
  f.tables.listing_resolution_override[0].component_replacements=[{original_item_id:"lens",replacement_item_id:"other-lens",qty:1,price_adjustment_pence:500,extension_adjustment_pence:extensionRates,replacement_size_score:2,weights,review_note:"PRIVATE owner review",reviewed_at:123,inventory_fingerprint:componentReplacementInventoryFingerprint(f.tables.items)}];
  const [row]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});
  expect(row.componentReplacementEvidence).toEqual({version:1,checkoutAvailable:false,reviewedSubstitutions:[{originalMasterItemId:"lens",replacementMasterItemId:"other-lens",quantityPerKit:1,priceAdjustmentPence:500,extensionAdjustmentPence:extensionRates,replacementSizeScore:2,weights:weights.map(w=>({masterItemId:w.item_id,weightGrams:w.weight_grams})),reviewedAt:123,replacementInventory:{masterItemId:"other-lens",active:true,quantityOwned:1,replacementCost:2500}}]});
  expect(JSON.stringify(row.componentReplacementEvidence)).not.toContain("PRIVATE");
  f.tables.items[1].replacement_cost_gbp = 9999;
  const [stale]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});
  expect(stale.componentReplacementEvidence.reviewedSubstitutions).toEqual([]);
 });
 it("exports an evidenced missing component as a descriptor, never as physical stock",async()=>{
  const f=fixture();f.tables.items.push({_id:"other-lens",name_canonical:"Alternative lens",status:"active",is_marketing_only:false,qty:1,replacement_cost_gbp:2500});
  f.tables.online_listings[0].public_url="https://example.invalid/listing";f.tables.online_listings[0].description="Includes 16–35mm f/4 lens";
  f.tables.listing_resolution_override[0].components=[{item_id:"body",qty:2}];
  const weights=[{item_id:"body",weight_grams:1000},{item_id:"other-lens",weight_grams:900}];
  f.tables.listing_resolution_override[0].component_replacements=[{missing_original:{descriptor_id:"declared:lens-f4",label:"16–35mm f/4 lens",quantity:1,source_url:"https://example.invalid/listing",source_excerpt:"Includes 16–35mm f/4 lens"},replacement_item_id:"other-lens",qty:1,price_adjustment_pence:500,replacement_size_score:2,weights,review_note:"Owner reviewed evidence",reviewed_at:123,inventory_fingerprint:componentReplacementInventoryFingerprint([f.tables.items[0],f.tables.items[3]])}];
  const [row]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});
  expect(row.componentReplacementEvidence.reviewedSubstitutions[0].declaredMissingOriginal).toEqual({descriptorId:"declared:lens-f4",label:"16–35mm f/4 lens",quantityPerKit:1,sourceUrl:"https://example.invalid/listing",sourceExcerpt:"Includes 16–35mm f/4 lens"});
  expect(row.stockMapping.components.some((component:any)=>component.masterItemId==="declared:lens-f4")).toBe(false);
  expect(row.componentReplacementEvidence.checkoutAvailable).toBe(false);
  f.tables.online_listings[0].description="Listing copy changed";
  const [changed]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});
  expect(changed.componentReplacementEvidence.reviewedSubstitutions).toEqual([]);
 });
 it("does not certify a primary match or a mapping that omits a declared tracked component",async()=>{
  const f=fixture();f.tables.listing_resolution_override=[];let [row]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});expect(row.stockMapping).toMatchObject({complete:false,owned:null});f.tables.listing_resolution_override=[{account_slug:"dbcinema",product_id:10,components:[{item_id:"body",qty:2},{item_id:"lens",qty:2}]}];[row]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});expect(row.stockMapping).toMatchObject({complete:false,owned:null});
 });
 it.each(["inactive","marketing","zero","missing"])("blocks the entire kit for %s physical inventory",async mode=>{
  const f=fixture();const lens=f.tables.items[1];if(mode==="inactive")lens.status="inactive";if(mode==="marketing")lens.is_marketing_only=true;if(mode==="zero")lens.qty=0;if(mode==="missing")f.tables.items.splice(1,1);const [row]=await (__service_catalogueForStorefront as any)._handler({db:f.db},{accountSlug:"dbcinema"});expect(row.stockMapping.owned).not.toBe(true);if(mode!=="missing")expect(row.stockMapping.components.find((c:any)=>c.masterItemId==="lens").quantityOwned).toBe(0);
 });
 it("exposes canonical mapping only through the authenticated fixed-account route",async()=>{
  vi.stubEnv("OWNER_AUTH_REQUIRED","true");vi.stubEnv("DBCINEMA_WEBHOOK_SECRET","fixture-canonical-read");const f=fixture();const ctx={runQuery:async(ref:any,args:any)=>{expect(getFunctionName(ref)).toBe("hygglo_products:__service_catalogueForStorefront");return (__service_catalogueForStorefront as any)._handler({db:f.db},args)}};const response=await (storefrontRead as any)._handler(ctx,new Request("https://fixture.convex.site/dbcinema/storefront-read",{method:"POST",headers:{"x-dbcinema-sync-token":"fixture-canonical-read"},body:JSON.stringify({path:"hygglo_products:catalogueForStorefront",args:{accountSlug:"dbcinema"}})}));expect(response.status).toBe(200);const text=await response.text();expect(text).not.toContain("PRIVATE");expect(JSON.parse(text).value[0].stockMapping.complete).toBe(true);
 });
 it("exports the same authoritative kit units used by manager stock, including an explicit owned-nothing override",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-08"));const f=fixture();f.tables.reservations=[{_id:"booked",account_slug:"dbcinema",status:"confirmed",start_date:"2027-01-01",end_date:"2027-01-02",hygglo_items:[{product_id:10,qty:2}],resolved_items:[{item_id:"body",qty:1}],expanded_items:[{item_id:"body",qty:1}]}];let [row]=await (__service_listActiveForStorefront as any)._handler({db:f.db},{account_slug:"dbcinema"});expect(row.physical_items).toEqual([{item_id:"body",qty:4},{item_id:"lens",qty:4},{item_id:"battery",qty:10}]);f.tables.listing_resolution_override[0].components=[];[row]=await (__service_listActiveForStorefront as any)._handler({db:f.db},{account_slug:"dbcinema"});expect(row.physical_items).toEqual([]);
 });
});
