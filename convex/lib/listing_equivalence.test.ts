/**
 * Tests for listing equivalence-class resolver.
 * Locks Daniel's canonical examples (GoPro / FX3 / BMPCC / Anker) and
 * validates every map candidate against MASTER_INVENTORY.
 */

import { describe, it, expect } from "vitest";
import { MASTER_INVENTORY_KEYS } from "./item_matcher";
import {
  LISTING_EQUIVALENCE_MAP,
  resolveListingToInventory,
  validateEquivalenceMap,
} from "./listing_equivalence";

const OWNED = new Set(MASTER_INVENTORY_KEYS);

describe("listing_equivalence — map integrity", () => {
  it("every candidate SKU is a real MASTER_INVENTORY key", () => {
    const { ok, errors } = validateEquivalenceMap();
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  it("LISTING_EQUIVALENCE_MAP has all keyword keys lowercased", () => {
    for (const kw of Object.keys(LISTING_EQUIVALENCE_MAP)) {
      expect(kw).toEqual(kw.toLowerCase());
    }
  });
});

describe("listing_equivalence — Daniel's canonical examples", () => {
  it("GoPro → GoPro 12 Hero (owned)", () => {
    expect(resolveListingToInventory("GoPro Hero 11 Black", null, OWNED)).toEqual({
      sku: "GoPro 12 Hero",
      matchType: "equivalence",
    });
  });

  it("FX3 listing → Sony FX3 (owned)", () => {
    expect(resolveListingToInventory("Sony FX3 (rare)", null, OWNED)).toEqual({
      sku: "Sony FX3",
      matchType: "equivalence",
    });
  });

  it("FX3 listing → Sony A7 V when FX3 unavailable", () => {
    const noFX3 = new Set([...OWNED].filter((k) => k !== "Sony FX3"));
    expect(resolveListingToInventory("Sony FX3 cinema package", null, noFX3)).toEqual({
      sku: "Sony A7 V",
      matchType: "equivalence",
    });
  });

  it("BMPCC 6K Pro → BMPCC 6K Pro (owned)", () => {
    expect(resolveListingToInventory("BMPCC 6K Pro w/ rig", null, OWNED)).toEqual({
      sku: "BMPCC 6K Pro",
      matchType: "equivalence",
    });
  });

  it("BMPCC 6K Pro → BMPCC 6K Full Frame fallback", () => {
    const noPro = new Set([...OWNED].filter((k) => k !== "BMPCC 6K Pro"));
    expect(resolveListingToInventory("BMPCC 6K Pro w/ rig", null, noPro)).toEqual({
      sku: "BMPCC 6K Full Frame",
      matchType: "equivalence",
    });
  });

  it("Anker power station → Anker Power Station F2000", () => {
    expect(resolveListingToInventory("Anker Power Station F2000", null, OWNED)).toEqual({
      sku: "Anker Power Station F2000",
      matchType: "equivalence",
    });
  });
});

describe("listing_equivalence — direct vs equivalence precedence", () => {
  it("direct match wins over equivalence (no double-attribution)", () => {
    expect(
      resolveListingToInventory("GoPro listing", "GoPro 12 Hero", OWNED),
    ).toEqual({ sku: "GoPro 12 Hero", matchType: "direct" });
  });

  it("direct match ignored when SKU not in owned set → falls back to equivalence", () => {
    expect(
      resolveListingToInventory("Some FX3 thing", "Sony FX9", OWNED),
    ).toEqual({ sku: "Sony FX3", matchType: "equivalence" });
  });

  it("no keyword match and no direct → none", () => {
    expect(
      resolveListingToInventory("Underwater housing for fish", null, OWNED),
    ).toEqual({ sku: null, matchType: "none" });
  });

  it("empty title → none", () => {
    expect(resolveListingToInventory("", null, OWNED)).toEqual({
      sku: null,
      matchType: "none",
    });
  });
});
