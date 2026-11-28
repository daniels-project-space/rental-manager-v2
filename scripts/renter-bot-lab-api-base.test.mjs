import { describe, expect, it } from "vitest";
import { hostedRenterBotLabApiBase } from "./renter-bot-lab-api-base.mjs";

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
});
