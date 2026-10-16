import {describe,it,expect} from 'vitest';
import fixture from '../fixtures/owner-confirmed-availability-20261015.json';
import {ownerAvailabilityReview} from './owner_availability_review';
import {resolveListingComponents} from './listing_components';
import {canonicalListingAllocation} from './canonical_listing_allocation';
import {reservationItemUnits} from './reservations/itemUnits';
const snapshot=()=>JSON.parse(JSON.stringify(fixture)) as any;
function corrected(){const data=snapshot(),plan=ownerAvailabilityReview(data.items,data.records.map((r:any)=>r.product));for(const p of plan.items)Object.assign(data.items.find((i:any)=>i._id===p.id),p.patch);for(const p of plan.products)Object.assign(data.records.find((r:any)=>r.product._id===p.id).product,p.patch);return {data,plan};}
function resolved(data:any,account:string,id:number){const r=data.records.find((r:any)=>r.key.account===account&&r.key.productId===id);return resolveListingComponents(data.items,r.override??undefined,r.product.masterItemId,1,r.product.description??r.description,undefined,r.product.name);}
describe('owner-confirmed availability and real catalogue regressions',()=>{
 it('is pure, bounded in scope, and idempotent without changing owned quantities',()=>{
  const before=snapshot(),serialized=JSON.stringify(before);ownerAvailabilityReview(before.items,before.records.map((r:any)=>r.product));expect(JSON.stringify(before)).toBe(serialized);
  const {data,plan}=corrected();expect(plan.items).toHaveLength(10);expect(data.items.map((i:any)=>i.qty)).toEqual(before.items.map((i:any)=>i.qty));expect(ownerAvailabilityReview(data.items,data.records.map((r:any)=>r.product))).toEqual({items:[],products:[]});
 });
 it('remains idempotent after database serialization reorders nested object keys',()=>{
  const {data}=corrected();
  const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>b.localeCompare(a)).map(([key,entry])=>[key,reorder(entry)])):value;
  const stored=reorder(data);expect(ownerAvailabilityReview(stored.items,stored.records.map((r:any)=>r.product))).toEqual({items:[],products:[]});
 });
 it('qualifies all 44 previously unresolved enquiry/listing records from current stock or explicit non-ownership',()=>{
  const {data}=corrected();expect(data.records).toHaveLength(44);
  for(const r of data.records){const q=resolved(data,r.key.account,r.key.productId);expect((r.product.isMarketingOnlyOverride??r.product.isMarketingOnly)===true||q.owned===false||q.complete&&q.owned===true,`${r.key.account}#${r.key.productId}: ${JSON.stringify(q.coverage)}`).toBe(true);}
 });
 it('retains model distinctions and never borrows the boom mic, Vespids, RGB panels or RS3 for unowned models',()=>{
  const {data}=corrected();for(const id of [1028831,1173851,1173859,1172669,1173523,1173744,1172820])expect(data.records.find((r:any)=>r.key.productId===id).product.isMarketingOnlyOverride).toBe(true);
  expect(data.items.find((i:any)=>i.name_canonical==='DJI RS3 Pro gimbal')).toMatchObject({qty:2,is_marketing_only:false});
 });
 it('does not classify a genuine RS3 listing or spare battery from trailing RS2 compatibility keywords',()=>{
  const data=snapshot(),products=data.records.map((r:any)=>r.product),base=products[0];
  for(const [id,name] of [[900001,'DJI RS3 Gimbal | Ronin Stabilizer, RS2, RS4'],[900002,'DJI Ronin RS2 RS3 Pro Gimbal Battery']])products.push({...base,_id:String(id),productId:id,name,isMarketingOnly:false,isMarketingOnlyOverride:false});
  expect(ownerAvailabilityReview(data.items,products).products.some(p=>p.productId===900001||p.productId===900002)).toBe(false);
 });
 it('holds both speakers and both camera/lens units despite malformed legacy wrapper counts',()=>{
  const {data}=corrected();expect(resolved(data,'leo',1172801)).toMatchObject({complete:true,owned:true,components:[{name:'JBL Club 120 speaker',units_per_listing:2}]});
  expect(resolved(data,'leo',1172559).components).toEqual(expect.arrayContaining([expect.objectContaining({name:'Sony FX3',units_per_listing:2}),expect.objectContaining({name:'Sony GM 24-70mm f2.8',units_per_listing:2})]));
  expect(resolved(data,'leo',1172383)).toMatchObject({complete:true,components:[{name:'DJI Osmo Action Pro 5',units_per_listing:3},{name:'Suction cups',units_per_listing:3}]});
 });
 it('uses only the owner-confirmed 16–35 lens and makes the XLR handle optional',()=>{
  const {data}=corrected(),wide=resolved(data,'leo',1172943),zoom=resolved(data,'diogo',1173773);
  expect(wide.complete).toBe(true);expect(wide.components.some(c=>c.name?.includes('24-70'))).toBe(false);expect(wide.components).toEqual(expect.arrayContaining([expect.objectContaining({name:'Sony FX3'}),expect.objectContaining({name:'Sony GM 16-35mm f2.8'})]));
  expect(zoom).toMatchObject({complete:true,owned:true});expect(zoom.coverage?.unresolved).toEqual([]);
 });
 it('counts three physical CFexpress cards, not a second card for each supplied reader',()=>{
  const {data}=corrected(),card=data.items.find((i:any)=>i.name_canonical==='CF Express Type A card');expect(card).toMatchObject({qty:3,track_independent_stock:true});
  const standalone=resolved(data,'diogo',1173793);expect(standalone).toMatchObject({complete:true,owned:true,components:[{name:'CF Express Type A card',units_per_listing:1,stock_required:true}]});
  const fx3=data.items.find((i:any)=>i.name_canonical==='Sony FX3');const allocation=reservationItemUnits({resolved_items:[{item_id:fx3._id,qty:2},{item_id:card._id,qty:1}]},new Map(),undefined,data.items);expect(allocation.get(card._id)).toBe(2);
 });
 it('uses the same complete corrected kit allocation for occupancy',()=>{
  const {data}=corrected(),record=data.records.find((r:any)=>r.key.productId===1172943),q=resolved(data,'leo',1172943);
  const allocation=canonicalListingAllocation(data.items,[],[record.product],[]);expect(allocation.get('leo#1172943')).toEqual(q.components.map(c=>({item_id:c.item_id,qty:c.units_per_listing})));
 });
});
