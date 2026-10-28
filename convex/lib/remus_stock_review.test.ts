import { describe, expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { remusStockReview, REMUS_OFFERS } from "./remus_stock_review";
import { resolveListingComponents } from "./listing_components";
import { listingStock } from "./listing_inventory";
import { canonicalListingAllocation } from "./canonical_listing_allocation";

const fixture=()=>{
  const items=[...[33,45,65,100].map(focal=>({_id:`lens-${focal}`,name_canonical:`Anamorphic Blazar Remus ${focal}mm`,kind:"lens",status:"active",qty:1,is_marketing_only:false})),{_id:"body",name_canonical:"BMPCC 6K Full Frame",kind:"camera",status:"active",qty:1,is_marketing_only:false}] as unknown as Doc<"items">[];
  const products=REMUS_OFFERS.map(([account,id,focals,camera])=>({_id:`product-${id}`,accountSlug:account,productId:id,name:`${camera?"Blackmagic camera + ":""}Blazar Remus ${focals.join("/")}mm ${focals.length>1?"lens set":"lens"}`,description:"Legacy unstructured seller prose",isMarketingOnly:focals.length===4,masterItemId:camera?"body":focals.length===4?undefined:`lens-${focals[0]}`})) as unknown as Doc<"hygglo_products">[];
  return {items,products};
};
const repair=()=>{
  const {items,products}=fixture(),plan=remusStockReview(items,products);
  for(const row of plan.items)Object.assign(items.find(i=>i._id===row.id)!,row.patch);
  for(const row of plan.products)Object.assign(products.find(p=>p._id===row.id)!,row.patch);
  return {items,products};
};
const resolution=(items:Doc<"items">[],product:Doc<"hygglo_products">)=>({...resolveListingComponents(items,undefined,product.masterItemId,1,product.description,undefined,product.name),product_id:product.productId,listing_name:product.name??null});

describe("reviewed Remus offers use actual shared master lenses",()=>{
  it("repairs all 22 single, set and camera offers across three accounts without changing owned quantity",()=>{
    const {items,products}=repair();
    for(const [account,id,focals,camera] of REMUS_OFFERS){
      const product=products.find(p=>p.accountSlug===account&&p.productId===id)!;
      const result=resolution(items,product);
      expect(result).toMatchObject({complete:true,owned:true});
      expect(product.isMarketingOnly).toBe(false);
      expect(result.components.filter(c=>c.kind==="lens").map(c=>c.item_id).sort()).toEqual(focals.map(f=>`lens-${f}`).sort());
      expect(result.components.every(c=>c.units_per_listing===1)).toBe(true);
      if(camera)expect(result.components.some(c=>c.item_id==="body")).toBe(true);
    }
    expect(items.every(item=>item.qty===1)).toBe(true);
    expect(remusStockReview(items,products)).toEqual({items:[],products:[]});
  });
  it("a confirmed 45mm hire blocks every account's overlapping set but leaves the 33mm free",()=>{
    const {items,products}=repair();
    const request={item_name:"Remus",start_date:"2026-11-03",end_date:"2026-11-04",quantity:1};
    const reservations=[{status:"confirmed",start_date:request.start_date,end_date:request.end_date,expanded_items:[{item_id:"lens-45",qty:1}]}] as unknown as Doc<"reservations">[];
    const sources={items,reservations,productIndex:new Map(),overrides:new Map(),claims:[],blackouts:[],vacations:[]};
    for(const [account,id,focals]of REMUS_OFFERS){
      const product=products.find(p=>p.accountSlug===account&&p.productId===id)!;
      expect(listingStock(sources,resolution(items,product),request).available).toBe(!focals.includes(45 as never));
    }
  });
  it("recomputes an existing camera rental from canonical contents rather than its old body-only attribution",()=>{
    const {items,products}=repair();
    const product=products.find(p=>p.accountSlug==="dbcinema"&&p.productId===1021785)!;
    const overrides=[{account_slug:"dbcinema",product_id:1021785,components:[{item_id:"body",qty:1}]}] as unknown as Doc<"listing_resolution_override">[];
    const allocation=canonicalListingAllocation(items,overrides,products,[]);
    expect(allocation.get("dbcinema#1021785")!.map(c=>c.item_id).sort()).toEqual(["body","lens-45","lens-65","lens-100"].sort());
    const reservations=[{account_slug:"dbcinema",status:"confirmed",start_date:"2026-11-03",end_date:"2026-11-04",hygglo_items:[{product_id:1021785,name:product.name,qty:1}],expanded_items:[{item_id:"body",qty:1}]}] as unknown as Doc<"reservations">[];
    const single=products.find(p=>p.accountSlug==="diogo"&&p.productId===1173328)!;
    const sources={items,reservations,productIndex:new Map<string,string>(),overrides:allocation,claims:[],blackouts:[],vacations:[]};
    expect(listingStock(sources,resolution(items,single),{item_name:"Remus 45mm",start_date:"2026-11-03",end_date:"2026-11-04",quantity:1}).available).toBe(false);
  });
  it("refuses missing masters, duplicate identities and an explicit owner exclusion",()=>{
    const {items,products}=fixture();
    expect(()=>remusStockReview(items.slice(1),products)).toThrow("Owned master");
    expect(()=>remusStockReview([...items,items[0]],products)).toThrow("Owned master");
    products[0].isMarketingOnlyOverride=true;
    expect(()=>remusStockReview(items,products)).toThrow("exclusion");
  });
});
