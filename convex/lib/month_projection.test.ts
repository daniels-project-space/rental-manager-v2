import { describe, expect, it } from "vitest";
import {
  pctOfTarget,
  projectCurrentMonth,
  trailingBaseline,
} from "./month_projection";

// Real numbers from hearty-oyster-600 on 2026-09-02, the day the dashboard was
// reported broken. Completed months, most recent first.
const SEPT_2026_TRAILING = [3_484.4, 4_320.0, 4_758.63];

describe("trailingBaseline", () => {
  it("weights recent months more heavily", () => {
    // 0.5*3484.4 + 0.3*4320 + 0.2*4758.63 = 3989.93
    expect(trailingBaseline(SEPT_2026_TRAILING)).toBe(3_990);
  });

  it("renormalises when fewer than three months exist", () => {
    // A two-month-old account must not be scaled down by the missing term:
    // (0.5*1000 + 0.3*1000) / 0.8 = 1000, not 800.
    expect(trailingBaseline([1_000, 1_000])).toBe(1_000);
    expect(trailingBaseline([1_000])).toBe(1_000);
  });

  it("returns 0 with no usable history rather than NaN", () => {
    expect(trailingBaseline([])).toBe(0);
    expect(trailingBaseline([0, 0, 0])).toBe(0);
    expect(trailingBaseline([Number.NaN])).toBe(0);
  });
});

describe("projectCurrentMonth", () => {
  // ── The bug this file exists to prevent ────────────────────────────
  it("does not collapse to already-booked revenue at the start of a month", () => {
    // 2026-09-02: nothing picked up yet, £835.20 booked for later in September.
    // The old formula produced £835 — identical to the Month Confirmed tile.
    const result = projectCurrentMonth({
      realisedToDate: 0,
      bookedRemainder: 835.2,
      daysElapsed: 2,
      daysInMonth: 30,
      baseline: 3_990,
    });
    expect(result.committed).toBe(835.2);
    expect(result.projected).toBeGreaterThan(3_000);
    expect(result.projected).toBeLessThan(4_100);
    // Must NOT equal the committed figure — that was the whole defect.
    expect(result.projected).not.toBe(835);
  });

  it("does not explode when a month is one day old", () => {
    // The revenue.ts pace bug divided the WHOLE month's bookings by dayOfMonth:
    // 835.20 / 1 * 30 = £25,056. Only realised-to-date may drive pace.
    const result = projectCurrentMonth({
      realisedToDate: 0,
      bookedRemainder: 835.2,
      daysElapsed: 1,
      daysInMonth: 30,
      baseline: 3_990,
    });
    expect(result.projected).toBeLessThan(4_100);
  });

  it("never projects below what is already committed", () => {
    const result = projectCurrentMonth({
      realisedToDate: 6_000,
      bookedRemainder: 2_000,
      daysElapsed: 3,
      daysInMonth: 30,
      baseline: 1_000,
    });
    expect(result.projected).toBeGreaterThanOrEqual(8_000);
    expect(result.basis).toBe("committed");
  });

  it("hands over from baseline to this month's pace as the month progresses", () => {
    const input = { bookedRemainder: 0, daysInMonth: 30, baseline: 3_000 };
    // Day 1: almost entirely baseline, despite a weak realised figure.
    const early = projectCurrentMonth({ ...input, realisedToDate: 50, daysElapsed: 1 });
    // Day 28: pace dominates — a genuinely weak month is allowed to read weak.
    const late = projectCurrentMonth({ ...input, realisedToDate: 1_400, daysElapsed: 28 });
    expect(early.projected).toBeGreaterThan(2_800);
    expect(late.projected).toBeLessThan(2_000);
  });

  it("is stable on day 0 and with a zero-length month", () => {
    expect(
      projectCurrentMonth({
        realisedToDate: 0,
        bookedRemainder: 0,
        daysElapsed: 0,
        daysInMonth: 0,
        baseline: 3_000,
      }).projected,
    ).toBe(3_000);
    expect(
      Number.isFinite(
        projectCurrentMonth({
          realisedToDate: 0,
          bookedRemainder: 0,
          daysElapsed: 0,
          daysInMonth: 31,
          baseline: 0,
        }).projected,
      ),
    ).toBe(true);
  });

  it("clamps daysElapsed to the month length", () => {
    const a = projectCurrentMonth({
      realisedToDate: 3_000, bookedRemainder: 0, daysElapsed: 31, daysInMonth: 30, baseline: 1_000,
    });
    const b = projectCurrentMonth({
      realisedToDate: 3_000, bookedRemainder: 0, daysElapsed: 30, daysInMonth: 30, baseline: 1_000,
    });
    expect(a.projected).toBe(b.projected);
  });
});

describe("pctOfTarget", () => {
  it("is no longer pinned at 100%", () => {
    // The old code did Math.min(100, committed/target) against a target that
    // WAS `projected`, so this always read exactly 100 regardless of reality.
    expect(pctOfTarget(835.2, 3_990)).toBe(21);
  });

  it("lets a strong month exceed 100%", () => {
    expect(pctOfTarget(5_000, 4_000)).toBe(125);
  });

  it("returns 0 rather than Infinity when there is no target", () => {
    expect(pctOfTarget(500, 0)).toBe(0);
  });
});
