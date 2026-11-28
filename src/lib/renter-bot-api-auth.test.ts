import { describe, expect, it } from "vitest";
import { hostedLabDraftApiAuthAllowed, renterBotDraftApiAuthMode, renterBotDraftApiUsesLabAgent } from "./renter-bot-api-auth";

describe("renter-bot draft API credentials", () => {
  const hosted = {
    RENTER_BOT_API_SECRET: "service-secret",
    RENTER_BOT_LAB_API_SECRET: "lab-secret",
    RENTER_BOT_LAB_DEPLOYMENT: "hosted",
    RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "false",
  };

  it("keeps service traffic on its existing credential and scopes Lab calls to probes", () => {
    expect(renterBotDraftApiAuthMode("Bearer service-secret", hosted)).toBe("service");
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", hosted)).toBe("hosted-lab");
    expect(hostedLabDraftApiAuthAllowed("hosted-lab", "__probe__session")).toBe(true);
    expect(hostedLabDraftApiAuthAllowed("hosted-lab", "real-renter-thread")).toBe(false);
    expect(hostedLabDraftApiAuthAllowed("service", "real-renter-thread")).toBe(true);
    expect(renterBotDraftApiUsesLabAgent("hosted-lab")).toBe(true);
    expect(renterBotDraftApiUsesLabAgent("service")).toBe(false);
  });

  it("rejects the Lab credential unless hosted mode is explicitly probe-only", () => {
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", { ...hosted, RENTER_BOT_LAB_DEPLOYMENT: "local" })).toBeNull();
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", { ...hosted, RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "true" })).toBeNull();
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", { ...hosted, RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: undefined })).toBeNull();
    expect(renterBotDraftApiAuthMode("Bearer wrong", hosted)).toBeNull();
  });

  it("keeps marked Lab requests isolated even if the service secret is identical", () => {
    const sharedSecret = { ...hosted, RENTER_BOT_API_SECRET: "same-secret", RENTER_BOT_LAB_API_SECRET: "same-secret" };
    expect(renterBotDraftApiAuthMode("Bearer same-secret", sharedSecret)).toBe("service");
    expect(renterBotDraftApiAuthMode("Bearer same-secret", sharedSecret, "true")).toBe("hosted-lab");
    expect(renterBotDraftApiAuthMode("Bearer service-secret", sharedSecret, "true")).toBeNull();
  });

  it("allows local Lab credentials only in development and only for marked probe requests", () => {
    const local = { ...hosted, NODE_ENV: "development", RENTER_BOT_LAB_DEPLOYMENT: "local" };
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", local, "true")).toBe("local-lab");
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", local)).toBeNull();
    expect(hostedLabDraftApiAuthAllowed("local-lab", "__probe__local-session")).toBe(true);
    expect(hostedLabDraftApiAuthAllowed("local-lab", "real-renter-thread")).toBe(false);
    expect(renterBotDraftApiUsesLabAgent("local-lab")).toBe(true);
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", { ...local, NODE_ENV: "production" }, "true")).toBeNull();
    expect(renterBotDraftApiAuthMode("Bearer lab-secret", { ...local, RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED: "true" }, "true")).toBeNull();
  });
});
