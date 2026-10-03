import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestConvexClient } from "./convex-request-context";

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), query: vi.fn(), setAuth: vi.fn(), setAdminAuth: vi.fn() }));
vi.mock("./auth-server", () => ({ getToken: mocks.getToken }));
vi.mock("convex/browser", () => ({ ConvexHttpClient: class {
  query = mocks.query; setAuth = mocks.setAuth; setAdminAuth = mocks.setAdminAuth;
} }));
import { withOwnerRoute, withServiceRoute } from "./owner-http-route";

const request = () => new Request("https://example.invalid/api/chat", { method: "POST" });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("OWNER_AUTH_REQUIRED", "true"); vi.stubEnv("CONVEX_URL", "https://hearty-oyster-600.convex.cloud"); });
afterEach(() => vi.unstubAllEnvs());

describe("owner API boundary", () => {
  it("rejects missing, expired, and non-owner sessions before running the handler", async () => {
    const handler = vi.fn(async () => new Response("should not run"));
    const route = withOwnerRoute(handler);
    mocks.getToken.mockResolvedValue(undefined);
    expect((await route(request())).status).toBe(401);
    mocks.getToken.mockResolvedValue("test-owner-jwt");
    mocks.query.mockResolvedValue({ authenticated: false, isOwner: false });
    expect((await route(request())).status).toBe(401);
    mocks.query.mockResolvedValue({ authenticated: true, isOwner: false });
    expect((await route(request())).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(mocks.setAdminAuth).not.toHaveBeenCalled();
  });

  it("forwards the verified owner JWT into handler and subsequent tool clients", async () => {
    mocks.getToken.mockResolvedValue("test-owner-jwt");
    mocks.query.mockResolvedValue({ authenticated: true, isOwner: true });
    const handler = vi.fn(async (_req, client) => {
      expect(createRequestConvexClient()).not.toBe(client);
      await Promise.resolve();
      createRequestConvexClient();
      return new Response("owner");
    });
    expect(await (await withOwnerRoute(handler)(request())).text()).toBe("owner");
    expect(mocks.getToken).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.setAuth).toHaveBeenCalledTimes(4);
    expect(mocks.setAuth.mock.calls.every(([token]) => token === "test-owner-jwt")).toBe(true);
    expect(mocks.setAdminAuth).not.toHaveBeenCalled();
  });

  it("fails closed on an auth outage or an invalid rollout configuration", async () => {
    const handler = vi.fn(async () => new Response("should not run"));
    mocks.getToken.mockRejectedValue(new Error("auth unavailable"));
    expect((await withOwnerRoute(handler)(request())).status).toBe(503);
    vi.stubEnv("OWNER_AUTH_REQUIRED", "tru");
    expect((await withOwnerRoute(handler)(request())).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("retains anonymous compatibility only while the rollout switch is disabled", async () => {
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    mocks.getToken.mockResolvedValue(undefined);
    const handler = vi.fn(async () => new Response("transition"));
    expect((await withOwnerRoute(handler)(request())).status).toBe(200);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.setAdminAuth).not.toHaveBeenCalled();
  });

  it("propagates private service identity while retaining the endpoint's own secret check", async () => {
    vi.stubEnv("CONVEX_DEPLOY_KEY", "test-only-key");
    const handler = vi.fn(async () => {
      createRequestConvexClient();
      return new Response("unauthorized", { status: 401 });
    });
    expect((await withServiceRoute(handler)(request())).status).toBe(401);
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.setAdminAuth).toHaveBeenCalledTimes(2);
    expect(mocks.setAuth).not.toHaveBeenCalled();
  });
});
