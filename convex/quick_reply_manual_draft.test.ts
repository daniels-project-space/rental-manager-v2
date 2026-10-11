import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
import { generate } from "./quick_reply_manual_draft";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("operator draft is composition only", () => {
  function fixture() {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    vi.stubEnv("RENTER_BOT_API_SECRET", "fixture-secret");
    const queries: string[] = [];
    const ctx = {
      runMutation: vi.fn(() => { throw Error("No writes allowed"); }),
      runAction: vi.fn(() => { throw Error("No bot or provider action allowed"); }),
      runQuery: vi.fn(async (ref: any) => {
        const name = getFunctionName(ref); queries.push(name);
        if (name === "replyInbox:__service_getThreadById") return {
          renter_name: "Fixture", account_slug: "leo", booking_status: "pending",
          start_date: "2026-11-01", end_date: "2026-11-02",
          items: [{ name: "Sony FX6", qty: 1 }],
          availability: { status: "conflict", checked_at: Date.now(), items: [{name: "Sony FX6", available: false}] },
        };
        return [{role: "renter", content: "Is it available?", timestamp: Date.now()}];
      }),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({draft: "I'll check the alternatives for you."})));
    vi.stubGlobal("fetch", fetcher);
    return {ctx, queries, fetcher};
  }
  it("drafts a real-thread-shaped request without invoking the disabled bot or sending", async () => {
    const f = fixture();
    const result = await (generate as any)._handler(f.ctx, {thread_id:"real-shaped-fixture"});
    expect(result.status).toBe("ok");
    expect(f.queries).toEqual(["replyInbox:__service_getThreadById", "hygglo:__service_listByThread"]);
    expect(f.ctx.runMutation).not.toHaveBeenCalled(); expect(f.ctx.runAction).not.toHaveBeenCalled();
    const options = (f.fetcher.mock.calls[0] as any)[1];
    expect(JSON.parse(options.body).availability.items[0].available).toBe(false);
    expect(JSON.parse(options.body).messages[0].text).toBe("Is it available?");
  });
  it("reports provider failure without any write", async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response("unavailable",{status:503}));
    await expect((generate as any)._handler(f.ctx,{thread_id:"fixture"})).rejects.toThrow("temporarily unavailable");
    expect(f.ctx.runMutation).not.toHaveBeenCalled();
  });
  it("refuses an empty draft", async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response(JSON.stringify({draft:" "})));
    await expect((generate as any)._handler(f.ctx,{thread_id:"fixture"})).rejects.toThrow("empty reply");
  });
});
