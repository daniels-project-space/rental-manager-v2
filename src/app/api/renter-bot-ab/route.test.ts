import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindRenterToolArgs } from "@/lib/renter-tool-scope";

const mocks = vi.hoisted(() => ({ query: vi.fn(), action: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/owner-http-route", () => ({ withOwnerRoute: (handler: Function) => (request: Request) => handler(request, { query: mocks.query, action: mocks.action }) }));
vi.mock("@/mastra/agents/renter_bot", () => ({ getRenterBotAgent: async () => ({ generate: mocks.generate }) }));
import { POST } from "./route";

const request = (body: object) => new Request("https://example.invalid/api/renter-bot-ab", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ account_slug: "leo", last_messages: [{ sender: "renter", body: "Recorded quote request" }] });
  mocks.action.mockResolvedValue({ status: "ok", draft: "Canonical draft" });
  mocks.generate.mockImplementation(async (messages: Array<{ content: string }>) => {
    expect(messages[0].content).toContain("ACCOUNT: leo");
    expect(messages[0].content).toContain("Recorded quote request");
    expect(bindRenterToolArgs("renter_bot_tools:lookup_pricing", { account_slug: "diogo" })).toEqual({ account_slug: "leo" });
    expect(() => bindRenterToolArgs("renter_bot_lab_order:applyChange", {})).toThrow("disabled");
    return { text: JSON.stringify({ draft: "Diagnostic candidate", needs_human: false }), steps: [] };
  });
});

describe("Lab comparison request grounding", () => {
  it("rejects real chats before data fetches or paid generation", async () => {
    expect((await POST(request({ thread_id: "real-renter-thread" }))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("rejects a different account or fabricated latest message before generating either candidate", async () => {
    expect((await POST(request({ thread_id: "__probe__compare", account_slug: "diogo" }))).status).toBe(409);
    expect((await POST(request({ thread_id: "__probe__compare", message: "Unrecorded message" }))).status).toBe(409);
    expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("uses the authoritative account and message and makes raw candidate tools read-only", async () => {
    const response = await POST(request({ thread_id: "__probe__compare" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ old: "Canonical draft", new: "Diagnostic candidate" });
    expect(mocks.action).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it("fails closed if the recorded context cannot be loaded", async () => {
    mocks.query.mockRejectedValueOnce(new Error("backend unavailable"));
    expect((await POST(request({ thread_id: "__probe__compare" }))).status).toBe(503);
    expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("does not compare a stale inbound message after the owner has already replied", async () => {
    mocks.query.mockResolvedValueOnce({ account_slug: "leo", last_messages: [{ sender: "renter", body: "Old request" }, { sender: "owner", body: "Already answered" }] });
    expect((await POST(request({ thread_id: "__probe__compare", message: "Old request" }))).status).toBe(409);
    expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("rejects malformed request shapes before fetching context", async () => {
    expect((await POST(request({ thread_id: 12 }))).status).toBe(400);
    expect((await POST(request(null as unknown as object))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("does not run an unreviewed candidate when canonical generation fails or skips", async () => {
    mocks.action.mockRejectedValueOnce(new Error("canonical failed"));
    expect((await POST(request({ thread_id: "__probe__compare" }))).status).toBe(503);
    mocks.action.mockResolvedValueOnce({ status: "skipped", draft: "" });
    expect((await POST(request({ thread_id: "__probe__compare" }))).status).toBe(503);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
