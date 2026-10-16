import { describe, expect, it } from "vitest";
import type { QueryCtx } from "../_generated/server";
import { profileReadonlyDatabase } from "./profile_readonly";
import { __service_getReplyQueue, __service_getThreadById } from "../replyInbox";

describe("opt-in readonly attribution", () => {
  const document = { _id: "one", _creationTime: 1, name: "unchanged" };
  function database() {
    const query = { withIndex() { return this; }, order() { return this; },
      async collect() { return [document]; }, async first() { return document; },
      async paginate() { return { page: [document], isDone: true, continueCursor: "" }; },
      async *[Symbol.asyncIterator]() { yield document; } };
    return { query: () => query, get: async () => document, normalizeId: () => "one" } as unknown as QueryCtx["db"];
  }
  it("preserves chained reads, pagination, iteration, point identity and bound methods", async () => {
    const { db, report } = profileReadonlyDatabase(database());
    const query = db.query("items").withIndex("by_slug");
    expect((await query.collect())[0]).toBe(document);
    expect(await query.first()).toBe(document);
    expect((await query.paginate({ cursor: null, numItems: 1 })).page[0]).toBe(document);
    for await (const row of query) expect(row).toBe(document);
    expect(await db.get("one" as never)).toBe(document);
    expect(db.normalizeId("items", "one")).toBe("one");
    expect(report().find((r) => r.operation === "items:by_slug:collect")).toMatchObject({ calls: 1, returnedDocuments: 1, uniqueDocuments: 1 });
    expect(report().find((r) => r.operation === "point:get")?.estimatedJsonBytes).toBeGreaterThan(0);
  });
  it("records repeated reads separately from unique document counts", async () => {
    const { db, report } = profileReadonlyDatabase(database());
    await db.get("one" as never); await db.get("one" as never);
    expect(report()[0]).toMatchObject({ calls: 2, returnedDocuments: 2, uniqueDocuments: 1 });
  });
  it("uses the actual registered internal service handlers", () => {
    expect(typeof (__service_getReplyQueue as unknown as { _handler: unknown })._handler).toBe("function");
    expect(typeof (__service_getThreadById as unknown as { _handler: unknown })._handler).toBe("function");
  });
});
