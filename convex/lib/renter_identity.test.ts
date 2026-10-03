import { expect,it } from "vitest";
import { getBotRenter } from "./renter_identity";
import { get_renter_context } from "../renter_bot_tools";
function fixture(){
 const tables:Record<string,any[]>={renters:[{_id:"known",hygglo_user_id:"platform-known",display_name:"Alex",hygglo_rating:5,total_rentals_count:40,blacklisted:true}],conversations:[],reservations:[],hygglo_messages:[]};
 const ctx:any={db:{get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,query:(table:string)=>{
  const filters:Array<[string,any]>=[];const q={eq:(k:string,v:any)=>{filters.push([k,v]);return q;}};
  const query:any={withIndex:(_:string,f:any)=>{f(q);return query;},order:()=>query,collect:async()=> (tables[table]??[]).filter(r=>filters.every(([k,v])=>r[k]===v)),first:async()=> (await query.collect())[0]??null,take:async(n:number)=> (await query.collect()).slice(0,n)};return query;
 }}};return {tables,ctx};
}
it("never inherits another person's trust or blacklist from a matching display name",async()=>{
 const {tables,ctx}=fixture();tables.reservations.push({hygglo_order_id:"thread",renter_name:"Alex",status:"pending"});
 const result=await (get_renter_context as any)._handler(ctx,{thread_id:"thread"});expect(result.renter).toBeNull();
});
it("uses an exact platform user ID when the local renter link is missing",async()=>{
 const {ctx}=fixture();expect(await getBotRenter(ctx,{hygglo_user_id:"platform-known"},null)).toMatchObject({_id:"known",blacklisted:true});
 expect(await getBotRenter(ctx,{hygglo_user_id:"different-person"},null)).toBeNull();
});
it("keeps linked legacy profiles without guessing names",async()=>{
 const {ctx}=fixture();expect(await getBotRenter(ctx,null,{renter_id:"known" as any})).toMatchObject({_id:"known"});
 expect(await getBotRenter(ctx,null,{renter_id:"deleted" as any})).toBeNull();
});
for(const variant of ["conflicting_links","wrong_platform_id","duplicate_platform_profiles","different_native_profile"]){
 it(`withholds contradictory Native renter identity: ${variant}`,async()=>{
  const {tables,ctx}=fixture();tables.renters.push({_id:"other",hygglo_user_id:"platform-other",display_name:"Alex"});
  const booking:any={renter_id:"known"},conversation:any={renter_id:"known"};
  if(variant==="conflicting_links")conversation.renter_id="other";
  if(variant==="wrong_platform_id")booking.hygglo_user_id="platform-other";
  if(variant==="duplicate_platform_profiles"){booking.hygglo_user_id="platform-known";tables.renters[1].hygglo_user_id="platform-known";}
  if(variant==="different_native_profile"){booking.hygglo_user_id="platform-other";delete tables.renters[0].hygglo_user_id;}
  await expect(getBotRenter(ctx,booking,conversation)).rejects.toThrow("RENTER_IDENTITY_CONFLICT");
  tables.conversations.push({thread_id:"thread",...conversation});tables.reservations.push({hygglo_order_id:"thread",...booking});
  await expect((get_renter_context as any)._handler(ctx,{thread_id:"thread"})).rejects.toThrow("RENTER_IDENTITY_CONFLICT");
 });
}
for(const [status,order_step,expected] of [["confirmed","BOOKED_AFTER_VERIFIED","CONFIRMED_UPCOMING"],["cancelled","VERIFICATION_FAILED","VERIFICATION_FAILED"],["pending_review","REQUEST","AWAITING_OWNER_APPROVAL"],["pending_review","APPROVED","AWAITING_PAYMENT"],["pending_review","VERIFIED","AWAITING_VERIFICATION"],["ongoing","RETURNED","IN_USE"],["completed","REVIEWED","COMPLETED"]]){
 it(`uses actual booking ${status}/${order_step} over saved inquiry stage`,async()=>{
  const {tables,ctx}=fixture();tables.conversations.push({thread_id:"thread",conversation_stage:"INQUIRY"});tables.reservations.push({hygglo_order_id:"thread",status,order_step,start_date:"2099-10-20",end_date:"2099-10-21"});
  const context=await (get_renter_context as any)._handler(ctx,{thread_id:"thread"});expect(context.conversation_stage).toBe(expected);expect(context.rental_stage.stage).toBe(expected);
 });
}
it("retains the saved sales stage for a conversation without a booking",async()=>{
 const {tables,ctx}=fixture();tables.conversations.push({thread_id:"thread",conversation_stage:"INTERESTED"});expect((await (get_renter_context as any)._handler(ctx,{thread_id:"thread"})).conversation_stage).toBe("INTERESTED");
});
