import { describe, expect, it } from "vitest";
import { exactListingProductIds } from "./draft_listing_grounding";

describe("exact listing price grounding", () => {
  it("excludes a keyword-inferred single-item listing from price authority", () => {
    expect(
      exactListingProductIds([
        { product_id: 100, product_id_exact: false },
        { product_id: 200, product_id_exact: true },
        { product_id: 200, product_id_exact: true },
      ]),
    ).toEqual([200]);
  });
});
