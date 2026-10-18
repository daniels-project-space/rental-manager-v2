import { it, expect } from "vitest";
import { quickReplyProof } from "./quick_reply_proof";
const verified=[{key:"FUNDS_RESERVED",completed:true},{key:"VERIFIED",completed:true}];
it("active payment is not paid",()=>expect(quickReplyProof({steps:[{key:"FUNDS_RESERVED",active:true}]}).paid).toBe(false));
it("paid active verification stays pending despite future booked steps",()=>expect(quickReplyProof({steps:[{key:"FUNDS_RESERVED",completed:true},{key:"VERIFIED",active:true},{key:"BOOKED_AFTER_VERIFIED",completed:false}],isBookedAndReady:false})).toEqual({paid:true,verification_started:true,platform_booking_confirmed:false}));
it.each(["BOOKED_AFTER_VERIFIED","DELIVERED","RETURNED","REVIEWED"])("authoritative current %s confirms without depending on English event wording",key=>expect(quickReplyProof({steps:[...verified,{key,active:true}]}).platform_booking_confirmed).toBe(true));
it("recognizes Edward's real Hygglo wording",()=>expect(quickReplyProof({steps:verified,activities:[{event:{content:"Everything is booked and ready. Pickup address: Example Road"}}]}).platform_booking_confirmed).toBe(true));
it("accepts Hygglo's booked-and-ready flag only after payment and verification",()=>{
 expect(quickReplyProof({steps:verified,isBookedAndReady:true}).platform_booking_confirmed).toBe(true);
 expect(quickReplyProof({steps:[{key:"VERIFIED",active:true}],isBookedAndReady:true}).platform_booking_confirmed).toBe(false);
});
it("renter/owner text cannot impersonate a platform event",()=>expect(quickReplyProof({steps:verified,activities:[{chatMessage:{text:{content:"Everything is booked and ready"}}}]}).platform_booking_confirmed).toBe(false));
it.each(["CANCELED","VERIFICATION_FAILED"])("terminal %s wins over historical booking proof",key=>expect(quickReplyProof({steps:[...verified,{key:"BOOKED_AFTER_VERIFIED",completed:true},{key,active:true}],isBookedAndReady:true}).platform_booking_confirmed).toBe(false));
it.each(["The rental is not confirmed.","The rental will be confirmed.","Once security checks pass, your rental is booked."])("rejects a negative or future event: %s",content=>expect(quickReplyProof({steps:verified,activities:[{event:{content}}]}).platform_booking_confirmed).toBe(false));
it("historical booked flags cannot override an explicit earlier active workflow",()=>expect(quickReplyProof({steps:[{key:"APPROVED",active:true},{key:"BOOKED_AFTER_VERIFIED",completed:true}],isBookedAndReady:true}).platform_booking_confirmed).toBe(false));
it("post-verification active workflow proves prior verification even if completed rows are omitted",()=>expect(quickReplyProof({steps:[{key:"RETURNED",active:true}]})).toMatchObject({paid:true,platform_booking_confirmed:true}));
