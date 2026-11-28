import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ action: vi.fn(), query: vi.fn(), readiness: vi.fn() }));

vi.mock("@/lib/owner-http-route", () => ({
  withOwnerRoute: (handler: (request: Request) => Promise<Response>) => handler,
}));
vi.mock("@/lib/convex-service", () => ({
  createRenterBotLabConvexServiceClient: () => ({ action: mocks.action, query: mocks.query }),
}));
vi.mock("@/lib/renter-bot-lab-readiness", () => ({
  ensureLabBackendGenerationReady: mocks.readiness,
}));
vi.mock("../../../../../convex/lib/renter_bot_runtime", () => ({
  renterBotRuntimeAllowed: (threadId: string) => threadId.startsWith("__probe__"),
}));

import { POST } from "./route";

const labSecret = "test-only-secret";
const expectedMarker = "lab-auth-v1:" + createHash("sha256").update(labSecret).digest("hex");
const request = (threadId = "__probe__thread") => new Request("https://manager.test/api/renter-bot-lab/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ threadId, accountSlug: "diogo", text: "Can I move the dates?", turnId: "turn-12345678" }),
});

describe("isolated renter-bot Lab chat route", () => {
  beforeEach(() => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_API_SECRET", labSecret);
    mocks.action.mockReset();
    mocks.query.mockReset();
    mocks.readiness.mockReset().mockResolvedValue({ generation_ready: true });
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("sends one server-derived capability to the canonical isolated turn executor", async () => {
    mocks.action.mockResolvedValueOnce({
      status: "ok", draft: "The guarded Lab reply.", overall_status: "pass", runId: "run-1",
    });
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, draft: "The guarded Lab reply.", runId: "run-1" });
    expect(mocks.action).toHaveBeenCalledTimes(1);
    const args = mocks.action.mock.calls[0][1];
    expect(args).toMatchObject({
      auth_marker: expectedMarker,
      threadId: "__probe__thread",
      accountSlug: "diogo",
      text: "Can I move the dates?",
      turnId: "turn-12345678",
    });
    expect(args).not.toHaveProperty("secret");
    expect(args.auth_marker).not.toBe(labSecret);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns a completed replay from the same executor without another generation call", async () => {
    mocks.action.mockResolvedValueOnce({ status: "ok", draft: "Saved reply", runId: "run-1", overall_status: "pass" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, draft: "Saved reply", runId: "run-1" });
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it("blocks an already-open Lab session when the backend source fingerprint is stale", async () => {
    mocks.readiness.mockResolvedValueOnce({ generation_ready: false, backend_source_matches: false });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "lab_backend_not_ready" });
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("returns a pending turn without launching another generation", async () => {
    mocks.action.mockResolvedValueOnce({ status: "running" });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: false, pending: true, error: "turn_generation_in_progress" });
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it("returns saved failures with the same retryable turn identity", async () => {
    mocks.action.mockResolvedValueOnce({
      status: "skipped", reason: "canonical_generation_http_502", runId: "run-2",
      generation_error: { error: "agent_failed", error_code: "upstream_timeout" },
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, reason: "canonical_generation_http_502", runId: "run-2",
      generation_error: { error_code: "upstream_timeout" },
    });
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it("rejects non-Lab threads before generation", async () => {
    const response = await POST(request("real-renter-thread"));
    expect(response.status).toBe(403);
    expect(mocks.action).not.toHaveBeenCalled();
  });

  it("uses the same executor in explicit local probe-only mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
    mocks.action.mockResolvedValueOnce({ status: "ok", draft: "Local shared-pipeline reply.", runId: "run-local" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, draft: "Local shared-pipeline reply.", runId: "run-local" });
    expect(mocks.action).toHaveBeenCalledTimes(1);
  });

  it("keeps local chat disabled outside development or when live chat is authorized", async () => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("NODE_ENV", "production");
    expect((await POST(request())).status).toBe(503);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "true");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.action).not.toHaveBeenCalled();
  });
});
