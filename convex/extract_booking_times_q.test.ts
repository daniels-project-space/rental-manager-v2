import {describe,it,expect} from "vitest";
import {setTimes} from "./extract_booking_times_q";
import {hashBookingTimeTranscript} from "../src/lib/booking-time-transcript";
function fixture(){
 const messages=[{sender:"renter",body_text:"Return at 5pm",hygglo_sent_at:1},{sender:"owner",body_text:"Yes!",hygglo_sent_at:2}];
 const row:any={_id:"rental",hygglo_order_id:"123",start_date:"2026-10-09",end_date:"2026-10-09"};const writes:any[]=[];
 const ctx:any={db:{get:async()=>row,patch:async(_:string,p:any)=>{writes.push(p);Object.assign(row,p)},query:()=>{const q:any={withIndex:()=>q,order:()=>q,take:async()=>messages.slice().reverse()};return q}},scheduler:{runAfter:async()=>{}}};
 return {messages,row,writes,ctx};
}
describe("real extraction writer schedule provenance",()=>{
 it("rejects a stale asynchronous extraction without overwriting the rental",async()=>{const f=fixture();expect(await(setTimes as any)._handler(f.ctx,{reservation_id:"rental",transcript_hash:"old",patch:{return_time:"19:00"}})).toMatchObject({ok:false,reason:"stale_transcript"});expect(f.writes).toHaveLength(0);});
 it("records independently accepted clocks using the saved transcript",async()=>{const f=fixture();await(setTimes as any)._handler(f.ctx,{reservation_id:"rental",transcript_hash:hashBookingTimeTranscript(f.messages),patch:{return_time:"17:00"}});expect(f.row.return_time_provenance).toMatchObject({source:"agreed_chat",date:"2026-10-09",time:"17:00",confirmedAt:2});});
 it("invalidates old precision when a newer broad return proposal is unaccepted",async()=>{const f=fixture();f.row.return_time="17:00";f.row.return_time_provenance={source:"agreed_chat",date:"2026-10-09",time:"17:00",confirmedAt:2};f.messages.push({sender:"renter",body_text:"Can I return during the day instead?",hygglo_sent_at:3});await(setTimes as any)._handler(f.ctx,{reservation_id:"rental",transcript_hash:hashBookingTimeTranscript(f.messages),patch:{}});expect(f.row.return_time_provenance).toBeUndefined();});
 it("does not accept a high-confidence invented model clock",async()=>{const f=fixture();await(setTimes as any)._handler(f.ctx,{reservation_id:"rental",transcript_hash:hashBookingTimeTranscript(f.messages),patch:{return_time:"19:00"}});expect(f.row.return_time_provenance).toBeUndefined();});
});
