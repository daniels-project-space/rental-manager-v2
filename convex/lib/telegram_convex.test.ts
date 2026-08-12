import { describe, expect, it } from "vitest";
import { automatedTelegramAlertsEnabled } from "./telegram_convex";

describe("automated Telegram alert gate", () => {
  it("fails closed unless automatic alerts were explicitly enabled", () => {
    expect(automatedTelegramAlertsEnabled(undefined)).toBe(false);
    expect(automatedTelegramAlertsEnabled("0")).toBe(false);
    expect(automatedTelegramAlertsEnabled("all")).toBe(false);
  });

  it("permits only the explicit operator opt-in", () => {
    expect(automatedTelegramAlertsEnabled("1")).toBe(true);
  });
});
