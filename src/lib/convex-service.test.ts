import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { createConvexServiceClient } from "./convex-service";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("private rental worker transport", () => {
  it("fails before making a request when the private credential is absent", () => {
    vi.stubEnv("CONVEX_DEPLOY_KEY", "");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => createConvexServiceClient()).toThrow("Missing private");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects the orphan deployment and browser execution", () => {
    vi.stubEnv("CONVEX_DEPLOY_KEY", "test-only-key");
    expect(() => createConvexServiceClient("https://exciting-lion-29.convex.cloud")).toThrow("Unexpected");
    vi.stubGlobal("window", {});
    expect(() => createConvexServiceClient()).toThrow("server-only");
  });

  it("sends the reserved identity through Convex admin transport", async () => {
    vi.stubEnv("CONVEX_DEPLOY_KEY", "test-only-key");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "success", value: { authenticated_service: true }, logLines: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const client = createConvexServiceClient();
    expect(await client.query(makeFunctionReference<"query">("owner_auth_probe:serviceIdentity"), {}))
      .toEqual({ authenticated_service: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://hearty-oyster-600.convex.cloud/api/query");
    const authorization = init.headers.Authorization as string;
    expect(authorization).toMatch(/^Convex test-only-key:/);
    const identity = JSON.parse(Buffer.from(authorization.split(":").at(-1)!, "base64").toString());
    expect(identity).toEqual({ issuer: "urn:rental-manager:deployment-service", subject: "rental-manager-service" });
    expect(JSON.parse(init.body).path).toBe("owner_auth_probe:serviceIdentity");
  });
});
