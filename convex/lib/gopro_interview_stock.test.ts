import { describe, expect, it } from "vitest";
import data from "../fixtures/gopro-interview-owner-confirmed.json";
import { apply } from "../seed/gopro_interview_stock_repair";
import { resolveListingComponents } from "./listing_components";
import { resolveBundleMapping } from "./bundle_mapping";
import { listingStock } from "./listing_inventory";
import { upsertProductsBatch } from "../hygglo_products";

const cameraId=data.items.find(i=>i.kind==="camera")!._id;
const audioId=data.items.find(i=>i.kind==="audio")!._id;
const lightId=data.items.find(i=>i.kind==="lighting")!._id;
const serialise=(value:any):any=>Array.isArray(value)?value.map(serialise):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(k=>[k,serialise(value[k])])):value;
function fixture(){
  const rows:Record<string,any[]>={stock_input_cache_state:[],items:structuredClone(data.items),hygglo_products:structuredClone(data.products).map(p=>({...p,_id:`product:${p.productId}`,isMarketingOnly:true})),hygglo_product_context:[],listing_resolution_override:[],audit_log:[],settings:[{_id:"settings",draft_epoch:7}],mv_reply_queue:["diogo","diogo:pending","all","all:pending","leo"].map(account=>({_id:`cache:${account}`,account}))};
  const writes:string[]=[];
  const db={query(table:string){let selected=rows[table];const q={withIndex(_name:string,fn:any){const index={eq(key:string,value:unknown){selected=selected.filter(x=>x[key]===value);return index;}};fn(index);return q;},async take(n:number){return selected.slice(0,n);},async first(){return selected[0]??null;},async unique(){if(selected.length>1)throw Error("Duplicate fixture key");return selected[0]??null;}};return q;},async patch(id:string,change:any){const row=Object.values(rows).flat().find(x=>x._id===id);if(!row)throw Error("Unknown record");Object.assign(row,serialise(change));writes.push(`patch:${id}`);},async insert(table:string,change:any){const id=`${table}:${rows[table].length}`;rows[table].push({...serialise(change),_id:id});writes.push(`insert:${table}`);return id;},async delete(id:string){for(const table of Object.keys(rows))rows[table]=rows[table].filter(r=>r._id!==id);writes.push(`delete:${id}`);}};
  const ctx={db,auth:{getUserIdentity:async()=>({issuer:"urn:rental-manager:deployment-service",subject:"rental-manager-service"})}};
  return {rows,writes,ctx,run:(dry_run?:boolean)=>(apply as any)._handler(ctx,{dry_run}),resolve:(productId:number,title?:string,description?:string)=>{
    const product=rows.hygglo_products.find(x=>x.productId===productId),override=rows.listing_resolution_override.find(x=>x.product_id===productId);
    return resolveListingComponents(rows.items as any,override?.components,product.masterItemId,1,description??product.description,undefined,title??product.name);
  }};
}

describe("owner-confirmed GoPro interview stock",()=>{
  it("previews, applies both actual source kits and replays with no extra writes after object-key normalisation",async()=>{
    const f=fixture(),products=structuredClone(f.rows.hygglo_products),quantities=f.rows.items.map(i=>i.qty);
    expect(await f.run()).toMatchObject({preview:true,inserted:2,metadataChanged:true});expect(f.writes).toEqual([]);
    expect(await f.run(false)).toMatchObject({preview:false,inserted:2,marketingCorrected:2,quantityOwned:{cameras:3,audioKits:2,panels:3}});
    for(const id of [1173687,1173688]){
      const result=f.resolve(id);expect(result.complete).toBe(true);expect(result.owned).toBe(true);
      expect(result.components.find(c=>c.item_id===cameraId)?.units_per_listing).toBe(3);
      expect(result.components.find(c=>c.item_id===audioId)?.units_per_listing).toBe(1);
      expect(result.components.find(c=>c.item_id===lightId)?.units_per_listing).toBe(id===1173688?3:undefined);
      expect(result.components).toHaveLength(id===1173688?3:2);expect(result.coverage?.unresolved).toEqual([]);
      expect(result.applied_stock_rules[0].source).toContain("ONE RODE");
    }
    expect(f.rows.hygglo_products.map(({isMarketingOnlyOverride,marketingOnlyUpdatedAt,...p})=>p)).toEqual(products);
    expect(f.rows.hygglo_products.every(p=>p.isMarketingOnlyOverride===false)).toBe(true);
    expect(f.rows.mv_reply_queue.map(r=>r.account)).toEqual(["leo"]);expect(f.rows.items.map(i=>i.qty)).toEqual(quantities);
    expect(f.rows.settings[0].draft_epoch).toBe(8);const count=f.writes.length;
    expect(await f.run(false)).toMatchObject({inserted:0,metadataChanged:false,marketingCorrected:0});expect(f.writes).toHaveLength(count);
  });

  it.each(["inventory","description","manual mapping","offering rule"])("refuses changed %s before writing",async kind=>{
    const f=fixture();
    if(kind==="inventory")f.rows.items.find(i=>i._id===cameraId).qty=4;
    if(kind==="description")f.rows.hygglo_products[0].description=f.rows.hygglo_products[0].description.replace("2x Rode","3x Rode");
    if(kind==="manual mapping")f.rows.listing_resolution_override.push({account_slug:"diogo",product_id:1173687,components:[],note:"Another operator's review",source:"manual_audit"});
    if(kind==="offering rule"){
      const preview=await f.run();f.rows.items.find(i=>i._id===cameraId).listing_stock_rules=[{title_pattern:"^"+data.products[0].name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"$",source:"Another rule",components:[],excludes:[]}];expect(preview.preview).toBe(true);
    }
    await expect(f.run(false)).rejects.toThrow();expect(f.writes).toEqual([]);
  });
  it("preserves an operator's deliberate marketing-only choice",async()=>{
    const f=fixture();f.rows.hygglo_products[1].isMarketingOnlyOverride=true;
    await expect(f.run(false)).rejects.toThrow("operator");expect(f.writes).toEqual([]);
  });
  it("keeps the physical-stock correction after the actual catalogue importer repeats its old automatic tag",async()=>{
    const f=fixture();await f.run(false);
    const products=data.products.map(p=>({...p,isMarketingOnly:true}));
    expect(await (upsertProductsBatch as any)._handler(f.ctx,{products})).toMatchObject({updated:2,inserted:0});
    expect(f.rows.hygglo_products.every(p=>p.isMarketingOnlyOverride===false&&p.isMarketingOnly===true)).toBe(true);
    expect(await f.run(false)).toMatchObject({marketingCorrected:0,metadataChanged:false,inserted:0});
  });

  it("does not apply the owner correction to another kit title",async()=>{
    const f=fixture();await f.run(false);const result=f.resolve(1173687,"Another GoPro kit");
    expect(result.applied_stock_rules).toEqual([]);expect(result.complete).toBe(false);
    expect(result.coverage?.missing.some(c=>c.item_id===audioId&&c.qty===2)).toBe(true);
  });

  it("exposes the owner confirmation and one-kit capacity through the real stock response",async()=>{
    const f=fixture();await f.run(false);
    const listing={...f.resolve(1173688),product_id:1173688,listing_name:data.products.find(p=>p.productId===1173688)!.name};
    const sources={items:f.rows.items,reservations:[],productIndex:new Map(),overrides:new Map(),claims:[],blackouts:[],vacations:[],checkoutHolds:[]};
    const result=listingStock(sources as any,listing,{item_name:listing.listing_name,start_date:"2026-11-15",end_date:"2026-11-15",quantity:1});
    expect(result.available).toBe(true);expect(result.free_units).toBe(1);expect(result.total_units).toBe(1);
    expect(result.components.find(c=>c.item_name==="Rode Wireless Mic Pro set")?.requested_units).toBe(1);
    expect(result.stock_corrections?.[0].source).toContain("ONE RODE Wireless PRO kit");
  });

  it("requires explicit opt-in to apply a master's rule through declared contents",async()=>{
    const f=fixture();await f.run(false);for(const rule of f.rows.items.find(i=>i._id===cameraId).listing_stock_rules)delete rule.apply_to_declared_component;
    expect(f.resolve(1173687).applied_stock_rules).toEqual([]);expect(f.resolve(1173687).complete).toBe(false);
  });

  it.each(["4x mini camera stands","3x C-stands"])("does not cover changed supplied gear: %s",async line=>{
    const f=fixture();await f.run(false);const product=f.rows.hygglo_products.find(x=>x.productId===1173687),result=f.resolve(1173687,undefined,product.description.replace("3x mini camera stands",line));
    expect(result.complete).toBe(false);expect(result.coverage?.unresolved.length).toBeGreaterThan(0);
  });
});

describe("supplied cases and microSD cards",()=>{
  const items=data.items as any;
  it("does not count the actual RGB kit's charging case as a third microphone system",()=>{
    const result=resolveBundleMapping(data.products.find(p=>p.productId===1173688)!.description,items);
    expect(result.components.find(c=>c.item_id===audioId)?.qty).toBe(2);
    expect(result.unmatched).not.toContain("1x Hard charging case for the Rode Wireless Pro systems");
    expect(result.unmatched.some(x=>/microSD|carry bag/i.test(x))).toBe(false);
  });
  it("a carry bag for lights is not another lighting unit",()=>{
    expect(resolveBundleMapping("Included in this kit:\n1x GVM carry bag for the lights",items).components).toEqual([]);
  });
  it("preserves an entire camera supplied with its carry bag",()=>{
    expect(resolveBundleMapping("Included in this kit:\n1x GoPro HERO12 Black with carrying bag",items).components.map(c=>c.item_id)).toEqual([cameraId]);
  });
  it("preserves the microphone kit when the charging case is added after it",()=>{
    expect(resolveBundleMapping("Included in this kit:\n1x Rode Wireless PRO and charging case",items).components.map(c=>[c.item_id,c.qty])).toEqual([[audioId,1]]);
  });
  it("can still count an explicitly registered independent charging case",()=>{
    const item={_id:"case",name_canonical:"Rode Wireless PRO charging case",kind:"accessory",qty:1,status:"active",is_marketing_only:false};
    const result=resolveBundleMapping("Included in this kit:\n1x Rode Wireless PRO charging case",[...items,item]);
    expect(result.components.map(c=>[c.item_id,c.qty])).toEqual([["case",1]]);
  });
  it("does not hide equipment bundled with a named charging case",()=>{
    const item={_id:"case",name_canonical:"Rode Wireless PRO charging case",kind:"accessory",qty:1,status:"active",is_marketing_only:false};
    const result=resolveBundleMapping("Included in this kit:\n1x Rode Wireless PRO charging case with Sony FX3 camera",[...items,item]);
    expect(result.components).toEqual([]);expect(result.unmatched).toHaveLength(1);
  });
});
