import { describe, expect, it, vi } from "vitest";
import { chronologicalThreadMessages, recentChronological, recentThreadMessages } from "./thread_messages";
describe("conversation history", () => {
  it("keeps Native history complete with one indexed read while the transcript stays bounded",async()=>{
    const history=Array.from({length:100},(_,n)=>({id:n,fetched_at:n,hygglo_sent_at:n,_creationTime:100-n})).reverse();
    const collect=vi.fn(async()=>history),withIndex=vi.fn(()=>({collect}));
    const ctx={db:{query:vi.fn(()=>({withIndex}))}} as any;
    expect((await chronologicalThreadMessages(ctx,"thread")).map(m=>(m as any).id)).toEqual(Array.from({length:100},(_,n)=>n));
    expect(collect).toHaveBeenCalledTimes(1);expect(withIndex).toHaveBeenCalledWith("by_thread",expect.any(Function));
    expect((await recentThreadMessages(ctx,"thread",40)).map(m=>(m as any).id)).toEqual(Array.from({length:40},(_,n)=>n+60));
    expect(collect).toHaveBeenCalledTimes(2);
  });
  it("keeps the latest forty messages in long threads", () => {
    const history = Array.from({ length: 100 }, (_, n) => ({ id: n, fetched_at: n, hygglo_sent_at: n, _creationTime: n }));
    expect(recentChronological(history, 40).map((m) => m.id)).toEqual(Array.from({ length: 40 }, (_, n) => n + 60));
  });
  it("does not treat a late historical import as the latest inbound", () => {
    const history = [{ id: "new", fetched_at: 100, hygglo_sent_at: 100, _creationTime: 100 }, { id: "old-import", fetched_at: 200, hygglo_sent_at: 1, _creationTime: 200 }];
    expect(recentChronological(history, 1)[0].id).toBe("new");
  });
  it("uses fetched time for legacy rows and stable order for ties", () => {
    const history = [{ id: "later", fetched_at: 100, _creationTime: 20 }, { id: "earlier", fetched_at: 100, _creationTime: 10 }];
    expect(recentChronological(history, 2).map((m) => m.id)).toEqual(["earlier", "later"]);
  });
});
