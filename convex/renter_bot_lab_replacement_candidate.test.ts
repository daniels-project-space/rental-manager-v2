import { describe, expect, it } from "vitest";
import { __service_acceptedReplacementCandidate } from "./renter_bot_lab_order";
const thread_id="__probe__replacement-candidate";
const offer={items:[{product_id:42,qty:1}],removed_listings:[{product_id:12,qty:1}]};
function setup() {
 const messages:any[]=[{thread_id,sender:"owner",body_text:"Would you like the swap?",quoted_replacements:[offer],message_id:"offer",fetched_at:1,_creationTime:1},
  {thread_id,sender:"renter",body_text:"Yes please swap it",message_id:"renter",fetched_at:2,_creationTime:2}];
 const ctx={db:{query:()=>({withIndex:()=>({collect:async()=>messages})})}};
 const binding={request_message_id:"renter",lab_turn_id:"turn",lab_lease_token:"lease"};
 return {messages,run:()=> (__service_acceptedReplacementCandidate as any)._handler(ctx,{thread_id,...binding})};
}
describe("isolated accepted-replacement dispatch",()=>{
 it("passes only the immediately preceding single recorded offer to the guarded mutation",async()=>{
  const f=setup();expect(await f.run()).toEqual({thread_id,request_message_id:"renter",lab_turn_id:"turn",lab_lease_token:"lease",items:offer.items,replace_product_id:12,replace_quantity:1});
 });
 it.each(["no offer","multiple offers","renter asks only for price","not adjacent"])("never dispatches %s",async variant=>{
  const f=setup();if(variant==="no offer")f.messages[0].quoted_replacements=[];
  if(variant==="multiple offers")f.messages[0].quoted_replacements=[offer,offer];
  if(variant==="renter asks only for price")f.messages[1].body_text="Just quote it, do not change anything";
  if(variant==="not adjacent")f.messages.push({thread_id,sender:"renter",body_text:"also hello",message_id:"later",fetched_at:3,_creationTime:3});
  expect(await f.run()).toBeNull();
 });
});
