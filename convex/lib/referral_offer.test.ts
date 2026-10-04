import {describe,it,expect} from "vitest";
import {REFERRAL_RESTORE_OFFER,previousReferralOffer,renterAcceptsReferralOffer} from "./referral_offer";
import type {SentAdditionProposal} from "./renter_sent_proposal";
const offer:SentAdditionProposal={context_key:"empty-inquiry",epoch:142,quoted_for_message_id:"renter-1",referral_code:"native-reference",
 physical_identity_key:"native-lens",items:[{product_id:1163215,qty:1}],base_items:[],added_items:[{name:"TTArtisan 11mm f/2.8 fisheye (E)",quantity:1}],
 quoted_lines:[{product_id:1163215,name:"TTArtisan 11mm f/2.8 fisheye (E)",qty:1,line_total_gbp:42}],
 start_date:"2026-10-22",end_date:"2026-10-23",total_gbp:42,additional_cost_gbp:42};
const owner={sender:"owner",body_text:`For 2 days (22 October 2026 to 23 October 2026):\n- 1 × TTArtisan 11mm f/2.8 fisheye (E): £42\nTotal: £42\n\n${REFERRAL_RESTORE_OFFER}`,quoted_additions:[offer]};
const messages=(text:string,previous=owner)=>[previous,{sender:"renter",body_text:text}];
describe("Native referral acceptance planning",()=>{
 it("uses the real sent terms and the transaction's consent engine for a natural acceptance",()=>{
  const chat=messages("yes please");
  expect(previousReferralOffer(chat)).toEqual(offer);
  expect(renterAcceptsReferralOffer(previousReferralOffer(chat),chat)).toBe(true);
 });
 it("does not convert quote enquiries, changed or conditional terms into an accepted action",()=>{
  for(const text of ["What would that cost?","yes please, if it is approved","yes please, wait until tomorrow","yes please, for £24","yes please for 24 to 25 October","add two of those","no thanks"])expect(renterAcceptsReferralOffer(offer,messages(text))).toBe(false);
 });
 it("requires an actual immediately preceding Native offer, complete prices and one choice",()=>{
  expect(renterAcceptsReferralOffer(null,messages("yes please"))).toBe(false);
  expect(renterAcceptsReferralOffer({...offer,quoted_lines:undefined},messages("yes please"))).toBe(false);
  expect(renterAcceptsReferralOffer(offer,messages("yes please",{...owner,quoted_additions:[]}))).toBe(false);
  expect(renterAcceptsReferralOffer(offer,messages("yes please",{...owner,body_text:owner.body_text.replaceAll("£42","£24")}))).toBe(false);
  expect(renterAcceptsReferralOffer(offer,messages("yes please",{...owner,quoted_additions:[offer,{...offer,referral_code:"other"}]}))).toBe(false);
  expect(previousReferralOffer(messages("yes please",{...owner,sender:"renter"}))).toBeNull();
 });
 it("checks each decimal-aperture price row rather than borrowing a correct whole-basket total",()=>{
  const second={product_id:2,name:"Canon EF 24-105mm f/4",qty:1,line_total_gbp:20};
  const basket={...offer,total_gbp:62,additional_cost_gbp:62,items:[...offer.items,{product_id:2,qty:1}],quoted_lines:[...offer.quoted_lines!,second]};
  const sent={...owner,quoted_additions:[basket],body_text:owner.body_text.replace("Total: £42","- 1 × Canon EF 24-105mm f/4: £20\nTotal: £62")};
  expect(renterAcceptsReferralOffer(basket,messages("yes please",sent))).toBe(true);
  expect(renterAcceptsReferralOffer(basket,messages("yes please",{...sent,body_text:sent.body_text.replace("£42","£40").replace("£20","£22")}))).toBe(false);
 });
});
