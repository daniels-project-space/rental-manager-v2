// Verify the actual layout helper used by the dashboard provider.
import { describe, it, expect } from "vitest";
import { mergeOrder } from "./layout-order";

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
