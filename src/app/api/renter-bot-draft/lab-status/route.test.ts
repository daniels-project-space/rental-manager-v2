import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, renterBotLabStatusFromEnv } from "./route";

afterEach(() => vi.unstubAllEnvs());

const validEnv = {
  RENTER_BOT_LAB_DEPLOYMENT: "hosted",
  RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "false",
  RENTER_BOT_LAB_CONVEX_URL: "https://clean-bulldog-494.convex.cloud",
  NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "https://clean-bulldog-494.convex.cloud",
  RENTER_BOT_LAB_CONVEX_DEPLOY_KEY: "isolated-deploy-key",
  RENTER_BOT_LAB_API_SECRET: "isolated-api-secret",
  OPENROUTER_API_KEY: "configured",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
};

describe("Renter Bot Lab status", () => {
  it("reports the isolated hosted backend and confirms live chat is off", () => {
    expect(renterBotLabStatusFromEnv(validEnv)).toMatchObject({
      deployment: "hosted", live_chat_authorized: false, openrouter_configured: true,
    });
  });

  it("fails closed if either URL points to the production rental backend", () => {
    expect(renterBotLabStatusFromEnv({ ...validEnv, RENTER_BOT_LAB_CONVEX_URL: "https://hearty-oyster-600.convex.cloud" })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...validEnv, NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "https://hearty-oyster-600.convex.cloud" })).toBeNull();
  });

  it("fails closed if model access, Lab credentials, or the explicit disabled-chat flag is missing", () => {
    expect(renterBotLabStatusFromEnv({ ...validEnv, OPENROUTER_API_KEY: undefined })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...validEnv, RENTER_BOT_LAB_API_SECRET: undefined })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...validEnv, RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "true" })).toBeNull();
  });

  it("returns 404 for a misconfigured deployment and no-store JSON for a ready Lab", async () => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_CONVEX_URL", validEnv.RENTER_BOT_LAB_CONVEX_URL);
    vi.stubEnv("NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL", validEnv.NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL);
    vi.stubEnv("RENTER_BOT_LAB_CONVEX_DEPLOY_KEY", "isolated-deploy-key");
    vi.stubEnv("RENTER_BOT_LAB_API_SECRET", "isolated-api-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "configured");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", validEnv.VERCEL_GIT_COMMIT_SHA);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ status: "success", value: { ready: true } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      deployment: "hosted", live_chat_authorized: false, generation_ready: true,
    });
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "true");
    expect((await GET()).status).toBe(404);
  });
});
