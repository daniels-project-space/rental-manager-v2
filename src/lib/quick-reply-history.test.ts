import {it,expect} from "vitest";
import {mergeConversationHistory} from "./quick-reply-history";
it("merges reactive sends into complete pages while preserving media",()=>{
 const full=[{id:"one",role:"renter",content:"Photo",timestamp:1,images:[{url:"https://example.com/image.jpg"}]},{id:"event",role:"system",content:"Booked",timestamp:2}];
 const merged=mergeConversationHistory(full,[{id:"one",role:"renter",content:"Photo",timestamp:1},{id:"sent",role:"owner",content:"Thanks",timestamp:3}]);
 expect(merged.map(m=>m.id)).toEqual(["one","event","sent"]);expect(merged[0].images).toHaveLength(1);
});
it("orders by source time rather than import or loaded-page order",()=>expect(mergeConversationHistory([{id:"new",role:"renter",content:"new",timestamp:20},{id:"old",role:"owner",content:"old",timestamp:10}],[]).map(r=>r.id)).toEqual(["old","new"]));

it("provider-hidden entries cannot be resurrected by the text-only tail",()=>expect(mergeConversationHistory([{id:"one",role:"renter",content:"",hidden:true,timestamp:1}],[{id:"one",role:"renter",content:"Redacted",timestamp:1}])).toEqual([]));
it("paged history does not pull older operational messages around its cursor",()=>expect(mergeConversationHistory([{id:"new",role:"renter",content:"New",timestamp:20}],[{id:"old",role:"renter",content:"Old",timestamp:10}]).map(r=>r.id)).toEqual(["new"]));
it("grouped provider message IDs cover their older individual operational copies",()=>expect(mergeConversationHistory([{id:"chat-1-&-chat-2",role:"renter",content:"Grouped",timestamp:20}],[{id:"chat-1",role:"renter",content:"Old",timestamp:20}]).map(r=>r.id)).toEqual(["chat-1-&-chat-2"]));
