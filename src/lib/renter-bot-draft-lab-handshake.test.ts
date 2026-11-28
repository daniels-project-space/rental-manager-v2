import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renterBotDraftLabHandshake } from "./renter-bot-draft-lab-handshake";
import { RENTER_BOT_LAB_API_CONTRACT_VERSION } from "../../convex/lib/renter_bot_lab_contract";

describe("draft API Lab source handshake", () => {
  beforeEach(() => {
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "hosted");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_API_SECRET", "isolated-test-secret");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
  });

  afterEach(() => vi.unstubAllEnvs());

  it("does not disclose source details without the Lab-only secret", async () => {
    const response = renterBotDraftLabHandshake(new Request("https://manager.test/api/renter-bot-draft"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns the exact generator contract and source revision to the isolated backend", async () => {
    const response = renterBotDraftLabHandshake(new Request("https://manager.test/api/renter-bot-draft", {
      headers: {
        Authorization: "Bearer isolated-test-secret",
        "X-Renter-Bot-Lab": "true",
      },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
      source_revision: "a".repeat(40),
    });
  });

  it("allows the same handshake for the explicitly local, probe-only generator", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
    const response = renterBotDraftLabHandshake(new Request("http://127.0.0.1:3000/api/renter-bot-draft", {
      headers: { Authorization: "Bearer isolated-test-secret", "X-Renter-Bot-Lab": "true" },
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
    });
    expect(payload.source_revision).toMatch(/^local:[a-f0-9]{20}$/);
    vi.stubEnv("NODE_ENV", "production");
    expect(renterBotDraftLabHandshake(new Request("https://manager.test/api/renter-bot-draft", {
      headers: { Authorization: "Bearer isolated-test-secret", "X-Renter-Bot-Lab": "true" },
    })).status).toBe(401);
  });
});
