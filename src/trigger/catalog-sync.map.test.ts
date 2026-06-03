/**
 * Unit tests for the Phase 3 marketing-listings mapping + fuzzy match.
 * Pure logic only — no Trigger SDK / Convex import.
 */

import { describe, it, expect } from "vitest";
import type { HyggloProductListItem, HyggloProductDetail } from "../hygglo-core/types";
import type { Id } from "../../convex/_generated/dataModel";
import {
  buildCandidates,
  matchProduct,
  toUpsertArg,
  publicUrlOf,
  slugOf,
  type InventoryRow,
} from "./catalog-sync.map";

// Master inventory stub. Ids are cast — only string identity matters in tests.
const INVENTORY: InventoryRow[] = [
  { _id: "item_fx3" as Id<"items">, name: "Sony FX3", aliases: ["fx3"] },
  { _id: "item_a7iv" as Id<"items">, name: "Sony A7 IV", aliases: ["a7 iv", "a7iv"] },
  { _id: "item_ronin" as Id<"items">, name: "DJI RS3 Pro", aliases: ["rs3 pro", "ronin rs3"] },
];
const CANDIDATES = buildCandidates(INVENTORY);

function product(over: Partial<HyggloProductListItem>): HyggloProductListItem {
  return { id: 1, name: "Unnamed", ...over };
}

describe("matchProduct", () => {
  it("matches a product whose name is a master item", () => {
    const m = matchProduct(product({ id: 10, name: "Sony FX3 cinema camera" }), INVENTORY, CANDIDATES);
    expect(m).not.toBeNull();
    expect(m?.itemId).toBe("item_fx3");
    expect(m?.score).toBeGreaterThanOrEqual(0.45);
  });

  it("falls back to the listing slug when the name does not match", () => {
    const m = matchProduct(
      product({
        id: 11,
        name: "Gear for hire",
        listings: [{ slug: "sony-a7-iv-body", publicUrl: "https://hygglo.com/x" }],
      }),
      INVENTORY,
      CANDIDATES,
    );
    expect(m?.itemId).toBe("item_a7iv");
  });

  it("returns null (marketing-only) for an unrelated product", () => {
    const m = matchProduct(
      product({ id: 12, name: "Vintage wooden ladder 3m" }),
      INVENTORY,
      CANDIDATES,
    );
    expect(m).toBeNull();
  });

  it("does not throw on a nameless / slugless product", () => {
    const m = matchProduct(product({ id: 13, name: undefined }), INVENTORY, CANDIDATES);
    expect(m).toBeNull();
  });
});

describe("toUpsertArg", () => {
  it("flags isMarketingOnly when no match and omits masterItemId", () => {
    const arg = toUpsertArg("leo", product({ id: 20, name: "Random thing" }), undefined, null);
    expect(arg.isMarketingOnly).toBe(true);
    expect(arg.masterItemId).toBeUndefined();
    expect(arg.matchScore).toBeUndefined();
    expect(arg.accountSlug).toBe("leo");
    expect(arg.productId).toBe(20);
  });

  it("sets masterItemId + score and clears isMarketingOnly when matched", () => {
    const arg = toUpsertArg(
      "leo",
      product({ id: 21, name: "Sony FX3" }),
      undefined,
      { itemId: "item_fx3" as Id<"items">, score: 0.9 },
    );
    expect(arg.isMarketingOnly).toBe(false);
    expect(arg.masterItemId).toBe("item_fx3");
    expect(arg.matchScore).toBe(0.9);
  });

  it("prefers detail fields and carries unavailableDates from detail only", () => {
    const list = product({
      id: 22,
      name: "List Name",
      valuation: 100,
      prices: [{ pricePerDay: 50 }],
    });
    const detail: HyggloProductDetail = {
      id: 22,
      name: "Detail Name",
      valuation: 999,
      minimumRentalDays: 2,
      isPublished: true,
      unavailableDates: ["2026-06-10", "2026-06-11"],
      prices: [{ pricePerDay: 60, days: 1, price: 60 }],
      images: [{ fullSizeUrl: "https://img/x.jpg" }],
      listings: [{ slug: "detail-slug", publicUrl: "https://hygglo.com/detail" }],
    };
    const arg = toUpsertArg("dbcinema", list, detail, null);
    expect(arg.name).toBe("Detail Name");
    expect(arg.valuation).toBe(999);
    expect(arg.minimumRentalDays).toBe(2);
    expect(arg.unavailableDates).toEqual(["2026-06-10", "2026-06-11"]);
    expect(arg.publicUrl).toBe("https://hygglo.com/detail");
  });

  it("leaves unavailableDates undefined when only the list payload is available", () => {
    const arg = toUpsertArg("leo", product({ id: 23, name: "Sony FX3" }), undefined, null);
    expect(arg.unavailableDates).toBeUndefined();
  });
});

describe("publicUrlOf / slugOf", () => {
  it("prefers top-level publicUrl, falls back to first listing", () => {
    expect(publicUrlOf(product({ publicUrl: "top" }))).toBe("top");
    expect(
      publicUrlOf(product({ listings: [{ publicUrl: "from-listing" }] })),
    ).toBe("from-listing");
    expect(publicUrlOf(product({}))).toBeUndefined();
  });

  it("returns the first listing slug", () => {
    expect(slugOf(product({ listings: [{ slug: "abc" }] }))).toBe("abc");
    expect(slugOf(product({}))).toBeUndefined();
  });
});
