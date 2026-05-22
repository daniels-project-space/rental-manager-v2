// Unit tests for WallE chat helpers (metadata packing, quota math).
// Repo pattern: convex/lib/*.test.ts — pure helpers only, no convex-test
// harness for handler-level integration.

import { describe, it, expect } from "vitest";

// Mirror of compactSession's metadata filter logic.
function isCompactTarget(
  metadata: string | undefined,
  sessionId: string,
): boolean {
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as {
      sessionId?: string;
      compactedAt?: number | null;
    };
    return parsed.sessionId === sessionId && !parsed.compactedAt;
  } catch {
    return false;
  }
}

// Mirror of getJokeQuota's day key.
function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

describe("WallE chat — metadata session filter", () => {
  it("matches turns with the same sessionId and no compactedAt", () => {
    const meta = JSON.stringify({ sessionId: "s-1", compactedAt: null });
    expect(isCompactTarget(meta, "s-1")).toBe(true);
  });

  it("excludes already-compacted turns", () => {
    const meta = JSON.stringify({ sessionId: "s-1", compactedAt: 1716000000000 });
    expect(isCompactTarget(meta, "s-1")).toBe(false);
  });

  it("excludes turns from other sessions", () => {
    const meta = JSON.stringify({ sessionId: "s-2", compactedAt: null });
    expect(isCompactTarget(meta, "s-1")).toBe(false);
  });

  it("excludes turns with no metadata", () => {
    expect(isCompactTarget(undefined, "s-1")).toBe(false);
  });

  it("survives malformed metadata", () => {
    expect(isCompactTarget("{not-json", "s-1")).toBe(false);
  });
});

describe("WallE chat — joke quota math", () => {
  const CAP = 2;
  function quotaState(used: number) {
    return {
      used,
      cap: CAP,
      remaining: Math.max(0, CAP - used),
    };
  }

  it("starts at 0 used / 2 remaining", () => {
    expect(quotaState(0)).toEqual({ used: 0, cap: 2, remaining: 2 });
  });

  it("after first joke: 1 used / 1 remaining", () => {
    expect(quotaState(1)).toEqual({ used: 1, cap: 2, remaining: 1 });
  });

  it("after second joke: cap hit", () => {
    expect(quotaState(2)).toEqual({ used: 2, cap: 2, remaining: 0 });
  });

  it("remaining never goes negative", () => {
    expect(quotaState(5)).toEqual({ used: 5, cap: 2, remaining: 0 });
  });
});

describe("WallE chat — day key (UTC YYYY-MM-DD)", () => {
  it("produces stable 10-char ISO date", () => {
    const d = new Date(Date.UTC(2026, 4, 22, 14, 30)); // May 22 2026 14:30 UTC
    expect(todayKey(d)).toBe("2026-05-22");
  });

  it("uses UTC not local — late-night UTC boundary", () => {
    const d = new Date(Date.UTC(2026, 4, 22, 23, 59));
    expect(todayKey(d)).toBe("2026-05-22");
  });
});
