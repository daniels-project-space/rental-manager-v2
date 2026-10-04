import {describe,it,expect} from 'vitest';
import {loadPagedFunnelSources,projectFunnelSource,type FunnelSource} from './funnel_sources';
import {buildThreadContacts,computeConversationFunnel,indexReservationsByOrderId} from './conversation_funnel';

const DAY=86400000,now=Date.UTC(2026,9,4);
const rows:Record<FunnelSource,Record<string,unknown>[]>={
 hygglo_messages:[
  {thread_id:'owned',account_slug:'leo',sender:'owner',hygglo_sent_at:now-6*DAY,fetched_at:now,body:'private'},
  {thread_id:'owned',account_slug:'leo',sender:'renter',hygglo_sent_at:now-2*DAY,fetched_at:now},
  {thread_id:'marketing',account_slug:'leo',sender:'renter',hygglo_sent_at:now-2*DAY,fetched_at:now},
  {thread_id:'owned',account_slug:'leo',sender:'renter',hygglo_sent_at:now-4*DAY,fetched_at:now},
  {thread_id:'owned',account_slug:'leo',sender:'owner',hygglo_sent_at:now-3*DAY,fetched_at:now},
 ],
 reservations:[{hygglo_order_id:'owned',account_slug:'leo',status:'confirmed',net_to_owner_gbp:100},{hygglo_order_id:'marketing',account_slug:'leo',status:'declined',hygglo_system_signal:'owner_denied',hygglo_items:[{product_id:1}]}],
 items:[{_id:'owned',name_canonical:'Sony FX3',status:'active',qty:1},{_id:'marketing',name_canonical:'Canon R5',is_marketing_only:true,status:'active',qty:1}],
 hygglo_product_index:[{account_slug:'leo',product_id:1,item_id:'owned'}],
 listing_resolution_override:[{account_slug:'leo',product_id:1,components:[{item_id:'owned',qty:1}]}],
 online_listings:[{account_slug:'leo',product_id:1,description:'Included in this rental: • 1x Canon R5'}],
};
const context=()=>({runQuery:async(_fn:unknown,args:Record<string,unknown>)=>{
 const {cursor}=args.paginationOpts as {cursor:string|null};expect(args.asOf).toBe(now);
 const table=args.table as FunnelSource,at=Number(cursor??0),end=Math.min(rows[table].length,at+1);
 return {page:rows[table].slice(at,end).map(r=>projectFunnelSource(table,r)),isDone:end===rows[table].length,continueCursor:String(end)};
}});
describe('whole-history paginated funnel inputs',()=>{
 it('preserves older first contact and the first valid reply across pages',async()=>{
  const source=await loadPagedFunnelSources(context(),now);
  const contacts=buildThreadContacts(source.messages);
  expect(contacts.find(c=>c.threadId==='owned')).toMatchObject({firstRenterAt:now-4*DAY,firstOwnerReplyAt:now-3*DAY});
  expect(source.counts.hygglo_messages).toEqual({rows:5,pages:5});
  expect(source.messages).toHaveLength(5);
  expect(source.messages.some(m=>'body' in m)).toBe(false);
  const funnel=computeConversationFunnel({threads:contacts,reservationsByOrderId:indexReservationsByOrderId(source.reservations),marketingOnlyRequestIds:source.marketingOnlyRequestIds,now,days:7,accountSlug:null});
  expect(funnel).toMatchObject({inquiries:1,requests:1,booked:1,booked_net_gbp:100,excluded_marketing_only:1});
 });
 it('fails the pass if a page cannot be read',async()=>{
  const ctx=context(),run=ctx.runQuery;
  ctx.runQuery=async(fn,args)=>{if(args.table==='hygglo_messages'&&(args.paginationOpts as {cursor:string}).cursor==='2')throw new Error('page unavailable');return run(fn,args);};
  await expect(loadPagedFunnelSources(ctx,now)).rejects.toThrow('page unavailable');
 });
 it('rejects a stuck cursor instead of publishing a truncated history',async()=>{
  const ctx=context();ctx.runQuery=async(_fn,args)=>({page:[],isDone:false,continueCursor:(args.paginationOpts as {cursor:string}).cursor});
  await expect(loadPagedFunnelSources(ctx,now)).rejects.toThrow('pagination did not advance');
 });
});
