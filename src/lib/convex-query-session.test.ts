import { describe, expect, it, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createConvexQuerySession } from "./convex-query-session";
import { createRequestConvexClient, withConvexClientFactory } from "./convex-request-context";

const stock = makeFunctionReference<"query">("renter_bot_tools:check_availability");
const order = makeFunctionReference<"query">("renter_bot_lab_order:get");
const edit = makeFunctionReference<"mutation">("renter_bot_lab_order:applyChange");
const action = makeFunctionReference<"action">("renter_bot_tools:check_location");
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; });
  return { promise, resolve };
};
function fixture() {
  let revision = 0;
  const raw = {
    query: vi.fn(async () => ({ revision })),
    mutation: vi.fn(async () => ({ revision: ++revision })),
    action: vi.fn(async () => ({ revision: ++revision })),
  };
  const observe = vi.fn();
  const session = createConvexQuerySession(raw as unknown as ConvexHttpClient, observe);
  return { raw, observe, ...session };
}

describe("shared Native query session", () => {
  it("shares hydration and tool reads only within the verified request", async () => {
    const first = fixture(), second = fixture();
    const args = { thread_id: "first", quantity: 1 };
    await first.client.query(stock, args);
    await withConvexClientFactory(() => first.client, () => createRequestConvexClient().query(stock, { quantity: 1, thread_id: "first" }));
    await withConvexClientFactory(() => second.client, () => createRequestConvexClient().query(stock, args));
    expect(first.raw.query).toHaveBeenCalledTimes(1);
    expect(first.observe).toHaveBeenCalledTimes(1);
    expect(first.stats).toEqual({ queries: 1, dedupedRoundTrips: 1 });
    expect(second.raw.query).toHaveBeenCalledTimes(1);
    await first.client.query(stock, { ...args, quantity: 2 });
    expect(first.raw.query).toHaveBeenCalledTimes(2);
  });
  it("deduplicates simultaneous reads without changing Convex argument encoding", async () => {
    const f = fixture(), pending = deferred();
    f.raw.query.mockImplementationOnce(() => pending.promise as never);
    const one = f.client.query(stock, { id: 9n }), two = f.client.query(stock, { id: 9n });
    expect(f.raw.query).toHaveBeenCalledTimes(1);
    pending.resolve({ revision: 1 });
    expect(await one).toEqual(await two);
  });
  it.each(["mutation", "action"] as const)("re-reads after %s rather than keeping pre-write stock", async method => {
    const f = fixture();
    expect(await f.client.query(stock, {})).toEqual({ revision: 0 });
    expect(f.getRevision()).toBe(0);
    if (method === "mutation") await f.client.mutation(edit, {});
    else await f.client.action(action, {});
    expect(await f.client.query(stock, {})).toEqual({ revision: 1 });
    expect(f.getRevision()).toBe(2);
    expect(f.raw.query).toHaveBeenCalledTimes(2);
  });
  it("waits for an outstanding write and shares the resulting Native read", async () => {
    const f = fixture(), pending = deferred();
    f.raw.mutation.mockImplementationOnce(() => pending.promise as never);
    const writing = f.client.mutation(edit, {});
    const one=f.client.query(stock, {}),two=f.client.query(stock, {});
    expect(f.raw.query).not.toHaveBeenCalled();
    pending.resolve({ revision: 1 });
    await writing;
    expect(await one).toEqual(await two);
    await f.client.query(stock, {});
    expect(f.raw.query).toHaveBeenCalledTimes(1);
    expect(f.raw.mutation).toHaveBeenCalledTimes(1);
  });
  it("does not let an older in-flight read repopulate the post-write cache", async () => {
    const f = fixture(), pending = deferred();
    f.raw.query.mockImplementationOnce(() => pending.promise as never);
    const old = f.client.query(stock, {});
    await f.client.mutation(edit, {});
    expect(await f.client.query(stock, {})).toEqual({ revision: 1 });
    pending.resolve({ revision: 0 });
    expect(await old).toEqual({ revision: 1 });
    expect(await f.client.query(stock, {})).toEqual({ revision: 1 });
    expect(f.raw.query).toHaveBeenCalledTimes(2);
    expect(f.observe.mock.calls.map(([, result]) => result)).toEqual([{ revision: 1 }]);
  });
  it("invalidates even when a write fails after a partial effect", async () => {
    const f = fixture();
    await f.client.query(stock, {});
    f.raw.mutation.mockRejectedValueOnce(new Error("transport lost"));
    await expect(f.client.mutation(edit, {})).rejects.toThrow("transport lost");
    await f.client.query(stock, {});
    expect(f.raw.query).toHaveBeenCalledTimes(2);
  });
  it("retries a failed query instead of memoizing its error", async () => {
    const f = fixture();
    f.raw.query.mockRejectedValueOnce(new Error("temporary"));
    await expect(f.client.query(stock, {})).rejects.toThrow("temporary");
    expect(await f.client.query(stock, {})).toEqual({ revision: 0 });
    expect(f.raw.query).toHaveBeenCalledTimes(2);
  });
  it("always re-reads the Native order used to prove a transition", async () => {
    const f = fixture();
    await f.client.query(order, {});
    await f.client.query(order, {});
    expect(f.raw.query).toHaveBeenCalledTimes(2);
    expect(f.stats).toEqual({ queries: 2, dedupedRoundTrips: 0 });
  });
});


it("refreshes a cached response if a write starts before its caller receives it",async()=>{
 const f=fixture();await f.client.query(stock,{});
 const cached=f.client.query(stock,{});
 await f.client.mutation(edit,{});
 expect(await cached).toEqual({revision:1});
 expect(f.raw.query).toHaveBeenCalledTimes(2);expect(f.raw.mutation).toHaveBeenCalledTimes(1);
});

it("refreshes an old failed read after a write without replaying the write",async()=>{
 const f=fixture();let reject!:(reason:unknown)=>void;
 f.raw.query.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}) as never);
 const old=f.client.query(stock,{});await f.client.mutation(edit,{});
 reject(new Error("old snapshot failed"));
 expect(await old).toEqual({revision:1});expect(f.raw.query).toHaveBeenCalledTimes(2);expect(f.raw.mutation).toHaveBeenCalledTimes(1);
});

it("releases waiting readers even when a write partially fails",async()=>{
 const f=fixture();let reject!:(reason:unknown)=>void;
 f.raw.mutation.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}) as never);
 const writing=f.client.mutation(edit,{}),handled=expect(writing).rejects.toThrow("partial failure");
 const reading=f.client.query(stock,{});expect(f.raw.query).not.toHaveBeenCalled();
 reject(new Error("partial failure"));await handled;await reading;
 expect(f.raw.mutation).toHaveBeenCalledTimes(1);expect(f.raw.query).toHaveBeenCalledTimes(1);
});

it("tags the delivered Native snapshot instead of assigning it the caller's later revision",async()=>{
 const f=fixture();const before=await f.client.query(stock,{});expect(f.getReadRevision(before)).toBe(0);
 await f.client.mutation(edit,{});const after=await f.client.query(stock,{});
 expect(f.getReadRevision(before)).toBe(0);expect(f.getReadRevision(after)).toBe(2);expect(f.getReadRevision({...after})).toBeUndefined();
});
