import { describe, expect, it } from "vitest";
import { hostedLabDraftApiAuthAllowed, renterBotDraftApiAuthMode } from "./renter-bot-api-auth";

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
});
