/**
 * Guards the pickup-hours cascade. The middle tier (operator's global
 * settings.pickup_hours) was MISSING from the renter-bot draft path until
 * 2026-08-18 — an account with no per-account windows got a hardcoded literal
 * instead of the operator's real setting, so editing the global hours in
 * Settings silently never reached renters, and the draft path disagreed with
 * convex/replyInbox.ts which had always cascaded correctly.
 */
import { describe, it, expect } from "vitest";
import {
  resolvePickupHours,
  remainingWindowsToday,
  toMinutes,
  FALLBACK_PICKUP_HOURS,
  type PickupWindow,
} from "./pickup-hours";

const PER_ACCOUNT: PickupWindow[] = [{ start: "09:00", end: "11:00" }];
const GLOBAL: PickupWindow[] = [
  { start: "14:00", end: "16:00" },
  { start: "20:00", end: "22:00" },
];

describe("resolvePickupHours — three-tier cascade", () => {
  it("prefers a per-account override over everything", () => {
    expect(resolvePickupHours(PER_ACCOUNT, GLOBAL)).toEqual(PER_ACCOUNT);
  });

  it("THE REGRESSION: falls back to the operator's global setting, not the hardcode", () => {
    // This is the exact case the bug got wrong. An account whose windows are
    // empty must inherit what the operator actually configured globally —
    // which is what SettingsDrawer promises with "Using the shared fallback
    // windows." — NOT the historical 10-12/19-21 literal.
    expect(resolvePickupHours([], GLOBAL)).toEqual(GLOBAL);
    expect(resolvePickupHours(null, GLOBAL)).toEqual(GLOBAL);
    expect(resolvePickupHours(undefined, GLOBAL)).toEqual(GLOBAL);
    expect(resolvePickupHours([], GLOBAL)).not.toEqual(FALLBACK_PICKUP_HOURS);
  });

  it("uses the hardcoded last resort only when neither tier is set", () => {
    expect(resolvePickupHours(null, null)).toEqual(FALLBACK_PICKUP_HOURS);
    expect(resolvePickupHours([], [])).toEqual(FALLBACK_PICKUP_HOURS);
  });

  it("treats an empty array as 'not set' at every tier, like the Settings UI does", () => {
    expect(resolvePickupHours([], [])).toEqual(FALLBACK_PICKUP_HOURS);
    expect(resolvePickupHours([], GLOBAL)).toEqual(GLOBAL);
  });
});

describe("remainingWindowsToday", () => {
  it("drops windows that have already ended", () => {
    const out = remainingWindowsToday(FALLBACK_PICKUP_HOURS, "13:00");
    expect(out).toEqual([{ start: "19:00", end: "21:00" }]);
  });

  it("drops a window too close to its end to be arrangeable (buffer)", () => {
    // 11:58 — the 10:00-12:00 slot technically hasn't ended, but offering it
    // would promise a pickup nobody can make.
    const out = remainingWindowsToday(FALLBACK_PICKUP_HOURS, "11:58");
    expect(out).toEqual([{ start: "19:00", end: "21:00" }]);
  });

  it("keeps every window early in the day", () => {
    expect(remainingWindowsToday(FALLBACK_PICKUP_HOURS, "08:00")).toHaveLength(2);
  });

  it("returns nothing once the last window has passed", () => {
    expect(remainingWindowsToday(FALLBACK_PICKUP_HOURS, "22:30")).toHaveLength(0);
  });

  it("operates on the RESOLVED windows, so a global-only account is filtered correctly", () => {
    const resolved = resolvePickupHours([], GLOBAL);
    // 15:00 — inside the global 14:00-16:00 window, which the buggy path would
    // never have known about at all.
    expect(remainingWindowsToday(resolved, "15:00")).toEqual([
      { start: "14:00", end: "16:00" },
      { start: "20:00", end: "22:00" },
    ]);
  });
});

describe("toMinutes", () => {
  it("parses HH:MM", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("10:30")).toBe(630);
    expect(toMinutes("23:59")).toBe(1439);
  });

  it("does not silently coerce unparseable input to midnight", () => {
    expect(Number.isNaN(toMinutes("not-a-time"))).toBe(true);
  });
});
