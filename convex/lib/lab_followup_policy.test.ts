import {describe,it,expect} from "vitest";
import {missingTimeDraft,distanceFollowupDraft,type LabTurn} from "./lab_followup_policy";
const day=86400000;
describe("isolated follow-up draft eligibility",()=>{
 const missing={now:day,confirmedAt:0,confirmed:true,startDate:"2099-01-01",endDate:"2099-01-02",pickupConfirmed:false,returnConfirmed:true};
 it("waits 24 hours after a verified confirmation and requests only missing exact times",()=>{
  expect(missingTimeDraft({...missing,now:day-1})).toBeNull();expect(missingTimeDraft(missing)).toContain("pickup time");
  expect(missingTimeDraft({...missing,confirmed:false})).toBeNull();expect(missingTimeDraft({...missing,returnConfirmed:true,pickupConfirmed:true})).toBeNull();
 });
 it("only proposes a capped travel draft after an explicit objection, disclosure and 24h of silence",()=>{
  const history:LabTurn[]=[{role:"renter",content:"That's too far for me",at:1,messageId:"1"},{role:"owner",content:"Collection is in the Northumberland Street area.",at:2,messageId:"2"}];
  const i={now:day+2,history,pickupArea:"Northumberland Street area",rentalChargeGbp:50};
  expect(distanceFollowupDraft(i)).toContain("£5.00");expect(distanceFollowupDraft({...i,now:day+1})).toBeNull();
  expect(distanceFollowupDraft({...i,rentalChargeGbp:200})).toContain("£10.00");
  expect(distanceFollowupDraft({...i,history:[{...history[0],content:"Thanks"},history[1]]})).toBeNull();
  expect(distanceFollowupDraft({...i,history:[...history,{role:"renter",content:"Thanks",at:3,messageId:"3"}]})).toBeNull();
  expect(distanceFollowupDraft({...i,rentalChargeGbp:null})).toBeNull();
 });
});
