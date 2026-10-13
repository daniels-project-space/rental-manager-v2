import fs from "node:fs";
import {describe,it,expect,vi} from 'vitest';
vi.mock('./auth',()=>({authComponent:{safeGetAuthUser:vi.fn()}}));
import {assembleTile} from './replyInbox';
import {listingDisplayCatalog} from './lib/listing_display_catalog';
import source from './fixtures/quick-reply-source-kit.json';
function fixture(last:'owner'|'renter'='owner'){
 const products=source.products.map((p,n)=>({...p,images:[{thumbnailUrl:`/diogo-${n}.png`,fullSizeUrl:`/diogo-full-${n}.png`}]}));
 const rows:Record<string,any[]>={items:source.items.map(i=>({...i,image_url:'/foreign-catalog.png'})),hygglo_products:products,listing_resolution_override:source.overrides,
  hygglo_messages:[{thread_id:'case',message_id:'old',sender:last==='owner'?'renter':'owner',hygglo_sent_at:100,fetched_at:500,body_text:'BMPCC 6K Pro and Tilta shoulder rig'},
   {thread_id:'case',message_id:'new',sender:last,hygglo_sent_at:200,fetched_at:200,body_text:'Latest genuine message'}]};
 const ctx:any={db:{query(table:string){let data=[...(rows[table]??[])];let index='';const q:any={withIndex(name:string,fn:any){index=name;const r:any={eq(k:string,v:any){data=data.filter(d=>d[k]===v);return r}};fn?.(r);return q},order(){if(index==='by_thread_and_sent_at')data.sort((a,b)=>b.hygglo_sent_at-a.hygglo_sent_at);return q},collect:async()=>data,take:async(n:number)=>data.slice(0,n),first:async()=>data[0]??null,unique:async()=>data[0]??null};return q},get:async()=>null,patch:vi.fn(()=>{throw Error('No source writes')})}};
 const reservation:any={account_slug:'diogo',hygglo_items:products.map(p=>({name:p.name,product_id:p.productId,qty:1})),status:'confirmed',start_date:'2026-11-15',end_date:'2026-11-17',renter_name:'Chantal',created_at:1};
 const conv:any={account_slug:'diogo',last_sender:last==='owner'?'renter':'owner',last_msg_at:999,inquiry_items:[{name:'BMPCC 6K Pro',image_url:'/foreign-inquiry.png',qty:1}]};
 return {ctx,reservation,conv,rows};
}
describe('actual reply tile account photos and chronology',()=>{
 it('uses the six basket photos belonging to the requested account without global or duplicate chat photos',async()=>{
  const f=fixture(),display=await listingDisplayCatalog(f.ctx);const tile=await assembleTile(f.ctx,f.conv,f.reservation,'case',undefined,undefined,undefined,display);
  expect(tile.requested_items).toHaveLength(6);
  expect(tile.requested_items.map(i=>i.image_url)).toEqual(source.products.map((_,n)=>`/diogo-${n}.png`));
  expect(tile.requested_items.flatMap(i=>i.image_urls??[]).some(url=>url.includes('foreign'))).toBe(false);
  expect(f.ctx.db.patch).not.toHaveBeenCalled();
  if(process.env.RM_QA_SOURCE_CASE){
    const {check}=await import('./quick_reply_basket_stock');
    const stock=await (check as any)._handler(f.ctx,{account_slug:'diogo',thread_id:'case',start:'2026-11-15',end:'2026-11-17',include_line_checks:true,lines:source.products.map(p=>({name:p.name,qty:1,product_id:p.productId}))});
    const image=(url:string)=>url.replace(/\/diogo-(?:full-)?(\d+)\.png/,'/gear$1.png');
    const items=tile.items.map(i=>({...i,image_url:i.image_url?image(i.image_url):null,image_urls:i.image_urls?.map(image)}));
    const requested=tile.requested_items.map(i=>({...i,image_url:i.image_url?image(i.image_url):null,image_urls:i.image_urls?.map(image)}));
    fs.writeFileSync(process.env.RM_QA_SOURCE_CASE,JSON.stringify({...tile,thread_id:'fixture-0',renter_identity:'source-chantal',renter_image_url:'/face0.png',items,requested_items:requested,net_to_owner_gbp:9999,last_renter_msg_at:Date.now()-900000,last_activity_at:Date.now()-600000,availability:{status:stock.available===false?'conflict':'available',include_pending:true,checked_at:Date.now(),stock_rules_version:5,items:stock.line_checks.map((r:any)=>({...r,name:source.products[r.item_index].name,requested:1,booked:0,free:r.available?1:0,total_units:r.available?1:0,reason:r.available?undefined:'Marketing-only listing · not stocked for hire'}))}},null,2));
  }
 });
 it.each(['owner','renter'] as const)('uses newest genuine %s message despite stale conversation role and newer ingestion',async last=>{
  const f=fixture(last);const tile=await assembleTile(f.ctx,f.conv,f.reservation,'case');
  expect(tile.last_sender).toBe(last);expect(tile.preview).toBe('Latest genuine message');
 });
 it('finds a newer owner reply behind a large backfill through the provider-time index',async()=>{
  const f=fixture();f.rows.hygglo_messages.unshift(...Array.from({length:80},(_,n)=>({thread_id:'case',message_id:`backfill-${n}`,sender:'renter',hygglo_sent_at:10+n,fetched_at:1000+n,body_text:'Old history'})));
  const tile=await assembleTile(f.ctx,f.conv,f.reservation,'case');expect(tile.last_sender).toBe('owner');expect(tile.preview).toBe('Latest genuine message');
 });
});
