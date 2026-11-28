import { describe, expect, it } from "vitest";
import { renterBotDraftEndpoint } from "./renter_bot_draft_endpoint";

describe("renter bot draft endpoint routing", () => {
  it("binds probe turns to the explicit isolated Lab URL and Lab secret", () => {
    expect(renterBotDraftEndpoint("__probe__thread", {
      RENTER_BOT_LAB_API_BASE_URL: "https://lab-preview.example.test",
      RENTER_BOT_LAB_API_SECRET: "lab-secret",
      NOTIF_BASE_URL: "https://production.example.test",
      RENTER_BOT_API_SECRET: "production-secret",
    })).toEqual({
      url: "https://lab-preview.example.test/api/renter-bot-draft",
      authorization: "Bearer lab-secret",
      lab: true,
    });
  });

  it("fails closed for Lab when its own URL or secret is absent", () => {
    expect(() => renterBotDraftEndpoint("__probe__thread", {
      NOTIF_BASE_URL: "https://production.example.test",
      RENTER_BOT_API_SECRET: "production-secret",
    })).toThrow("Isolated Lab draft endpoint or RENTER_BOT_LAB_API_SECRET is not configured");
  });

  it("keeps normal service drafts on the normal endpoint and secret", () => {
    expect(renterBotDraftEndpoint("real-thread", {
      RENTER_BOT_LAB_API_BASE_URL: "https://lab-preview.example.test",
      RENTER_BOT_LAB_API_SECRET: "lab-secret",
      NOTIF_BASE_URL: "https://production.example.test",
      RENTER_BOT_API_SECRET: "production-secret",
    })).toEqual({
      url: "https://production.example.test/api/renter-bot-draft",
      authorization: "Bearer production-secret",
      lab: false,
    });
  });

  it("rejects non-HTTPS remote endpoints", () => {
    expect(() => renterBotDraftEndpoint("__probe__thread", {
      RENTER_BOT_LAB_API_BASE_URL: "http://remote.example.test",
      RENTER_BOT_LAB_API_SECRET: "lab-secret",
    })).toThrow("Invalid isolated Lab draft endpoint");
  });
});
