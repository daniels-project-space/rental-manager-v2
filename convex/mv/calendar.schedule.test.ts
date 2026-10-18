import { describe, expect, it } from "vitest";
import { dirtySince } from "./calendar";

describe("calendar schedule invalidation", () => {
  it("detects deterministic corrections independently of model extraction freshness", async () => {
    const indexes: string[] = [];
    const ctx: any = { db: { query: () => {
      let index: string;
      const query: any = {
        withIndex: (name: string) => { indexes.push(name); index = name; return query; },
        order: () => query,
        take: async () => index === "by_schedule_updated_at"
          ? [{ account_slug: "dbcinema", schedule_updated_at: 2000 }]
          : [],
      };
      return query;
    } } };
    expect(await (dirtySince as any)._handler(ctx, { sinceMs: 1000 }))
      .toEqual({ dirty: true, slugs: ["dbcinema"] });
    expect(indexes).toContain("by_schedule_updated_at");
  });
});
