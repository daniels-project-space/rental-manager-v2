import { describe, it, expect, vi } from "vitest";
import { receive } from "./dbcinema_notifications";
import { listRecent, markAllRead } from "./notifications";
import { subscriptionReceivesNotification,notificationHasIncome } from "./lib/notification_events";
function fixture(){
 const rows:any[]=[];let serial=0;
 const ctx:any={scheduler:{runAfter:vi.fn()},db:{insert:async(table:string,value:any)=>{const row={...value,_id:String(++serial),table};rows.push(row);return row._id;},patch:async(id:string,value:any)=>Object.assign(rows.find(r=>r._id===id),value),query:(table:string)=>{
  const filters:((r:any)=>boolean)[]=[];let descending=false;
  const q:any={withIndex:(_name:string,select?:any)=>{const b:any={eq:(key:string,value:any)=>{filters.push(r=>r[key]===value);return b;}};select?.(b);return q;},order:(dir:string)=>{descending=dir==='desc';return q;},take:async(n:number)=>rows.filter(r=>r.table===table&&filters.every(f=>f(r))).sort((a,b)=>(descending?-1:1)*(a.created_at-b.created_at)).slice(0,n),first:async()=> (await q.take(1))[0]??null};return q;
 }}};return {ctx,rows};
}
const invoke=(f:any,ctx:any,args:any)=>f._handler(ctx,args);
const base={version:1 as const,eventKey:'paid:fixture',kind:'booking_paid',conversationId:'fixture',createdAt:Date.now(),title:'Paid',body:'Paid rental',renterName:'Fixture',income:{gross:120,net:100,currency:'GBP'}};
describe('website notification bridge and 50% channel',()=>{
 it('deduplicates receipts forever, links the actual chat and halves earnings',async()=>{
  const {ctx,rows}=fixture();await invoke(receive,ctx,{event:base});await invoke(receive,ctx,{event:base});expect(rows).toHaveLength(1);expect(rows[0].thread_id).toBe('dbcinema:fixture');expect(rows[0].url).toContain('thread=dbcinema%3Afixture');
  const result=await invoke(listRecent,ctx,{mode:'my_share'});expect(result.events[0].title).toContain('£50');expect(result.events[0].body).not.toContain('Fixture');expect(result.events[0].copy_data).toBeUndefined();
 });
 it('keeps distinct incoming messages and human/support/email/cancellation in All only',async()=>{
  const {ctx,rows}=fixture();for(const [i,kind] of ['renter_message','renter_message','human_request','email_sent','booking_cancelled'].entries())await invoke(receive,ctx,{event:{...base,eventKey:`event:${i}`,kind,conversationId:'support:fixture',income:undefined}});
  expect(rows).toHaveLength(5);expect((await invoke(listRecent,ctx,{mode:'my_share'})).events).toHaveLength(0);expect((await invoke(listRecent,ctx,{mode:'all'})).events).toHaveLength(5);
  await invoke(markAllRead,ctx,{mode:'my_share'});expect(rows.every(r=>r.read_at===undefined)).toBe(true);
 });
 it('rejects invalid money and suppresses zero revenue across channels',async()=>{
  const {ctx}=fixture();await expect(invoke(receive,ctx,{event:{...base,income:{...base.income,net:-1}}})).rejects.toThrow();expect(notificationHasIncome({type:'booking_confirmed',copy_data:{gross:100,net:0}})).toBe(false);
  for(const type of ['human_request','email_notification','booking_cancelled','renter_message'] as const)expect(subscriptionReceivesNotification('my_share',type)).toBe(false);
  expect(subscriptionReceivesNotification('my_share','booking_confirmed',false)).toBe(false);
 });
});
