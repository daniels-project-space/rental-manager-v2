import {describe,it,expect} from "vitest";
import {applyReplyReceipt,threadHidden} from "./quick-reply-queue-state";
const row={thread_id:"a",last_renter_msg_at:100,last_sender:"renter",preview:"question",last_activity_at:100};
describe("operator queue watermarks",()=>{
  it("hides through the last renter message, regardless of owner activity",()=>{
    expect(threadHidden(row,100)).toBe(true);
    expect(threadHidden({...row,last_activity_at:500} as typeof row,100)).toBe(true);
    expect(threadHidden({...row,last_renter_msg_at:101},100)).toBe(false);
    expect(threadHidden(row,null)).toBe(false);
  });
  it("immediately paints confirmed replies without inventing renter messages",()=>{
    expect(applyReplyReceipt(row,{through:100,at:200,text:"reply"})).toEqual({...row,last_sender:"owner",last_activity_at:200,last_msg_at:200,preview:"reply"});
  });
  it("lets newer renter or authoritative source activity override local receipts",()=>{
    const incoming={...row,last_renter_msg_at:201,last_activity_at:201};
    expect(applyReplyReceipt(incoming,{through:100,at:200,text:"reply"})).toBe(incoming);
    const source={...row,last_activity_at:300};
    expect(applyReplyReceipt(source,{through:100,at:200,text:"reply"})).toBe(source);
  });
});
