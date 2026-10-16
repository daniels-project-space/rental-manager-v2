import {describe,it,expect} from 'vitest';
import fixture from '../fixtures/owner-confirmed-packing-20261016.json';
import {ownerAvailabilityReview} from './owner_availability_review';
import {resolveListingComponents} from './listing_components';
import {reservationItemUnits} from './reservations/itemUnits';
function corrected(){const data=structuredClone(fixture) as any;const plan=ownerAvailabilityReview(data.items,data.products);for(const p of plan.items)Object.assign(data.items.find((i:any)=>i._id===p.id),p.patch);for(const p of plan.products)Object.assign(data.products.find((i:any)=>i._id===p.id),p.patch);return {data,plan};}
describe('owner confirmed packing on 16 October',()=>{
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
   expect(q.components).toEqual(expect.arrayContaining([expect.objectContaining({item_id:pyro._id,units_per_listing:1})]));
   expect(q.components.some(c=>/Mars/.test(c.name??''))).toBe(false);
   expect(q.components.some(c=>/receiver/i.test(c.name??''))).toBe(false);
  }
  expect(pyro.qty).toBe(1);
 });
 it('records original GM generation, preserves every quantity and is idempotent',()=>{
  const {data}=corrected();expect(data.items.map((i:any)=>i.qty)).toEqual(fixture.items.map(i=>i.qty));expect(ownerAvailabilityReview(data.items,data.products)).toEqual({items:[],products:[]});
  expect(data.items.find((i:any)=>i.name_canonical==='Sony GM 70-200mm f2.8')).toMatchObject({qty:2,notes:expect.stringContaining('SEL70200GM')});
 });
});
