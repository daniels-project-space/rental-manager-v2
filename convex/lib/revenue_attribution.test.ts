/**
 * Unit tests for the value-weighted revenue attribution engine.
 * Phase 1: 8 fixtures cover the rule cascade end-to-end.
 *
 * Notes on types:
 * - Convex `Id<T>` is a branded string at the type level. Tests cast plain
 *   strings via `as unknown as Id<...>` for terseness; the engine never
 *   actually unwraps the brand.
 * - Doc<"items"> contains many optional fields; tests create just the
 *   subset the engine reads (id, kind, compatibility, replacement_cost_gbp,
 *   is_marketing_only). Same `as unknown as` cast.
 */

import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../_generated/dataModel";
import {
  attributeRevenue,
  type AttributionContext,
  type RentalForAttribution,
} from "./revenue_attribution";

type ItemDoc = Doc<"items">;

// Helper: minimal Doc<"items"> stub. Cast through `unknown` so we don't have
// to fill every optional field.
function makeItem(args: {
  id: string;
  name: string;
  kind: string;
  replacement_cost_gbp?: number;
  is_marketing_only?: boolean;
  included_with_rental?: string[];
}): ItemDoc {
  return {
    _id: args.id as unknown as Id<"items">,
    _creationTime: 0,
    name_canonical: args.name,
    name_input: args.name,
    slug: args.name.toLowerCase().replace(/\s+/g, "-"),
    kind: args.kind,
    qty: 1,
    unit_kind: "unit",
    is_marketing_only: args.is_marketing_only ?? false,
    status: "active",
    replacement_cost_gbp: args.replacement_cost_gbp,
    compatibility: args.included_with_rental
      ? { included_with_rental: args.included_with_rental }
      : undefined,
    created_at: 0,
    updated_at: 0,
  } as unknown as ItemDoc;
}

function makeCtx(items: ItemDoc[], prices: Record<string, number> = {}): AttributionContext {
  const itemById = new Map<Id<"items">, ItemDoc>();
  const itemByCanonical = new Map<string, ItemDoc>();
  for (const it of items) {
    itemById.set(it._id, it);
    itemByCanonical.set(it.name_canonical, it);
  }
  const priceByName = new Map<string, number>(Object.entries(prices));
  return { itemById, itemByCanonical, priceByName };
}

function makeRental(args: {
  gross: number;
  duration_days?: number;
  expanded?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
  resolved?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
}): RentalForAttribution {
  return {
    _id: "rent1" as unknown as Id<"reservations">,
    gross_gbp: args.gross,
    duration_days: args.duration_days,
    expanded_items: args.expanded?.map((x) => ({
      item_id: x.item_id as unknown as Id<"items">,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty ?? 1,
    })),
    resolved_items: args.resolved?.map((x) => ({
      item_id: x.item_id as unknown as Id<"items">,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty ?? 1,
      confidence: 1,
    })),
  };
}

function sumShares(lines: { share: number }[]): number {
  // Round to 2dp to match the engine's precision before summing.
  return Math.round(lines.reduce((s, l) => s + l.share, 0) * 100) / 100;
}

describe("attributeRevenue", () => {
  it("F1 — body + kit lens with replacement values → proportional to replacement_cost", () => {
    const body = makeItem({ id: "i_body", name: "Sony FX3", kind: "camera", replacement_cost_gbp: 4000 });
    const lens = makeItem({ id: "i_lens", name: "Sony 24-70 GM", kind: "lens", replacement_cost_gbp: 2000 });
    const ctx = makeCtx([body, lens]);
    const rental = makeRental({
      gross: 300,
      resolved: [
        { item_id: "i_body", item_name_canonical: "Sony FX3" },
        { item_id: "i_lens", item_name_canonical: "Sony 24-70 GM" },
      ],
    });

    const out = attributeRevenue(rental, ctx);
    expect(out).toHaveLength(2);
    // 4000:2000 = 2:1 → body=200, lens=100
    const bodyLine = out.find((l) => l.key.nameCanonical === "Sony FX3")!;
    const lensLine = out.find((l) => l.key.nameCanonical === "Sony 24-70 GM")!;
    expect(bodyLine.reason).toBe("weighted_replacement");
    expect(lensLine.reason).toBe("weighted_replacement");
    expect(bodyLine.share).toBeCloseTo(200, 2);
    expect(lensLine.share).toBeCloseTo(100, 2);
    expect(Math.abs(sumShares(out) - 300)).toBeLessThanOrEqual(0.01);
  });

  it("F2 — body + included battery + included SD + standalone lens → battery/SD £0", () => {
    const body = makeItem({
      id: "i_body",
      name: "Sony FX3",
      kind: "camera",
      replacement_cost_gbp: 4000,
      included_with_rental: ["NP-FZ100 Battery", "SanDisk 128GB SD"],
    });
    const battery = makeItem({ id: "i_bat", name: "NP-FZ100 Battery", kind: "power", replacement_cost_gbp: 60 });
    const sd = makeItem({ id: "i_sd", name: "SanDisk 128GB SD", kind: "storage_card", replacement_cost_gbp: 40 });
    const lens = makeItem({ id: "i_lens", name: "Sony 24-70 GM", kind: "lens", replacement_cost_gbp: 2000 });
    const ctx = makeCtx([body, battery, sd, lens]);
    const rental = makeRental({
      gross: 300,
      resolved: [
        { item_id: "i_body", item_name_canonical: "Sony FX3" },
        { item_id: "i_bat", item_name_canonical: "NP-FZ100 Battery" },
        { item_id: "i_sd", item_name_canonical: "SanDisk 128GB SD" },
        { item_id: "i_lens", item_name_canonical: "Sony 24-70 GM" },
      ],
    });
    const out = attributeRevenue(rental, ctx);
    expect(out).toHaveLength(4);
    const bat = out.find((l) => l.key.nameCanonical === "NP-FZ100 Battery")!;
    const sdLine = out.find((l) => l.key.nameCanonical === "SanDisk 128GB SD")!;
    const body2 = out.find((l) => l.key.nameCanonical === "Sony FX3")!;
    const lens2 = out.find((l) => l.key.nameCanonical === "Sony 24-70 GM")!;
    expect(bat.share).toBe(0);
    expect(bat.reason).toBe("included_zero");
    expect(sdLine.share).toBe(0);
    expect(sdLine.reason).toBe("included_zero");
    // Body & lens split 4000:2000 = 2:1 over £300 → 200 / 100.
    expect(body2.share).toBeCloseTo(200, 2);
    expect(lens2.share).toBeCloseTo(100, 2);
    expect(Math.abs(sumShares(out) - 300)).toBeLessThanOrEqual(0.01);
  });

  it("F3 — ND filter in included list but standalone kind → keeps full weight", () => {
    // Phase 1 cannot detect "addon vs included" without expanded_items.source.
    // The behavior tested here: an ND filter listed in `included_with_rental`
    // but classified as `nd_filter` (NOT in STANDARD_INCLUDED_KINDS) keeps its
    // full weight. This is the safe legacy-preserving choice.
    const body = makeItem({
      id: "i_body",
      name: "Sony FX3",
      kind: "camera",
      replacement_cost_gbp: 4000,
      included_with_rental: ["Tiffen ND Filter Kit"],
    });
    const nd = makeItem({ id: "i_nd", name: "Tiffen ND Filter Kit", kind: "nd_filter", replacement_cost_gbp: 200 });
    const ctx = makeCtx([body, nd]);
    const rental = makeRental({
      gross: 210,
      resolved: [
        { item_id: "i_body", item_name_canonical: "Sony FX3" },
        { item_id: "i_nd", item_name_canonical: "Tiffen ND Filter Kit" },
      ],
    });
    const out = attributeRevenue(rental, ctx);
    const ndLine = out.find((l) => l.key.nameCanonical === "Tiffen ND Filter Kit")!;
    expect(ndLine.share).toBeGreaterThan(0);
    expect(ndLine.reason).toBe("weighted_replacement");
    // 4000:200 = 20:1 → body=200, nd=10
    expect(ndLine.share).toBeCloseTo(10, 2);
    expect(Math.abs(sumShares(out) - 210)).toBeLessThanOrEqual(0.01);
  });

  it("F4 — bundle decomposed into body+lens+battery via expanded_items → battery £0", () => {
    const body = makeItem({
      id: "i_body",
      name: "Sony FX3",
      kind: "camera",
      replacement_cost_gbp: 4000,
      included_with_rental: ["NP-FZ100 Battery"],
    });
    const lens = makeItem({ id: "i_lens", name: "Sony 24-70 GM", kind: "lens", replacement_cost_gbp: 2000 });
    const battery = makeItem({ id: "i_bat", name: "NP-FZ100 Battery", kind: "power", replacement_cost_gbp: 60 });
    const ctx = makeCtx([body, lens, battery]);
    const rental: RentalForAttribution = {
      _id: "rent1" as unknown as Id<"reservations">,
      gross_gbp: 600,
      expanded_items: [
        {
          item_id: "i_body" as unknown as Id<"items">,
          item_name_canonical: "Sony FX3",
          qty: 1,
          via_bundle: "bundle_fx3kit" as unknown as Id<"bundles">,
        },
        {
          item_id: "i_lens" as unknown as Id<"items">,
          item_name_canonical: "Sony 24-70 GM",
          qty: 1,
          via_bundle: "bundle_fx3kit" as unknown as Id<"bundles">,
        },
        {
          item_id: "i_bat" as unknown as Id<"items">,
          item_name_canonical: "NP-FZ100 Battery",
          qty: 1,
          via_bundle: "bundle_fx3kit" as unknown as Id<"bundles">,
        },
      ],
    };
    const out = attributeRevenue(rental, ctx);
    expect(out).toHaveLength(3);
    const bat = out.find((l) => l.key.nameCanonical === "NP-FZ100 Battery")!;
    expect(bat.share).toBe(0);
    expect(bat.reason).toBe("included_zero");
    // body:lens = 4000:2000 = 2:1 over £600 → 400 / 200.
    const bodyLine = out.find((l) => l.key.nameCanonical === "Sony FX3")!;
    const lensLine = out.find((l) => l.key.nameCanonical === "Sony 24-70 GM")!;
    expect(bodyLine.share).toBeCloseTo(400, 2);
    expect(lensLine.share).toBeCloseTo(200, 2);
    expect(Math.abs(sumShares(out) - 600)).toBeLessThanOrEqual(0.01);
  });

  it("F5 — no replacement_cost AND no pricing_catalog → equal split", () => {
    const a = makeItem({ id: "i_a", name: "Item A", kind: "lens" });
    const b = makeItem({ id: "i_b", name: "Item B", kind: "audio" });
    const ctx = makeCtx([a, b]);
    const rental = makeRental({
      gross: 100,
      resolved: [
        { item_id: "i_a", item_name_canonical: "Item A" },
        { item_id: "i_b", item_name_canonical: "Item B" },
      ],
    });
    const out = attributeRevenue(rental, ctx);
    expect(out).toHaveLength(2);
    for (const l of out) {
      expect(l.reason).toBe("equal_split");
      expect(l.share).toBeCloseTo(50, 2);
    }
    expect(Math.abs(sumShares(out) - 100)).toBeLessThanOrEqual(0.01);
  });

  it("F6 — single item → 100% share", () => {
    const body = makeItem({ id: "i_body", name: "Sony FX3", kind: "camera", replacement_cost_gbp: 4000 });
    const ctx = makeCtx([body]);
    const rental = makeRental({
      gross: 175,
      resolved: [{ item_id: "i_body", item_name_canonical: "Sony FX3" }],
    });
    const out = attributeRevenue(rental, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].share).toBeCloseTo(175, 2);
    expect(out[0].reason).toBe("weighted_replacement");
  });

  it("F7 — item lookup miss → kind='unknown', equal-split weight", () => {
    // Canonical name absent from both itemById and itemByCanonical maps.
    const ctx = makeCtx([]);
    const rental = makeRental({
      gross: 80,
      resolved: [
        { item_id: "i_phantom_a", item_name_canonical: "Mystery Gadget A" },
        { item_id: "i_phantom_b", item_name_canonical: "Mystery Gadget B" },
      ],
    });
    const out = attributeRevenue(rental, ctx);
    expect(out).toHaveLength(2);
    for (const l of out) {
      expect(l.kind).toBe("unknown");
      expect(l.reason).toBe("equal_split");
      expect(l.share).toBeCloseTo(40, 2);
    }
    expect(Math.abs(sumShares(out) - 80)).toBeLessThanOrEqual(0.01);
  });

  it("F8 — rounding: £100 gross, weights 2:1 → 66.67 + 33.33 sums to exactly 100.00", () => {
    const a = makeItem({ id: "i_a", name: "Item A", kind: "camera", replacement_cost_gbp: 2000 });
    const b = makeItem({ id: "i_b", name: "Item B", kind: "lens", replacement_cost_gbp: 1000 });
    const ctx = makeCtx([a, b]);
    const rental = makeRental({
      gross: 100,
      resolved: [
        { item_id: "i_a", item_name_canonical: "Item A" },
        { item_id: "i_b", item_name_canonical: "Item B" },
      ],
    });
    const out = attributeRevenue(rental, ctx);
    // Raw split would be 66.6666... + 33.3333... → round2 → 66.67 + 33.33 = 100.00.
    const total = sumShares(out);
    expect(total).toBe(100);
    // Largest-weight line (Item A) absorbs any drift.
    const aLine = out.find((l) => l.key.nameCanonical === "Item A")!;
    const bLine = out.find((l) => l.key.nameCanonical === "Item B")!;
    expect(aLine.share + bLine.share).toBe(100);
    // Each share should be exactly 2dp.
    expect(Number.isInteger(aLine.share * 100)).toBe(true);
    expect(Number.isInteger(bLine.share * 100)).toBe(true);
  });
});
