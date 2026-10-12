import {describe,it,expect,vi} from 'vitest';
import {check} from './quick_reply_basket_stock';
import data from './fixtures/quick-reply-source-kit.json';
/** Actual registered stock handler and real source-shaped gear; no transports or writes. */
function context(extra:Record<string,any[]>={}){
 const tables:Record<string,any[]>={items:data.items,hygglo_products:data.products,listing_resolution_override:data.overrides,...extra};
 const query=(table:string)=>{
  let rows=[...(tables[table]??[])];const api:any={
   withIndex(_name:string,fn:any){const q:any={eq(field:string,value:any){rows=rows.filter(r=>r[field]===value);return q}};fn?.(q);return api},
   collect:async()=>rows,first:async()=>rows[0]??null,unique:async()=>rows[0]??null,take:async(n:number)=>rows.slice(0,n),paginate:async()=>({page:rows,isDone:true,continueCursor:""}),
  };return api;
 };
 return {db:{query,get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null},runMutation:vi.fn(()=>{throw Error('No source writes')})};
}
const args={account_slug:'diogo',thread_id:'synthetic-order',start:'2026-11-15',end:'2026-11-17',include_line_checks:true,lines:data.products.map(p=>({name:p.name,qty:1,product_id:p.productId}))};
describe('source kit identity and unavailable marketing line',()=>{
 it('resolves every retained source item while the unowned light remains unavailable',async()=>{
  const ctx=context();const r=await (check as any)._handler(ctx,args);
  expect(r.available).toBe(false);
  const marketing=data.products.find(p=>p.isMarketingOnly)!;
  expect(r.line_checks).toEqual(data.products.map((p,item_index)=>({item_index,available:p.productId!==marketing.productId})));
  expect(ctx.runMutation).not.toHaveBeenCalled();
 });
 it('keeps an unknown extra model unknown while retaining known line results',async()=>{
  const r=await (check as any)._handler(context(),{...args,lines:[...args.lines,{name:'Unrecorded model',qty:1,product_id:999}]});
  expect(r.line_checks.slice(0,6)).toEqual(data.products.map((p,item_index)=>({item_index,available:!p.isMarketingOnly})));
  expect(r.line_checks[6].available).toBeNull();
 });
 it('checks the aggregate demand, including two requests for the same counted mic kit',async()=>{
  const mic=data.products.find(p=>p.name.startsWith('Rode'))!;
  const r=await (check as any)._handler(context(),{...args,lines:[{name:mic.name,qty:1,product_id:mic.productId},{name:mic.name,qty:1,product_id:mic.productId}]});
  expect(r.available).toBe(false);expect(r.line_checks.map((r:any)=>r.available)).toEqual([false,false]);
 });
});

import {resolveListingComponents} from './lib/listing_components';
describe('recorded supplies of an owned lighting unit',()=>{
 const light:any=data.items.find(i=>i.name_canonical==='Nanlite Forza 300')!;
 const kit='In this kit:\n- 1x Nanlite Forza 300 light\n- 1x light stand\n- 1x reflector';
 it('uses exact supplies recorded for that named physical unit',()=>{
  const r=resolveListingComponents([light],undefined,light._id,1,kit);
  expect(r.complete).toBe(true);expect(r.components[0].units_per_listing).toBe(1);
 });
 it('does not invent an unrecorded stand',()=>{
  const r=resolveListingComponents([{...light,compatibility:null}],undefined,light._id,1,kit);
  expect(r.complete).toBe(false);expect(r.coverage?.unresolved).toContain('1x light stand');
 });
 it('does not equate a named different stand with the generic recorded supply',()=>{
  expect(resolveListingComponents([light],undefined,light._id,1,kit.replace('light stand','Manfrotto 1004 stand')).complete).toBe(false);
 });
 it('counts extra recorded parts against their parent units without changing stock',()=>{
  const r=resolveListingComponents([light],undefined,light._id,1,kit.replace('1x light stand','2x light stand'));
  expect(r.components[0].units_per_listing).toBe(2);expect(light.qty).toBe(1);
 });
 it('preserves a deliberate owner exclusion',()=>{
  expect(resolveListingComponents([light],[],light._id,1,kit).owned).toBe(false);
 });
});

import {declaredLensIdentity} from './lib/declared_lens_identity';
it('keeps explicit L-mount and lens generation distinct from the owned EF lens',()=>{
 const lens:any=data.items.find(i=>i.name_canonical==='Canon EF 24-105mm f4')!;
 expect(declaredLensIdentity('Canon 24-105mm f4 L-Mount lens',[lens]).item).toBeNull();
 expect(declaredLensIdentity('Canon EF 24-105mm f4 L II IS USM lens',[lens]).item).toBeNull();
 expect(declaredLensIdentity('Canon EF 24-105mm f4 L IS USM lens',[lens]).item?._id).toBe(lens._id);
});

import {loadListingInventory} from './lib/listing_inventory';
import {listingReplacementCandidates} from './lib/listing_replacement_candidates';
it('retains an unavailable marketing model as a replacement target while keeping it unbookable',async()=>{
 const original=data.products.find(p=>p.isMarketingOnly)!;
 const lamp=data.items.find(i=>i.name_canonical==='Nanlite Forza 300')!;
 const originalPool=data.overrides.find(o=>o.product_id===original.productId)!.components[0].item_id;
 const candidate:any={_id:'synthetic-offer',accountSlug:'diogo',productId:991,name:'Nanlite Forza 300 kit',masterItemId:lamp._id,isMarketingOnly:false,description:'In this kit:\n- 1x Nanlite Forza 300 light\n- 1x light stand\n- 1x reflector'};
 const ctx=context({items:data.items.map(i=>({...i,replacement_cost_gbp:i._id===originalPool?1000:100})),hygglo_products:[...data.products,candidate],online_listings:[{_id:'original-offer',account_slug:'diogo',product_id:original.productId,name:original.name,daily_price:30},{_id:'candidate-offer',account_slug:'diogo',product_id:991,name:candidate.name,description:candidate.description,daily_price:20,is_published:true}],listing_resolution_override:[...data.overrides,{_id:'candidate-map',account_slug:'diogo',product_id:991,components:[{item_id:lamp._id,qty:1}]}]});
 const unavailable=await loadListingInventory(ctx as any,'diogo',original.productId);
 expect(unavailable.owned).toBe(false);expect(unavailable.components).toEqual([]);
 expect(unavailable.requested_mapping_complete).toBe(true);expect(unavailable.requested_components[0].kind).toBe('lighting');
 const options=await listingReplacementCandidates(ctx as any,{account_slug:'diogo',target_product_id:original.productId,item_name:original.name,start_date:args.start,end_date:args.end,quantity:1,thread_id:'synthetic-order'} as any);
 expect(options.alternatives.map((a:any)=>a.product_id)).toEqual([991]);expect(options.alternatives[0].availability.available).toBe(true);expect(ctx.runMutation).not.toHaveBeenCalled();
});
