import { seedRenterProfile, cleanup } from "../renter_bot_probe";
import { priorBusinessRentals, renterHistory } from "./renter_history";
import { persistRenterDNA } from "../replyInbox";
import { applyTrust } from "../renter_trust";
import { draftContextKey } from "./draft_review";
import { expect,it } from "vitest";
import { getBotRenter } from "./renter_identity";
import { get_renter_context } from "../renter_bot_tools";
function fixture(){
 const tables:Record<string,any[]>={renters:[{_id:"known",hygglo_user_id:"platform-known",display_name:"Alex",hygglo_rating:5,total_rentals_count:40,blacklisted:true}],conversations:[],reservations:[],hygglo_messages:[]};
 const ctx:any={db:{insert:async(table:string,value:any)=>{const id=`${table}-${tables[table]?.length??0}`;(tables[table]??=[]).push({_id:id,...value});return id;},delete:async(id:string)=>{for(const table of Object.keys(tables))tables[table]=tables[table].filter(r=>r._id!==id);},patch:async(id:string,value:any)=>Object.assign(Object.values(tables).flat().find(r=>r._id===id),value),get:async(id:string)=>Object.values(tables).flat().find(r=>r._id===id)??null,query:(table:string)=>{
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


it("business history excludes future collection, unconfirmed, cancelled, current and duplicate orders",()=>{
 const rows=[
  {hygglo_order_id:"future",status:"confirmed",order_step:"DELIVERED",start_date:"2099-10-20"},
  {hygglo_order_id:"pending",status:"pending_review",order_step:"VERIFIED"},
  {hygglo_order_id:"cancelled",status:"cancelled",order_step:"RETURNED"},
  {hygglo_order_id:"obsolete",status:"completed",is_obsolete:true},
  {hygglo_order_id:"current",status:"completed",start_date:"2026-10-02"},
  {hygglo_order_id:"prior",status:"completed",start_date:"2026-09-12"},
  {hygglo_order_id:"prior",status:"completed",start_date:"2026-09-12"},
  {hygglo_order_id:"in-use",status:"ongoing",order_step:"RETURNED",start_date:"2026-09-15",created_at:9999999999999},
 ];
 expect(priorBusinessRentals(rows,"current","2026-10-03")).toEqual({count:2,last_rental_at:Date.parse("2026-09-15T00:00:00Z")});
});
it("missing, invalid and future pickup dates do not become invented last-rental timestamps",()=>{
 const rows=[{status:"completed"},{status:"completed",start_date:"2026-02-31"},{status:"completed",start_date:"2099-01-01"}];
 expect(priorBusinessRentals(rows,"current","2026-10-03")).toEqual({count:3,last_rental_at:null});
});
it("history follows exact IDs, merges linked/platform rows, and excludes contradictory identity",async()=>{
 const {tables,ctx}=fixture();const renter=tables.renters[0];
 tables.reservations.push({_id:"one",hygglo_order_id:"one",renter_id:"known",status:"completed"},
 {_id:"two",hygglo_order_id:"two",hygglo_user_id:"platform-known",status:"completed"},
 {_id:"three",renter_name:"Alex",status:"completed"},
 {_id:"wrong-link",renter_id:"known",hygglo_user_id:"different",status:"completed"},
 {_id:"wrong-platform",renter_id:"other",hygglo_user_id:"platform-known",status:"completed"});
 expect(await renterHistory(ctx,renter,"current","2026-10-03")).toEqual({platform_completed_rentals:null,recorded_rentals_with_us:2,last_rental_with_us_at:null});
 renter.platform_completed_rentals=108;
 expect((await renterHistory(ctx,renter,"current","2026-10-03")).platform_completed_rentals).toBe(108);
});
it("legacy count stays unverified until a valid Native platform refresh writes the dedicated field",async()=>{
 const {tables,ctx}=fixture();tables.conversations.push({thread_id:"thread",renter_id:"known"});
 expect((await (get_renter_context as any)._handler(ctx,{thread_id:"thread"})).renter.total_rentals_count).toBeUndefined();
 for(const total_rentals of [-1,1.5,NaN])await (applyTrust as any)._handler(ctx,{renter_id:"known",total_rentals,reviews:[]});
 expect(tables.renters[0].platform_completed_rentals).toBeUndefined();expect(tables.renters[0].total_rentals_count).toBe(40);
 await (applyTrust as any)._handler(ctx,{renter_id:"known",total_rentals:108,reviews:[]});
 expect(tables.renters[0]).toMatchObject({total_rentals_count:108,platform_completed_rentals:108});
 const result=await (get_renter_context as any)._handler(ctx,{thread_id:"thread"});expect(result.renter_history).toMatchObject({platform_completed_rentals:108,recorded_rentals_with_us:0});
});
const dnaFixture=()=>{
 const f=fixture();f.tables.renters[0].platform_completed_rentals=108;f.tables.renters[0].last_rental_at=12345;
 f.tables.conversations.push({thread_id:"thread",renter_id:"known"});
 f.tables.reservations.push({hygglo_order_id:"thread",renter_id:"known",status:"confirmed",start_date:"2026-10-20",end_date:"2026-10-21"});
 f.tables.hygglo_messages.push({thread_id:"thread",message_id:"current",sender:"renter",body_text:"Hey mate, I need an E-mount lens for a BRAW shoot.",fetched_at:1,_creationTime:1});
 f.tables.settings=[{draft_epoch:1}];
 const args={thread_id:"thread",renter_id:"known",message_id:"current",epoch:1,context_key:draftContextKey(f.tables.reservations[0])};return {...f,args};
};
it("Native tone learning changes only DNA and preserves both history scopes and profile dates",async()=>{
 const f=dnaFixture();const before=structuredClone(f.tables.renters[0]);
 expect(await (persistRenterDNA as any)._handler(f.ctx,f.args)).toMatchObject({ok:true});
 const {renter_dna,...rest}=f.tables.renters[0];expect(rest).toEqual(before);expect(renter_dna).toMatchObject({expertise:"pro",style:"casual"});
});
for(const variant of ["new_message","epoch_changed","booking_changed","person_changed","lab"]){
 it(`tone learning does not write after ${variant}`,async()=>{
  const f=dnaFixture();
  if(variant==="new_message")f.tables.hygglo_messages.push({...f.tables.hygglo_messages[0],message_id:"new",fetched_at:2,_creationTime:2});
  if(variant==="epoch_changed")f.tables.settings[0].draft_epoch=2;
  if(variant==="booking_changed")f.tables.reservations[0].end_date="2026-10-22";
  if(variant==="person_changed")f.tables.conversations[0].renter_id="other";
  if(variant==="lab")f.args.thread_id="__probe__lab";
  const before=structuredClone(f.tables);
  const result=await (persistRenterDNA as any)._handler(f.ctx,f.args);expect(result.ok).toBe(variant==="lab");expect(f.tables).toEqual(before);
 });
}

it("tone learning uses the same zero epoch default as Native context",async()=>{
 const f=dnaFixture();f.tables.settings=[];f.args.epoch=0;
 expect(await (persistRenterDNA as any)._handler(f.ctx,f.args)).toMatchObject({ok:true});
});

it("owned Lab profile seeding and cleanup never remove a foreign linked person",async()=>{
 const {tables,ctx}=fixture();const thread_id="__probe__history";tables.conversations.push({_id:"conversation",thread_id});
 const seeded=await (seedRenterProfile as any)._handler(ctx,{thread_id,legacy_count:40});
 expect(await (seedRenterProfile as any)._handler(ctx,{thread_id,legacy_count:40})).toEqual(seeded);
 expect(tables.renters).toHaveLength(2);await (cleanup as any)._handler(ctx,{thread_id});expect(tables.renters.map(r=>r._id)).toEqual(["known"]);
 tables.conversations.push({_id:"foreign-link",thread_id,renter_id:"known"});
 await expect((seedRenterProfile as any)._handler(ctx,{thread_id,legacy_count:40})).rejects.toThrow("another renter identity");
 await (cleanup as any)._handler(ctx,{thread_id});expect(tables.renters.map(r=>r._id)).toEqual(["known"]);
 await expect((seedRenterProfile as any)._handler(ctx,{thread_id:"real",legacy_count:40})).rejects.toThrow("owned Lab");
});
