// Pure-function unit tests for mergeOrder used in edit-mode-context.tsx.
// The source file is a "use client" TSX module wired to React/Convex hooks,
// so we mirror the spec pattern from convex/dashboard_insights.spec.ts and
// inline the helper for direct verification. Keep this in sync with the
// implementation in src/lib/dashboard/edit-mode-context.tsx.

import { describe, it, expect } from "vitest";

function mergeOrder(saved: string[] | undefined, defaults: readonly string[]): string[] {
  if (!saved || saved.length === 0) return [...defaults];
  const knownDefaults = new Set(defaults);
  const savedKnown = saved.filter((id) => knownDefaults.has(id));
  const savedSet = new Set(savedKnown);
  const result: string[] = [];
  let savedIdx = 0;
  for (const defId of defaults) {
    if (!savedSet.has(defId)) {
      result.push(defId);
    } else {
      while (savedIdx < savedKnown.length && savedKnown[savedIdx] !== defId) {
        result.push(savedKnown[savedIdx++]);
      }
      if (savedIdx < savedKnown.length) result.push(savedKnown[savedIdx++]);
    }
  }
  while (savedIdx < savedKnown.length) result.push(savedKnown[savedIdx++]);
  return result;
}

describe("mergeOrder", () => {
  it("returns defaults when saved is empty/undefined", () => {
    expect(mergeOrder(undefined, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("inserts a newly-added default at its declared position (WallE bug)", () => {
    // Saved layout predates the addition of `walle` at defaults[0].
    // Old behavior: ['active', 'ongoing', 'walle'] (appended at end).
    // Fixed behavior: ['walle', 'active', 'ongoing'] (inserted at default slot).
    const saved = ["active", "ongoing"];
    const defaults = ["walle", "active", "ongoing"];
    expect(mergeOrder(saved, defaults)).toEqual(["walle", "active", "ongoing"]);
  });

  it("preserves user reordering between known ids", () => {
    const saved = ["ongoing", "active"]; // user swapped order
    const defaults = ["walle", "active", "ongoing"];
    // walle inserted at default position 0; existing user order preserved after.
    expect(mergeOrder(saved, defaults)).toEqual(["walle", "ongoing", "active"]);
  });

  it("drops saved ids that no longer exist in defaults", () => {
    const saved = ["stale", "active", "removed", "ongoing"];
    const defaults = ["walle", "active", "ongoing"];
    expect(mergeOrder(saved, defaults)).toEqual(["walle", "active", "ongoing"]);
  });

  it("inserts a new mid-list default at its declared position", () => {
    const saved = ["a", "c"];
    const defaults = ["a", "b", "c"];
    expect(mergeOrder(saved, defaults)).toEqual(["a", "b", "c"]);
  });

  it("inserts a new tail default at end", () => {
    const saved = ["a", "b"];
    const defaults = ["a", "b", "c"];
    expect(mergeOrder(saved, defaults)).toEqual(["a", "b", "c"]);
  });

  it("identity when saved matches defaults exactly", () => {
    const saved = ["a", "b", "c"];
    const defaults = ["a", "b", "c"];
    expect(mergeOrder(saved, defaults)).toEqual(["a", "b", "c"]);
  });
});
