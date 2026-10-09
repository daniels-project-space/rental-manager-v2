import {describe,expect,it} from 'vitest';
import {resolveListingComponents} from './listing_inventory';
import {resolveBundleMapping} from './bundle_mapping';
import descriptions from '../fixtures/sony-gm-listing-descriptions.json';
const description=(id:number)=>descriptions.find(d=>d.id===id)!.description;
const lens:any={_id:'lens',name_canonical:'Sony GM 24-70mm f2.8',aliases:['Sony 24-70mm f2.8 GM'],kind:'lens',qty:4,status:'active',is_marketing_only:false};
const nd:any={_id:'nd',name_canonical:'ND filter',kind:'accessory',qty:3,status:'active',is_marketing_only:false};
describe('real Sony G Master catalogue declarations',()=>{
 it.each([[973616,1],[1103079,3]])('certifies the recorded %s override with intact provider contents', (id,qty)=>{
  const result=resolveListingComponents([lens],[{item_id:'lens',qty}], 'lens',1,description(id));
  expect(result).toMatchObject({complete:true,owned:true,coverage:{missing:[],unresolved:[],structured:true}});
  expect(result.components).toMatchObject([{item_id:'lens',units_per_listing:qty,stock_required:true}]);
 });
 it('expands a verified three-lens declaration without changing the owned quantity',()=>{
  expect(resolveListingComponents([lens],[{item_id:'lens',qty:1}],'lens',1,description(1103079))).toMatchObject({complete:true,components:[{item_id:'lens',units_per_listing:3}],coverage:{missing:[]}});
 });
 it('keeps the independently stocked ND filter required in the newline contents',()=>{
  expect(resolveListingComponents([lens,nd],[{item_id:'lens',qty:1},{item_id:'nd',qty:1}],'lens',1,description(1048233))).toMatchObject({complete:true,components:[{item_id:'lens',stock_required:true},{item_id:'nd',stock_required:true}]});
  expect(resolveListingComponents([lens,nd],[{item_id:'lens',qty:1}],'lens',1,description(1048233))).toMatchObject({complete:true,components:[{item_id:'lens',stock_required:true},{item_id:'nd',units_per_listing:1,stock_required:true}],coverage:{missing:[]}});
 });
 it('does not certify the two-lens listing from its primary match alone',()=>{
  expect(resolveListingComponents([lens],undefined,'lens',1,description(971143))).toMatchObject({complete:false,owned:null});
  expect(resolveListingComponents([lens],[{item_id:'lens',qty:2}],'lens',1,description(971143))).toMatchObject({complete:true,components:[{units_per_listing:2}]});
 });
 it('never discards a recorded independently stocked UV filter',()=>{
  const uv:any={_id:'uv',name_canonical:'UV filter',kind:'accessory',qty:1,status:'active',is_marketing_only:false,track_independent_stock:true};
  expect(resolveListingComponents([lens,uv],[{item_id:'lens',qty:1}],'lens',1,description(973616))).toMatchObject({complete:true,components:[{item_id:'lens',stock_required:true},{item_id:'uv',units_per_listing:1,stock_required:true}],coverage:{missing:[]}});
  expect(resolveListingComponents([lens,{...uv,is_marketing_only:true}],[{item_id:'lens',qty:1}],'lens',1,description(973616))).toMatchObject({owned:false,ownership_blockers:[{item_id:'uv',reason:'marketing_only'}]});
 });
 it('keeps duplicate G Master aliases ambiguous rather than choosing a stock pool',()=>{
  const duplicate={...lens,_id:'other',name_canonical:'Sony GM II 24-70mm f2.8'};
  expect(resolveBundleMapping(description(973616),[lens,duplicate]).unmatched).toContain('1x Sony 24-70mm f2.8 G master Lens');
 });
 it('does not treat feature bullets or paid camera upgrades as lens contents',()=>{
  const body:any={_id:'body',name_canonical:'Sony a7siii',kind:'camera',qty:0,status:'active',is_marketing_only:true};
  expect(resolveBundleMapping(description(1103079),[lens])).toMatchObject({components:[{item_id:'lens',qty:3}],unmatched:[]});
  expect(resolveListingComponents([lens,body],[{item_id:'lens',qty:1}],'lens',1,description(973616))).toMatchObject({complete:true,owned:true,ownership_blockers:[]});
 });
});
