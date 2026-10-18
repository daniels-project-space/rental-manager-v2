import { describe,it,expect } from "vitest";
import {hyggloHistoryEntries} from "./hygglo_history_entries";
describe("complete provider timeline",()=>{
 it("retains text, system confirmation and mixed image/text activities",()=>{
  const rows=hyggloHistoryEntries({activities:[
   {key:"system",createdAtLabel:"15 Oct, 12:54",event:{title:"New status",content:"Everything is booked and ready"}},
   {key:"chat-2-&-chat-1",createdAtLabel:"16 Oct, 12:11",chatMessage:{text:{content:"He's waiting here"},byMe:false,image:{urls:{full:"https://hygglo.imgix.net/chat/photo.jpg",thumbnail:"https://hygglo.imgix.net/chat/photo.jpg?w=160"}}}},
   {key:"owner",createdAtLabel:"16 Oct, 12:12",chatMessage:{text:{content:"Delivered!"},byMe:true}},
  ]});
  expect(rows).toHaveLength(3);expect(rows[0]).toMatchObject({role:"system",content:"Everything is booked and ready"});expect(rows[1]).toMatchObject({role:"renter",content:"He's waiting here",images:[{url:"https://hygglo.imgix.net/chat/photo.jpg"}]});expect(rows[2].role).toBe("owner");
 });
 it("retains an image-only message",()=>expect(hyggloHistoryEntries({activities:[{key:"photo",chatMessage:{image:{urls:{full:"https://hygglo.imgix.net/photo.jpg"}}}}]})[0]).toMatchObject({content:"",images:[{url:"https://hygglo.imgix.net/photo.jpg"}]}));
 it("redacts hidden provider messages and refuses unsafe attachment URLs",()=>expect(hyggloHistoryEntries({activities:[{key:"hidden",chatMessage:{hidden:true,text:{content:"Removed"}}},{key:"unsafe",chatMessage:{image:{urls:{full:"javascript:alert(1)"}}}}]})).toEqual([{id:"hidden",role:"renter",content:"",images:[],hidden:true,position:0}]));
 it("keeps unknown dates unknown rather than presenting refresh time as send time",()=>expect(hyggloHistoryEntries({activities:[{key:"x",chatMessage:{text:{content:"Hello"}}}]})[0].timestamp).toBeUndefined());
 it("retains provider ordering for equal timestamps even when IDs sort differently",()=>expect(hyggloHistoryEntries({activities:[{key:"z",createdAtLabel:"16 Oct, 12:12",chatMessage:{text:{content:"First"}}},{key:"a",createdAtLabel:"16 Oct, 12:12",chatMessage:{text:{content:"Second"}}}]}).map(e=>e.id)).toEqual(["z","a"]));
 it("preserves every provider entry in long conversations",()=>expect(hyggloHistoryEntries({activities:Array.from({length:130},(_,i)=>({key:`chat-${i}`,chatMessage:{text:{content:`Message ${i}`}}}))})).toHaveLength(130));
});
