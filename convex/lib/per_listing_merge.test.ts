/**
 * Unit tests for the per-listing resolution merge logic introduced by the
 * qty-extraction bug fix (RC: /tmp/qty_extraction_rc.md).
 *
 * Bug: when a Hygglo order had N distinct listings of the same SKU, the
 * resolver concatenated titles with "\n", sent ONE LLM call, and the LLM
 * deduped them → resolved qty=1 instead of N.
 *
 * Fix: resolve each listing independently, then merge across listings by
 * summing qty for matching item_ids.
 *
 * These tests model the post-LLM merge step. They feed `perListingResolved`
 * arrays (what the LLM would return per single-listing call) into the merge
 * logic and assert the cross-listing summation.
 */
import { describe, it, expect } from "vitest";

type Resolved = { item_id: string; item_name_canonical: string; confidence: number; qty: number };
type Expanded = { item_id: string; item_name_canonical: string; qty: number; via_bundle?: string };

/**
 * Pure merge function mirroring the post-LLM merge introduced in
 * src/trigger/resolve-items.ts and convex/item_resolver.ts.
 * Sums same-item_id qty across listings, keeps max confidence,
 * and emits expanded[] (no bundle expansion here — bundles are tested
 * separately in item_matcher.test.ts).
 */
function mergePerListing(perListingResolved: Resolved[][]): { resolved: Resolved[]; expanded: Expanded[] } {
  const expanded: Expanded[] = [];
  const addExp = (id: string, name: string, qty: number) => {
    const ex = expanded.find((e) => e.item_id === id);
    if (ex) ex.qty += qty;
    else expanded.push({ item_id: id, item_name_canonical: name, qty });
  };
  const resolvedSum = new Map<string, Resolved>();
  for (const listing of perListingResolved) {
    for (const x of listing) {
      const ex = resolvedSum.get(x.item_id);
      if (ex) {
        ex.qty += x.qty;
        if (x.confidence > ex.confidence) ex.confidence = x.confidence;
      } else {
        resolvedSum.set(x.item_id, { ...x });
      }
      addExp(x.item_id, x.item_name_canonical, x.qty);
    }
  }
  return { resolved: Array.from(resolvedSum.values()), expanded };
}

describe("per-listing merge (qty-extraction bug fix)", () => {
  it("1 listing → qty 1 (regression: simple single-item rental)", () => {
    const perListing: Resolved[][] = [
      [{ item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 }],
    ];
    const { resolved, expanded } = mergePerListing(perListing);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].qty).toBe(1);
    expect(expanded).toEqual([
      { item_id: "FX3", item_name_canonical: "Sony FX3", qty: 1 },
    ]);
  });

  it("2 listings same SKU → qty 2 (the Olivia case — primary bug fix)", () => {
    // Two distinct Hygglo listings, each resolved to FX3 + 24-70GM.
    // Per old behavior the LLM-deduped output would have been qty:1 each.
    // Per new behavior each listing is resolved separately, then summed.
    const perListing: Resolved[][] = [
      [
        { item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 },
        { item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 },
      ],
      [
        { item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 0.9, qty: 1 },
        { item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 0.95, qty: 1 },
      ],
    ];
    const { resolved, expanded } = mergePerListing(perListing);

    expect(resolved).toHaveLength(2);
    const fx3 = resolved.find((r) => r.item_id === "FX3");
    const lens = resolved.find((r) => r.item_id === "GM2470");
    expect(fx3?.qty).toBe(2);
    expect(lens?.qty).toBe(2);
    // Max-confidence retention
    expect(fx3?.confidence).toBe(1.0);
    expect(lens?.confidence).toBe(1.0);

    // Expanded sums identically
    expect(expanded.find((e) => e.item_id === "FX3")?.qty).toBe(2);
    expect(expanded.find((e) => e.item_id === "GM2470")?.qty).toBe(2);
  });

  it("2 listings different SKUs → qty 1 each (no false summation)", () => {
    const perListing: Resolved[][] = [
      [{ item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 }],
      [{ item_id: "A7S3", item_name_canonical: "Sony A7S III", confidence: 1.0, qty: 1 }],
    ];
    const { resolved } = mergePerListing(perListing);
    expect(resolved).toHaveLength(2);
    expect(resolved.find((r) => r.item_id === "FX3")?.qty).toBe(1);
    expect(resolved.find((r) => r.item_id === "A7S3")?.qty).toBe(1);
  });

  it("listing with explicit qty:3 → qty 3 (inline Hygglo qty preserved)", () => {
    // Hygglo `items[].qty=3` propagates through `${qty}× title` and the LLM
    // emits qty:3. Single listing — merge must preserve the explicit qty.
    const perListing: Resolved[][] = [
      [{ item_id: "BATT", item_name_canonical: "Sony NPF-Z100 battery", confidence: 1.0, qty: 3 }],
    ];
    const { resolved, expanded } = mergePerListing(perListing);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].qty).toBe(3);
    expect(expanded[0].qty).toBe(3);
  });

  it("3 listings same SKU → qty 3 (scales correctly above 2)", () => {
    const perListing: Resolved[][] = [
      [{ item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 }],
      [{ item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 }],
      [{ item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 }],
    ];
    const { resolved } = mergePerListing(perListing);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].qty).toBe(3);
  });

  it("mixed: 2 same SKU + 1 different → qty 2 + qty 1", () => {
    const perListing: Resolved[][] = [
      [{ item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 }],
      [{ item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 }],
      [{ item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 }],
    ];
    const { resolved } = mergePerListing(perListing);
    expect(resolved.find((r) => r.item_id === "FX3")?.qty).toBe(2);
    expect(resolved.find((r) => r.item_id === "GM2470")?.qty).toBe(1);
  });

  it("listing returning multiple items (kit) → each sums independently across listings", () => {
    // Listing 1 is an FX3+lens kit; listing 2 same kit. Both items should double.
    const perListing: Resolved[][] = [
      [
        { item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 },
        { item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 },
      ],
      [
        { item_id: "FX3", item_name_canonical: "Sony FX3", confidence: 1.0, qty: 1 },
        { item_id: "GM2470", item_name_canonical: "Sony 24-70mm GM", confidence: 1.0, qty: 1 },
      ],
    ];
    const { resolved } = mergePerListing(perListing);
    expect(resolved).toHaveLength(2);
    expect(resolved.find((r) => r.item_id === "FX3")?.qty).toBe(2);
    expect(resolved.find((r) => r.item_id === "GM2470")?.qty).toBe(2);
  });

  it("empty perListing → empty resolved + expanded", () => {
    const { resolved, expanded } = mergePerListing([]);
    expect(resolved).toEqual([]);
    expect(expanded).toEqual([]);
  });

  it("one listing with multiple resolved items and one with qty:2 inline → correct sum", () => {
    // Hygglo emits qty:2 on listing[0]; listing[1] is qty:1 same SKU.
    // After fix the merge sums to qty:3.
    const perListing: Resolved[][] = [
      [{ item_id: "CARD", item_name_canonical: "Sony Tough 256GB", confidence: 1.0, qty: 2 }],
      [{ item_id: "CARD", item_name_canonical: "Sony Tough 256GB", confidence: 1.0, qty: 1 }],
    ];
    const { resolved } = mergePerListing(perListing);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].qty).toBe(3);
  });
});
