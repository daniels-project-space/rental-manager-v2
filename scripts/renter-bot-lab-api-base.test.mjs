import { describe, expect, it } from "vitest";
import { hostedRenterBotLabApiBase, hostedRenterBotLabRuntimeConfig } from "./renter-bot-lab-api-base.mjs";

describe("hostedRenterBotLabApiBase", () => {
  it("uses the verified stable production host", () => {
    expect(hostedRenterBotLabApiBase({ VERCEL_PROJECT_PRODUCTION_URL: "rental-manager-v2-nu.vercel.app" }))
      .toBe("https://rental-manager-v2-nu.vercel.app");
  });

  it("rejects a deployment-specific or unrelated host before forwarding the Lab secret", () => {
    expect(() => hostedRenterBotLabApiBase({ VERCEL_PROJECT_PRODUCTION_URL: "rental-manager-v2-preview.vercel.app" }))
      .toThrow(/does not match/);
    expect(() => hostedRenterBotLabApiBase({ VERCEL_PROJECT_PRODUCTION_URL: "" }))
      .toThrow(/requires VERCEL_PROJECT_PRODUCTION_URL/);
  });

  it("synchronizes the isolated backend mode and fails closed on real renter chat", () => {
    const config = hostedRenterBotLabRuntimeConfig({
      VERCEL_PROJECT_PRODUCTION_URL: "rental-manager-v2-nu.vercel.app",
      RENTER_BOT_LAB_API_SECRET: "lab-test-secret",
    });
    expect(config.RENTER_BOT_LAB_DEPLOYMENT).toBe("hosted");
    expect(config.RENTER_BOT_LAB_LIVE_CHAT_AUTHORIZED).toBe("false");
    expect(config.RENTER_BOT_LAB_API_SECRET).toBe("lab-test-secret");
    expect(config.RENTER_BOT_API_SECRET).toBe("lab-test-secret");
    expect(config.RENTER_BOT_LAB_AUTH_CONFIG_VERSION).toMatch(/^lab-auth-v1:[a-f0-9]{64}$/);
  });
});
