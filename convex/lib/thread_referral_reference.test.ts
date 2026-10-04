import {describe,it,expect} from "vitest";
import {friendReferralCodesFromMessage} from "./verification_failure";
import {loadThreadReferralReference,referralReferenceSelection} from "./thread_referral_reference";
const a="aaaaaaaa-1111-2222-3333-444444444444",b="bbbbbbbb-1111-2222-3333-444444444444";
describe("durable renter referral identity",()=>{
 it("preserves multiple references and deduplicates the same reference",()=>{
  expect(friendReferralCodesFromMessage(`My friends sent basket referrals ${a} and ${b}.`)).toEqual([a,b]);
  expect(friendReferralCodesFromMessage(`Basket referral ${a} again ${a.toUpperCase()}`)).toEqual([a]);
  expect(friendReferralCodesFromMessage(`An unrelated ticket ${a}`)).toEqual([]);
  expect(referralReferenceSelection({codes:[a,b],message_id:"current"})).toEqual({code:null,ambiguous:true});
 });
 const context=(reference:unknown,pages:any[])=>{
  let reads=0;
  const ctx={db:{query:(table:string)=>({withIndex:()=>({first:async()=>({referral_reference:reference}),order:()=>({async *[Symbol.asyncIterator](){for(const page of pages){reads++;yield* page.page;}}})})})}};
  return {ctx:ctx as any,reads:()=>reads};
 };
 it("does not rescan the transcript for a persisted selection or known empty reference",async()=>{
  for(const codes of [[a],[a,b],[]]){
   const {ctx,reads}=context({codes,message_id:"saved"},[]);
   expect(await loadThreadReferralReference(ctx,"thread")).toEqual({codes,message_id:"saved"});expect(reads()).toBe(0);
  }
 });
 it("recovers legacy references beyond a single history page",async()=>{
  const {ctx,reads}=context(undefined,[{page:Array.from({length:100},(_,i)=>({message_id:`later${i}`,body_text:"Still deciding"})),isDone:false,continueCursor:"older"},
   {page:[{message_id:"source",body_text:`My friend sent basket referral ${a}`}],isDone:true}]);
  expect(await loadThreadReferralReference(ctx,"thread")).toEqual({codes:[a],message_id:"source"});expect(reads()).toBe(2);
 });
 it("keeps the newest legacy ambiguity instead of reviving an older selected basket",async()=>{
  const {ctx}=context(undefined,[{page:[{message_id:"newer",body_text:`My friend sent referrals ${a} and ${b}`},{message_id:"older",body_text:`Basket referral ${a}`}],isDone:true}]);
  expect(referralReferenceSelection(await loadThreadReferralReference(ctx,"thread"))).toEqual({code:null,ambiguous:true});
 });
});
