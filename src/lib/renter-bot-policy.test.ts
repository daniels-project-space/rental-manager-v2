import { describe, expect, it } from "vitest";
import { allowsRenterBotMeteredFallback } from "./renter-bot-policy";

describe("renter draft model policy", () => {
  it("keeps metered fallback off by default", () => {
    expect(allowsRenterBotMeteredFallback(undefined)).toBe(false);
  });

  it("does not accept truthy-looking or mixed-case values", () => {
    expect(allowsRenterBotMeteredFallback("1")).toBe(false);
    expect(allowsRenterBotMeteredFallback("TRUE")).toBe(false);
  });

  it("requires an explicit exact opt-in", () => {
    expect(allowsRenterBotMeteredFallback("true")).toBe(true);
  });
});
