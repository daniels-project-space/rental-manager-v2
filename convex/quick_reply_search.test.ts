import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { __nativePage, page, remainingSearchTerms } from "./quick_reply_search";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function context(texts: string[]) {
  const calls: unknown[] = [];
  const ctx = {
    db: {
      query: (table: string) => {
        expect(table).toBe("hygglo_messages");
        return {
          withIndex: (index: string, bind: any) => {
            expect(index).toBe("by_thread");
            bind({
              eq: (field: string, id: string) => {
                expect(field).toBe("thread_id");
                expect(id).toBe("fixture-thread");
                return {};
              },
            });
            return {
              order: (order: string) => {
                expect(order).toBe("desc");
                return {
                  paginate: async (args: any) => {
                    expect(args.numItems).toBe(16);
                    calls.push(args);
                    const start = Number(args.cursor ?? 0);
                    const items = texts.slice(start, start + args.numItems);
                    return {
                      page: items.map((body_text) => ({ body_text })),
                      isDone: start + items.length >= texts.length,
                      continueCursor: String(start + items.length),
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
  };
  return { ctx, calls };
}
describe("read-only complete message history", () => {
  it("finds words on different pages beyond the latest 40 messages", async () => {
    const texts = Array.from({ length: 65 }, () => "recent ordinary text");
    texts[43] = "Café pickup";
    texts[62] = "acetate screening";
    const f = context(texts);
    let terms = ["café", "acetate"],
      cursor: string | null = null,
      result: any;
    do {
      result = await (__nativePage as any)._handler(f.ctx, {
        thread_id: "fixture-thread",
        terms,
        cursor,
      });
      terms = result.remaining;
      cursor = result.cursor;
    } while (!result.done);
    expect(result.remaining).toEqual([]);
    expect(f.calls).toHaveLength(4);
  });
  it("stops early once all terms match and reports missing terms at the end", async () => {
    const f = context(["pickup times", "location café"]);
    expect(
      await (__nativePage as any)._handler(f.ctx, {
        thread_id: "fixture-thread",
        terms: ["MISSING"],
        cursor: null,
      }),
    ).toMatchObject({ remaining: ["missing"], done: true, cursor: null });
    expect(
      remainingSearchTerms(["  CAFÉ  ", "café"], ["location café"]),
    ).toEqual([]);
    await expect(
      (__nativePage as any)._handler(f.ctx, {
        thread_id: "fixture-thread",
        terms: Array(33).fill("x"),
        cursor: null,
      }),
    ).rejects.toThrow("32 search words");
  });
  it("rejects nonowners before querying history", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "true");
    vi.stubEnv("CONVEX_SITE_URL", "https://fixture.convex.site");
    const runQuery = vi.fn();
    await expect(
      (page as any)._handler(
        { auth: { getUserIdentity: async () => null }, runQuery },
        { requests: [] },
      ),
    ).rejects.toThrow();
    expect(runQuery).not.toHaveBeenCalled();
  });
  it("routes native and website pages read-only and returns IDs without message bodies", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-only");
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      const input = JSON.parse(String(options.body));
      expect(input.path).toBe("rentalChatSearch:page");
      expect(_url).toBe("https://fixture.invalid/api/action");
      return new Response(
        JSON.stringify({
          status: "success",
          value: [
            {
              bookingId: "booking",
              remaining: [],
              done: true,
              cursor: null,
              scanned: 1,
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const runQuery = vi.fn(async (ref: any, args: any) => {
      expect(getFunctionName(ref)).toBe("quick_reply_search:__nativePage");
      expect(args.thread_id).toBe("fixture-thread");
      return { remaining: [], done: true, cursor: null, scanned: 1 };
    });
    const result = await (page as any)._handler(
      { runQuery },
      {
        requests: [
          { thread_id: "fixture-thread", terms: ["pickup"], cursor: null },
          {
            thread_id: "web:booking",
            booking_id: "booking",
            terms: ["location"],
            cursor: null,
          },
        ],
      },
    );
    expect(result.results.map((r: any) => r.thread_id)).toEqual([
      "fixture-thread",
      "web:booking",
    ]);
    expect(JSON.stringify(result)).not.toContain("body_text");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves native results when the website history source fails", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("DBCINEMA_CONVEX_URL", "https://fixture.invalid");
    vi.stubEnv("DBCINEMA_ADMIN_TOKEN", "fixture-only");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Error("Source unavailable");
      }),
    );
    const result = await (page as any)._handler(
      {
        runQuery: async () => ({
          remaining: [],
          done: true,
          cursor: null,
          scanned: 1,
        }),
      },
      {
        requests: [
          { thread_id: "native", terms: ["pickup"], cursor: null },
          {
            thread_id: "web",
            booking_id: "booking",
            terms: ["pickup"],
            cursor: null,
          },
        ],
      },
    );
    expect(result.results[0]).toMatchObject({
      thread_id: "native",
      remaining: [],
    });
    expect(result.results[1]).toMatchObject({
      thread_id: "web",
      remaining: ["pickup"],
      error: expect.stringContaining("Website"),
    });
  });
});
