/**
 * Unit tests for the Phase 3 marketing-listings mapping + fuzzy match.
 * Pure logic only — no Trigger SDK / Convex import.
 */

import { describe, it, expect } from "vitest";
import type {
  HyggloProductListItem,
  HyggloProductDetail,
  HyggloProductListing,
} from "../hygglo-core/types";
import type { Id } from "../../convex/_generated/dataModel";
import {
  buildCandidates,
  matchProduct,
  toUpsertArg,
  projectImages,
  projectPrices,
  projectListings,
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

describe("projectImages (validator drift guard)", () => {
  // The strict Convex `imageArg`/schema only allow these six keys.
  const ALLOWED = [
    "id",
    "thumbnailUrl",
    "fullSizeUrl",
    "filename",
    "rotation",
    "productId",
  ].sort();

  it("strips extra fields (createdAt/updatedAt) that broke upsertProductsBatch", () => {
    // Raw Hygglo image carries createdAt/updatedAt — the field that caused the
    // ArgumentValidationError and left hygglo_products empty. Cast through
    // unknown: those keys are not on the (lean) HyggloProductImage type.
    const raw = {
      id: 7,
      thumbnailUrl: "https://img/t.jpg",
      fullSizeUrl: "https://img/f.jpg",
      filename: "x.jpg",
      rotation: 0,
      productId: 22,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
    } as unknown as Parameters<typeof projectImages>[0] extends (infer T)[]
      ? T
      : never;

    const out = projectImages([raw]);
    expect(out).toHaveLength(1);
    expect(Object.keys(out![0]).sort()).toEqual(ALLOWED);
    expect(out![0]).not.toHaveProperty("createdAt");
    expect(out![0]).not.toHaveProperty("updatedAt");
    expect(out![0].id).toBe(7);
    expect(out![0].productId).toBe(22);
  });

  it("returns undefined for a non-array input", () => {
    expect(projectImages(undefined)).toBeUndefined();
  });

  it("toUpsertArg projects images so no extra fields reach the writer", () => {
    const detail = {
      id: 30,
      name: "Sony FX3",
      images: [
        {
          id: 1,
          fullSizeUrl: "https://img/x.jpg",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-02-02T00:00:00Z",
        },
      ],
    } as unknown as HyggloProductDetail;
    const arg = toUpsertArg("leo", product({ id: 30 }), detail, null);
    expect(arg.images).toHaveLength(1);
    expect(arg.images![0]).not.toHaveProperty("createdAt");
    expect(arg.images![0]).not.toHaveProperty("updatedAt");
  });
});

describe("projectPrices (validator drift guard)", () => {
  // The strict Convex `priceArg`/schema only allow these five keys.
  const ALLOWED = ["id", "productId", "pricePerDay", "days", "price"].sort();

  it("strips extra fields (createdAt/updatedAt) from raw Hygglo prices", () => {
    const raw = {
      id: 9,
      productId: 22,
      pricePerDay: 60,
      days: 1,
      price: 60,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
    } as unknown as Parameters<typeof projectPrices>[0] extends (infer T)[]
      ? T
      : never;

    const out = projectPrices([raw]);
    expect(out).toHaveLength(1);
    expect(Object.keys(out![0]).sort()).toEqual(ALLOWED);
    expect(out![0]).not.toHaveProperty("createdAt");
    expect(out![0]).not.toHaveProperty("updatedAt");
    expect(out![0].pricePerDay).toBe(60);
    expect(out![0].productId).toBe(22);
  });

  it("returns undefined for a non-array input", () => {
    expect(projectPrices(undefined)).toBeUndefined();
  });

  it("toUpsertArg projects prices so no extra fields reach the writer", () => {
    const detail = {
      id: 40,
      name: "Sony FX3",
      prices: [
        {
          id: 1,
          pricePerDay: 50,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-02-02T00:00:00Z",
        },
      ],
    } as unknown as HyggloProductDetail;
    const arg = toUpsertArg("leo", product({ id: 40 }), detail, null);
    expect(arg.prices).toHaveLength(1);
    expect(arg.prices![0]).not.toHaveProperty("createdAt");
    expect(arg.prices![0]).not.toHaveProperty("updatedAt");
    expect(arg.prices![0].pricePerDay).toBe(50);
  });
});

describe("projectListings (validator drift guard)", () => {
  // The strict Convex `listingArg`/schema only allow these five keys.
  const ALLOWED = ["id", "slug", "productId", "publicUrl", "location"].sort();

  it("strips extra fields (createdAt) that left hygglo_products empty post image-fix", () => {
    // This is the SECOND leak: live listings[] carry createdAt → the strict
    // listingArg object validator rejected the whole batch. Cast through
    // unknown: createdAt is not on the lean HyggloProductListing type.
    const raw = {
      id: 5,
      slug: "sony-fx3",
      productId: 22,
      publicUrl: "https://hygglo.com/uk/p/5",
      location: { city: "London", lat: 51.5, lng: -0.1 },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
    } as unknown as Parameters<typeof projectListings>[0] extends (infer T)[]
      ? T
      : never;

    const out = projectListings([raw]);
    expect(out).toHaveLength(1);
    expect(Object.keys(out![0]).sort()).toEqual(ALLOWED);
    expect(out![0]).not.toHaveProperty("createdAt");
    expect(out![0]).not.toHaveProperty("updatedAt");
    expect(out![0].slug).toBe("sony-fx3");
    expect(out![0].publicUrl).toBe("https://hygglo.com/uk/p/5");
  });

  it("passes location through verbatim (validator is v.any())", () => {
    const loc = { city: "London", nested: { deep: [1, 2, 3] } };
    const out = projectListings([
      { id: 1, slug: "x", location: loc } as HyggloProductListing,
    ]);
    expect(out![0].location).toEqual(loc);
  });

  it("returns undefined for a non-array input", () => {
    expect(projectListings(undefined)).toBeUndefined();
  });

  it("toUpsertArg projects listings so no extra fields reach the writer", () => {
    const detail = {
      id: 50,
      name: "Sony FX3",
      listings: [
        {
          id: 1,
          slug: "sony-fx3",
          publicUrl: "https://hygglo.com/detail",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-02-02T00:00:00Z",
        },
      ],
    } as unknown as HyggloProductDetail;
    const arg = toUpsertArg("leo", product({ id: 50 }), detail, null);
    expect(arg.listings).toHaveLength(1);
    expect(arg.listings![0]).not.toHaveProperty("createdAt");
    expect(arg.listings![0]).not.toHaveProperty("updatedAt");
    expect(arg.listings![0].slug).toBe("sony-fx3");
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
