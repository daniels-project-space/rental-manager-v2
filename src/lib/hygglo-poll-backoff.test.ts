import { describe, expect, it } from "vitest";
import {
  HYGGLO_BACKOFF_GROWTH_FACTOR,
  computeBackoffIntervalMs,
  nextQuietStreak,
} from "./hygglo-poll-backoff";

const MIN_MS = 2 * 60 * 1000;
const MAX_MS = 60 * 60 * 1000;

describe("computeBackoffIntervalMs", () => {
  it("returns the base interval unchanged at streak 0", () => {
    expect(computeBackoffIntervalMs(MIN_MS, 0, MIN_MS, MAX_MS)).toBe(MIN_MS);
  });

  it("grows by the documented +50% per consecutive quiet cycle", () => {
    expect(HYGGLO_BACKOFF_GROWTH_FACTOR).toBe(1.5);
    expect(computeBackoffIntervalMs(MIN_MS, 1, MIN_MS, MAX_MS)).toBe(Math.round(MIN_MS * 1.5));
    expect(computeBackoffIntervalMs(MIN_MS, 2, MIN_MS, MAX_MS)).toBe(Math.round(MIN_MS * 1.5 ** 2));
    expect(computeBackoffIntervalMs(MIN_MS, 3, MIN_MS, MAX_MS)).toBe(Math.round(MIN_MS * 1.5 ** 3));
  });

  it("saturates at the hard ceiling and never exceeds it", () => {
    expect(computeBackoffIntervalMs(MIN_MS, 9, MIN_MS, MAX_MS)).toBe(MAX_MS);
    expect(computeBackoffIntervalMs(MIN_MS, 50, MIN_MS, MAX_MS)).toBe(MAX_MS);
  });

  it("respects a human-dialled base above the minimum", () => {
    const base = 10 * 60 * 1000; // 10 min
    expect(computeBackoffIntervalMs(base, 0, MIN_MS, MAX_MS)).toBe(base);
    expect(computeBackoffIntervalMs(base, 1, MIN_MS, MAX_MS)).toBe(Math.round(base * 1.5));
    // Still hard-capped at the 60-minute ceiling even from a larger base.
    expect(computeBackoffIntervalMs(base, 10, MIN_MS, MAX_MS)).toBe(MAX_MS);
  });

  it("never goes below the floor even with a degenerate base", () => {
    // A degenerate (<=0 or non-finite) base falls back to the floor at
    // streak 0. Growth still applies from that substituted floor at higher
    // streaks — it is not additionally clamped to exactly the floor.
    expect(computeBackoffIntervalMs(0, 0, MIN_MS, MAX_MS)).toBe(MIN_MS);
    expect(computeBackoffIntervalMs(-100, 0, MIN_MS, MAX_MS)).toBe(MIN_MS);
    expect(computeBackoffIntervalMs(Number.NaN, 0, MIN_MS, MAX_MS)).toBe(MIN_MS);
    expect(computeBackoffIntervalMs(-100, 3, MIN_MS, MAX_MS)).toBe(Math.round(MIN_MS * 1.5 ** 3));
  });

  it("treats a fractional or negative streak conservatively", () => {
    expect(computeBackoffIntervalMs(MIN_MS, -5, MIN_MS, MAX_MS)).toBe(MIN_MS);
    expect(computeBackoffIntervalMs(MIN_MS, 2.9, MIN_MS, MAX_MS)).toBe(
      computeBackoffIntervalMs(MIN_MS, 2, MIN_MS, MAX_MS),
    );
  });
});

describe("nextQuietStreak", () => {
  it("increments when every selected order was skip-unchanged", () => {
    expect(
      nextQuietStreak(0, {
        totalOrdersSelected: 12,
        totalOrdersSkippedUnchanged: 12,
        hadErrors: false,
        anyAccountFailed: false,
      }),
    ).toBe(1);
    expect(
      nextQuietStreak(4, {
        totalOrdersSelected: 3,
        totalOrdersSkippedUnchanged: 3,
        hadErrors: false,
        anyAccountFailed: false,
      }),
    ).toBe(5);
  });

  it("resets to 0 the instant any order actually changed", () => {
    expect(
      nextQuietStreak(6, {
        totalOrdersSelected: 10,
        totalOrdersSkippedUnchanged: 9,
        hadErrors: false,
        anyAccountFailed: false,
      }),
    ).toBe(0);
    // Even fully non-quiet (nothing skipped) still resets, not decrements.
    expect(
      nextQuietStreak(6, {
        totalOrdersSelected: 10,
        totalOrdersSkippedUnchanged: 0,
        hadErrors: false,
        anyAccountFailed: false,
      }),
    ).toBe(0);
  });

  it("holds the current streak when nothing was selected this cycle", () => {
    expect(
      nextQuietStreak(3, {
        totalOrdersSelected: 0,
        totalOrdersSkippedUnchanged: 0,
        hadErrors: false,
        anyAccountFailed: false,
      }),
    ).toBe(3);
  });

  it("holds (never widens or resets) on fetch errors — never guesses", () => {
    expect(
      nextQuietStreak(3, {
        totalOrdersSelected: 10,
        totalOrdersSkippedUnchanged: 10,
        hadErrors: true,
        anyAccountFailed: false,
      }),
    ).toBe(3);
  });

  it("holds on a whole-account failure regardless of totals", () => {
    expect(
      nextQuietStreak(2, {
        totalOrdersSelected: 5,
        totalOrdersSkippedUnchanged: 5,
        hadErrors: false,
        anyAccountFailed: true,
      }),
    ).toBe(2);
  });

  it("never returns a negative streak from a corrupt stored value", () => {
    expect(
      nextQuietStreak(-3, {
        totalOrdersSelected: 0,
        totalOrdersSkippedUnchanged: 0,
        hadErrors: false,
        anyAccountFailed: false,
      }),
    ).toBe(0);
  });
});

describe("integration: full backoff lifecycle", () => {
  it("widens across a run of quiet cycles then snaps back on the first real change", () => {
    let streak = 0;
    let interval = computeBackoffIntervalMs(MIN_MS, streak, MIN_MS, MAX_MS);
    expect(interval).toBe(MIN_MS);

    for (let i = 0; i < 5; i++) {
      streak = nextQuietStreak(streak, {
        totalOrdersSelected: 8,
        totalOrdersSkippedUnchanged: 8,
        hadErrors: false,
        anyAccountFailed: false,
      });
      interval = computeBackoffIntervalMs(MIN_MS, streak, MIN_MS, MAX_MS);
    }
    expect(streak).toBe(5);
    expect(interval).toBeGreaterThan(MIN_MS);
    expect(interval).toBeLessThanOrEqual(MAX_MS);

    // A single order changing resets immediately, back to the base interval.
    streak = nextQuietStreak(streak, {
      totalOrdersSelected: 8,
      totalOrdersSkippedUnchanged: 7,
      hadErrors: false,
      anyAccountFailed: false,
    });
    interval = computeBackoffIntervalMs(MIN_MS, streak, MIN_MS, MAX_MS);
    expect(streak).toBe(0);
    expect(interval).toBe(MIN_MS);
  });

  it("reaches the 60-minute ceiling after ~9 consecutive quiet cycles from the default 2-minute base", () => {
    let streak = 0;
    for (let i = 0; i < 9; i++) {
      streak = nextQuietStreak(streak, {
        totalOrdersSelected: 5,
        totalOrdersSkippedUnchanged: 5,
        hadErrors: false,
        anyAccountFailed: false,
      });
    }
    expect(computeBackoffIntervalMs(MIN_MS, streak, MIN_MS, MAX_MS)).toBe(MAX_MS);
  });
});
