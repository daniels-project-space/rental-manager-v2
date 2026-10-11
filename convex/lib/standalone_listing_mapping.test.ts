import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { resolveListingComponents, type ListingResolverItem } from "./listing_components";

const blazar: ListingResolverItem = {
  _id: "blazar-remus-100" as Id<"items">,
  name_canonical: "Anamorphic Blazar Remus 100mm",
  kind: "lens",
  qty: 1,
  unit_kind: "unit",
  status: "active",
  is_marketing_only: false,
};

describe("standalone Rental Manager stock mappings", () => {
  it("uses an exact active master-item link for a clearly standalone listing", () => {
    const result = resolveListingComponents(
      [blazar],
      undefined,
      blazar._id,
      1,
      "This powerful anamorphic lens gives you the quality and character of the Atlas Orion or Mercury set in a lighter form, with pronounced flaring.",
      undefined,
      "Anamorphic Blazar Remus 100mm 1.5x T2.8",
    );

    expect(result).toMatchObject({
      complete: true,
      owned: true,
      source: "primary_item_only",
      components: [{ item_id: blazar._id, units_per_listing: 1, owned: true }],
    });
  });

  it.each([
    "Anamorphic Blazar Remus 100mm lens set",
    "2x Anamorphic Blazar Remus 100mm lens",
    "Anamorphic Blazar Remus 100mm + filter",
  ])("does not infer a standalone mapping from bundle title %s", (productTitle) => {
    expect(
      resolveListingComponents(
        [blazar],
        undefined,
        blazar._id,
        1,
        "A general product description without a structured contents list.",
        undefined,
        productTitle,
      ),
    ).toMatchObject({ complete: false, owned: null });
  });

  it("does not certify a marketing-only master item through its title", () => {
    expect(
      resolveListingComponents(
        [{ ...blazar, is_marketing_only: true }],
        undefined,
        blazar._id,
        1,
        undefined,
        undefined,
        "Anamorphic Blazar Remus 100mm 1.5x T2.8",
      ),
    ).toMatchObject({ complete: false, owned: false });
  });
});
