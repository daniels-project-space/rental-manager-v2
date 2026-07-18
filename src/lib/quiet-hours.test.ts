import { afterEach, describe, expect, it } from "vitest";
import { shouldRunHyggloPoll } from "./quiet-hours";

const savedBypass = process.env.BYPASS_QUIET_HOURS;

afterEach(() => {
  if (savedBypass === undefined) delete process.env.BYPASS_QUIET_HOURS;
  else process.env.BYPASS_QUIET_HOURS = savedBypass;
});

describe("shouldRunHyggloPoll", () => {
  it("keeps every scheduled poll inside the London active window", () => {
    expect(shouldRunHyggloPoll(new Date("2026-07-17T11:15:00Z"))).toBe(true);
  });

  it("runs once per hour outside the active window", () => {
    // BST: 23:00Z = 00:00 London; 23:15Z = 00:15 London.
    expect(shouldRunHyggloPoll(new Date("2026-07-17T23:00:00Z"))).toBe(true);
    expect(shouldRunHyggloPoll(new Date("2026-07-17T23:15:00Z"))).toBe(false);

    // The hard 01:00-08:00 break is now hourly rather than a total blackout.
    expect(shouldRunHyggloPoll(new Date("2026-07-18T02:00:00Z"))).toBe(true);
    expect(shouldRunHyggloPoll(new Date("2026-07-18T02:15:00Z"))).toBe(false);
  });

  it("always runs an operator-triggered manual poll", () => {
    expect(shouldRunHyggloPoll(new Date("2026-07-18T02:15:00Z"), true)).toBe(true);
  });
});
