import { it, expect } from "vitest";
import { begin, finish, receipt } from "./quick_reply_swap_ledger";
function fixture() {
  const rows: any[] = [];
  const db: any = {
    query: () => {
      const filters: any[] = [];
      let desc = false;
      const q: any = {
        withIndex: (_: any, fn: any) => {
          const chain: any = {
            eq: (k: any, v: any) => {
              filters.push((r: any) => r[k] === v);
              return chain;
            },
          };
          fn(chain);
          return q;
        },
        order: () => {
          desc = true;
          return q;
        },
        unique: async () =>
          rows.find((r) => filters.every((f) => f(r))) ?? null,
        first: async () =>
          [...rows]
            .sort((a, b) => (desc ? b.at - a.at : a.at - b.at))
            .find((r) => filters.every((f) => f(r))) ?? null,
      };
      return q;
    },
    insert: async (_: any, data: any) => {
      const id = "id" + rows.length;
      rows.push({ ...data, _id: id, at: rows.length });
      return id;
    },
    patch: async (id: any, data: any) =>
      Object.assign(
        rows.find((r) => r._id === id),
        data,
      ),
  };
  return { db };
}
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
it("locks concurrent replacement requests on the same order", async () => {
  const ctx = fixture(),
    a = { thread_id: "one", request_id: "request-one", snapshot: "kit" };
  await call(begin, ctx, a);
  await expect(
    call(begin, ctx, { ...a, request_id: "request-two" }),
  ).rejects.toThrow(/already running/);
});
it("returns a durable applied receipt without replaying writes", async () => {
  const ctx = fixture(),
    a = { thread_id: "one", request_id: "request-one", snapshot: "kit" };
  const entry = await call(begin, ctx, a);
  await call(finish, ctx, { id: entry.id, state: "applied" });
  expect((await call(receipt, ctx, { request_id: a.request_id })).state).toBe(
    "applied",
  );
  expect((await call(begin, ctx, a)).state).toBe("applied");
});
it("rejects reuse with another kit or order", async () => {
  const ctx = fixture(),
    a = { thread_id: "one", request_id: "request-one", snapshot: "kit" };
  await call(begin, ctx, a);
  await expect(call(begin, ctx, { ...a, snapshot: "other" })).rejects.toThrow(
    /changed/,
  );
  await expect(call(begin, ctx, { ...a, thread_id: "two" })).rejects.toThrow(
    /changed/,
  );
});
it("keeps an uncertain provider result locked for operator review", async () => {
  const ctx = fixture(),
    a = { thread_id: "one", request_id: "request-one", snapshot: "kit" };
  const entry = await call(begin, ctx, a);
  await call(finish, ctx, { id: entry.id, state: "attention" });
  await expect(
    call(begin, ctx, { ...a, request_id: "request-two" }),
  ).rejects.toThrow(/operator check/);
});
