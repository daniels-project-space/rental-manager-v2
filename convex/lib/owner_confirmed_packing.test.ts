import {describe,it,expect} from 'vitest';
import fixture from '../fixtures/owner-confirmed-packing-20261016.json';
import {ownerAvailabilityReview} from './owner_availability_review';
import {resolveListingComponents} from './listing_components';
import {resolvedMarketingOnly} from './power_listing_identity';
import {reservationItemUnits} from './reservations/itemUnits';
import {listingKitContext,listingKitItem} from './listing_kit_context';
import {get_listing_context} from '../renter_bot_tools';
import {__service_catalogueForStorefront} from '../hygglo_products';
function corrected(){const data=structuredClone(fixture) as any;const plan=ownerAvailabilityReview(data.items,data.products);for(const p of plan.items)Object.assign(data.items.find((i:any)=>i._id===p.id),p.patch);for(const p of plan.products)Object.assign(data.products.find((i:any)=>i._id===p.id),p.patch);return {data,plan};}
describe('owner confirmed packing on 16 October',()=>{
 it('reaches the registered Rental Bot query and website bridge from the same current records without writes',async()=>{
  const {data}=corrected();
  const tables:any={items:data.items,hygglo_products:data.products,online_listings:data.products.map((p:any)=>({account_slug:p.accountSlug,product_id:p.productId,name:p.name,description:p.description})),conversations:[]};
  const db:any={get:async(id:string)=>data.items.find((i:any)=>i._id===id)??null,query:(table:string)=>{let rows=tables[table]??[];const q:any={withIndex:(_:string,select:any)=>{const index:any={eq:(key:string,value:any)=>{rows=rows.filter((r:any)=>r[key]===value);return index}};select(index);return q},collect:async()=>rows,first:async()=>rows[0]??null,unique:async()=>rows[0]??null,order:()=>q,take:async(n:number)=>rows.slice(0,n)};return q}};
  const before=JSON.stringify(data);
  const exported=await(__service_catalogueForStorefront as any)._handler({db},{accountSlug:'dbcinema'});
  for(const p of data.products.filter((p:any)=>/A7 V|Alpha 7 V|Pyro S/.test(p.name))){
   tables.conversations=[{thread_id:'fixture-inventory',account_slug:p.accountSlug,inquiry_items:[{name:p.name,qty:1,product_id:p.productId}]}];
   const result=await(get_listing_context as any)._handler({db},{thread_id:'fixture-inventory'});
   expect(result.items[0].owned,p.name).toBe(true);expect(result.items[0].storage_contents_verification_required,p.name).toBe(false);
   if(/A7 V|Alpha 7 V/.test(p.name))expect(result.items[0].kit_contents.join(' ')).toContain('256GB SDXC V90');
   if(/Pyro S/.test(p.name))expect(result.items[0].kit_contents.join(' ')).toContain('Pyro S Receiver');
   if(p.accountSlug==='dbcinema')expect(exported.find((r:any)=>r.productId===p.productId).stockMapping.inventoryFacts.contents).toEqual(result.items[0].kit_contents);
  }
  expect(JSON.stringify(data)).toBe(before);
 });
 it('carries the confirmed SD format and rating into actual bot kit context without a new owner question',async()=>{
  const {data}=corrected();const ctx:any={db:{query:()=>({withIndex:()=>({collect:async()=>[]})})}};
  for(const p of data.products.filter((p:any)=>/A7 V|Alpha 7 V/.test(p.name))){
   const q=resolveListingComponents(data.items,undefined,p.masterItemId,1,p.description,undefined,p.name);
   const k=await listingKitContext(ctx,p.accountSlug,listingKitItem(q,data.items),q.components,data.items);
   expect(k.kit.contents.join(' '),p.name).toContain('256GB SDXC V90');expect(k.contents_review_required,p.name).toBe(false);
  }
 });
 it('uses one real 256GB SD card, never a CFexpress card for the A7 V',()=>{
  const {data}=corrected();const a7=data.items.find((i:any)=>i.name_canonical==='Sony A7 V'),sd=data.items.find((i:any)=>i.name_canonical==='256GB card'),cf=data.items.find((i:any)=>i.name_canonical==='CF Express Type A card');
  expect(a7.compatibility.included_with_rental).toContain('1x 256GB SDXC V90 card');expect(a7.supplied_stock).toEqual([{item_id:sd._id,qty:1,source:expect.any(String)}]);
  const units=reservationItemUnits({resolved_items:[{item_id:a7._id,qty:1}]},new Map(),undefined,data.items);expect(units.get(sd._id)).toBe(1);expect(units.has(cf._id)).toBe(false);expect(sd.qty).toBe(3);
 });
 it('resolves both Pyro S offers across accounts without holding a Mars or inventing receivers',()=>{
  const {data}=corrected();const pyro=data.items.find((i:any)=>i.name_canonical==='Hollyland Pyro S transmitter');
  for(const p of data.products.filter((p:any)=>/Pyro S/.test(p.name))){
   const q=resolveListingComponents(data.items,undefined,p.masterItemId,1,p.description,undefined,p.name);
   expect(q,JSON.stringify(q.coverage)).toMatchObject({complete:true,owned:true});
   expect(resolvedMarketingOnly(p,q,data.items)).toBe(false);
   expect(resolvedMarketingOnly({...p,isMarketingOnlyOverride:true},q,data.items)).toBe(true);
   expect(resolvedMarketingOnly(p,{...q,complete:false},data.items)).toBe(!!p.isMarketingOnly);
   expect(q.components).toEqual(expect.arrayContaining([expect.objectContaining({item_id:pyro._id,units_per_listing:1})]));
   expect(q.components.some(c=>/Mars/.test(c.name??''))).toBe(false);
   expect(q.components.some(c=>/receiver/i.test(c.name??''))).toBe(false);
  }
  expect(pyro.qty).toBe(1);
 });
 it('resolves every A7 V offer against its true body and SD allocation',()=>{
  const {data}=corrected(),a7=data.items.find((i:any)=>i.name_canonical==='Sony A7 V');
  for(const p of data.products.filter((p:any)=>/A7 V|Alpha 7 V/.test(p.name))){
   const q=resolveListingComponents(data.items,undefined,p.masterItemId,1,p.description,undefined,p.name);
   expect(q,`${p.accountSlug}#${p.productId}: ${JSON.stringify(q.coverage)}`).toMatchObject({complete:true,owned:true});
  }
 });
 it('records original GM generation, preserves every quantity and is idempotent',()=>{
  const {data}=corrected();expect(data.items.map((i:any)=>i.qty)).toEqual(fixture.items.map(i=>i.qty));expect(ownerAvailabilityReview(data.items,data.products)).toEqual({items:[],products:[]});
  expect(data.items.find((i:any)=>i.name_canonical==='Sony GM 70-200mm f2.8')).toMatchObject({qty:2,notes:expect.stringContaining('SEL70200GM')});
 });
});
