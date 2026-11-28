import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, labGenerationStatusFromProbe, renterBotLabStatusFromEnv } from "./route";
import { renterBotLabBackendSourceRevision } from "@/lib/renter-bot-lab-source";
import { RENTER_BOT_LAB_API_CONTRACT_VERSION } from "../../../../../convex/lib/renter_bot_lab_contract";

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
  it("requires the backend and the actual draft API to match the current contract and source", () => {
    expect(labGenerationStatusFromProbe({ status: "success", value: { ready: true } })).toMatchObject({
      generation_ready: false,
      backend_contract_version: null,
      expected_backend_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
      backend_contract_matches: false,
      draft_api_contract_version: null,
      draft_api_contract_matches: false,
      draft_api_source_matches: false,
    });
    expect(labGenerationStatusFromProbe({ status: "success", value: { ready: true, api_contract_version: "older-turn-contract" } }))
      .toMatchObject({ generation_ready: false, backend_contract_matches: false });
    const matchingProbe = {
      status: "success",
      value: {
        ready: true,
        chat_action_registered: true,
        api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        backend_source_revision: renterBotLabBackendSourceRevision(validEnv),
        draft_api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        draft_api_source_revision: validEnv.VERCEL_GIT_COMMIT_SHA,
      },
    };
    expect(labGenerationStatusFromProbe(matchingProbe, validEnv))
      .toMatchObject({ generation_ready: true, backend_contract_matches: true, draft_api_contract_matches: true, draft_api_source_matches: true });
    expect(labGenerationStatusFromProbe({
      ...matchingProbe,
      value: { ...matchingProbe.value, chat_action_registered: false },
    }, validEnv)).toMatchObject({ generation_ready: false, chat_action_registered: false });
    expect(labGenerationStatusFromProbe({
      ...matchingProbe,
      value: { ...matchingProbe.value, draft_api_source_revision: "b".repeat(40) },
    }, validEnv)).toMatchObject({ generation_ready: false, draft_api_source_matches: false });
    expect(labGenerationStatusFromProbe({
      ...matchingProbe,
      value: { ...matchingProbe.value, draft_api_contract_version: "stale-generator" },
    }, validEnv)).toMatchObject({ generation_ready: false, draft_api_contract_matches: false });
  });

  it("reports the isolated hosted backend and confirms live chat is off", () => {
    expect(renterBotLabStatusFromEnv(validEnv)).toMatchObject({
      deployment: "hosted", live_chat_authorized: false, openrouter_configured: true,
      source_revision: "a".repeat(40), lab_backend_id: "clean-bulldog-494.convex.cloud", model_id: "google/gemini-3.7-flash",
    });
  });

  it("labels local development as unpinned instead of implying a tested commit", () => {
    expect(renterBotLabStatusFromEnv({ ...validEnv, NODE_ENV: "development", VERCEL_GIT_COMMIT_SHA: undefined }))
      .toMatchObject({ source_revision: "local-development-unpinned" });
  });

  it("accepts only an exactly fingerprinted, loopback-only local Lab configuration", () => {
    const localEnv = {
      NODE_ENV: "development",
      RENTER_BOT_LAB_DEPLOYMENT: "local",
      RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "false",
      RENTER_BOT_LAB_CONVEX_URL: "http://127.0.0.1:3214",
      NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL: "http://127.0.0.1:3214",
      RENTER_BOT_LAB_API_BASE_URL: "http://127.0.0.1:3000",
      RENTER_BOT_LAB_API_SECRET: "isolated-local-secret",
      OPENROUTER_API_KEY: "configured",
      RENTER_BOT_LAB_SOURCE_REVISION: "local:" + "c".repeat(16),
      RENTER_BOT_LAB_API_SOURCE_FINGERPRINT: "d".repeat(64),
    };
    expect(renterBotLabStatusFromEnv(localEnv)).toMatchObject({
      deployment: "local", live_chat_authorized: false, openrouter_configured: true,
      source_revision: localEnv.RENTER_BOT_LAB_SOURCE_REVISION, lab_backend_id: "127.0.0.1:3214",
    });
    expect(renterBotLabStatusFromEnv({ ...localEnv, NODE_ENV: "production" })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...localEnv, RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "true" })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...localEnv, RENTER_BOT_LAB_CONVEX_URL: "https://clean-bulldog-494.convex.cloud" })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...localEnv, RENTER_BOT_LAB_API_BASE_URL: "https://manager.example" })).toBeNull();
    expect(renterBotLabStatusFromEnv({ ...localEnv, RENTER_BOT_LAB_SOURCE_REVISION: undefined }))
      .toMatchObject({ deployment: "local", source_revision: expect.stringMatching(/^local:[a-f0-9]{20}$/) });
  });

  it("requires an imported local rental catalogue before declaring the Lab ready", () => {
    const localEnv = {
      NODE_ENV: "development",
      RENTER_BOT_LAB_DEPLOYMENT: "local",
      RENTER_BOT_LAB_SOURCE_REVISION: "local:" + "c".repeat(16),
      RENTER_BOT_LAB_API_SOURCE_FINGERPRINT: "d".repeat(64),
    };
    const localProbe = {
      status: "success",
      value: {
        ready: true,
        chat_action_registered: true,
        api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        backend_source_revision: renterBotLabBackendSourceRevision(localEnv),
        draft_api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        draft_api_source_revision: localEnv.RENTER_BOT_LAB_SOURCE_REVISION,
        catalog_ready: true,
        catalog_status: "ready",
        catalog_fetched_at: Date.now(),
        catalog_inventory_count: 108,
        catalog_listing_count: 1165,
        catalog_eligible_listing_count: 283,
        catalog_blocked_listing_count: 882,
      },
    };
    expect(labGenerationStatusFromProbe(localProbe, localEnv)).toMatchObject({
      generation_ready: true, catalog_ready: true, catalog_status: "ready", catalog_inventory_count: 108,
    });
    expect(labGenerationStatusFromProbe({
      ...localProbe,
      value: { ...localProbe.value, catalog_ready: false },
    }, localEnv)).toMatchObject({ generation_ready: false, catalog_ready: false });
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
      JSON.stringify({ status: "success", value: {
        ready: true,
        chat_action_registered: true,
        api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        backend_source_revision: renterBotLabBackendSourceRevision(process.env),
        draft_api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        draft_api_source_revision: validEnv.VERCEL_GIT_COMMIT_SHA,
      } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      deployment: "hosted", live_chat_authorized: false, generation_ready: true,
      backend_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
      backend_contract_matches: true,
      draft_api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
      draft_api_contract_matches: true,
      draft_api_source_revision: validEnv.VERCEL_GIT_COMMIT_SHA,
      expected_source_revision: validEnv.VERCEL_GIT_COMMIT_SHA,
      draft_api_source_matches: true,
    });
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "true");
    expect((await GET()).status).toBe(404);
  });

  it("probes the local Convex action endpoint and matches the local generator fingerprint", async () => {
    const sourceRevision = "local:" + "c".repeat(16);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RENTER_BOT_LAB_DEPLOYMENT", "local");
    vi.stubEnv("RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED", "false");
    vi.stubEnv("RENTER_BOT_LAB_CONVEX_URL", "http://127.0.0.1:3214");
    vi.stubEnv("NEXT_PUBLIC_RENTER_BOT_LAB_CONVEX_URL", "http://127.0.0.1:3214");
    vi.stubEnv("RENTER_BOT_LAB_API_BASE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("RENTER_BOT_LAB_API_SECRET", "isolated-local-secret");
    vi.stubEnv("OPENROUTER_API_KEY", "configured");
    vi.stubEnv("RENTER_BOT_LAB_SOURCE_REVISION", sourceRevision);
    vi.stubEnv("RENTER_BOT_LAB_API_SOURCE_FINGERPRINT", "d".repeat(64));
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:3214/api/action");
      return new Response(JSON.stringify({ status: "success", value: {
        ready: true,
        chat_action_registered: true,
        api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        backend_source_revision: renterBotLabBackendSourceRevision(process.env),
        draft_api_contract_version: RENTER_BOT_LAB_API_CONTRACT_VERSION,
        draft_api_source_revision: sourceRevision,
        catalog_ready: true,
        catalog_status: "ready",
        catalog_fetched_at: Date.now(),
        catalog_inventory_count: 108,
        catalog_listing_count: 1165,
        catalog_eligible_listing_count: 283,
        catalog_blocked_listing_count: 882,
      } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deployment: "local", live_chat_authorized: false, generation_ready: true,
      backend_contract_matches: true, draft_api_contract_matches: true,
      draft_api_source_revision: sourceRevision, expected_source_revision: sourceRevision,
      draft_api_source_matches: true,
      catalog_ready: true, catalog_status: "ready", catalog_listing_count: 1165,
    });
  });
});
