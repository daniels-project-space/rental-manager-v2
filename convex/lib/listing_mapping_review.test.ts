import { describe, expect, it } from "vitest";
import { isSelectableListingMappingItem, listingMappingReviewStatus } from "./listing_mapping_review";

describe("isSelectableListingMappingItem", () => {
  it("only offers active nonmarketing stock with a positive whole-unit count", () => {
    expect(isSelectableListingMappingItem({ status: "active", is_marketing_only: false, qty: 2 })).toBe(true);
    expect(isSelectableListingMappingItem({ status: "inactive", is_marketing_only: false, qty: 2 })).toBe(false);
    expect(isSelectableListingMappingItem({ status: "active", is_marketing_only: true, qty: 2 })).toBe(false);
    expect(isSelectableListingMappingItem({ status: "active", is_marketing_only: false, qty: 0 })).toBe(false);
    expect(isSelectableListingMappingItem({ status: "active", is_marketing_only: false, qty: 1.5 })).toBe(false);
  });
});

describe("listingMappingReviewStatus", () => {
  it("marks only resolver-complete mappings to rentable stock as verified", () => {
    expect(listingMappingReviewStatus({
      isMarketingOnly: false,
      mappingConflict: false,
      hasOverride: true,
      componentCount: 2,
      complete: true,
      owned: true,
    })).toBe("verified");
  });

  it("keeps nonempty overrides in the review queue when the resolver finds gaps", () => {
    expect(listingMappingReviewStatus({
      isMarketingOnly: false,
      mappingConflict: false,
      hasOverride: true,
      componentCount: 1,
      complete: false,
      owned: true,
    })).toBe("needs_review");
  });

  it("distinguishes an owner-confirmed no-stock listing from an unresolved mapping", () => {
    expect(listingMappingReviewStatus({
      isMarketingOnly: false,
      mappingConflict: false,
      hasOverride: true,
      componentCount: 0,
      complete: true,
      owned: false,
    })).toBe("no_physical_stock");
  });

  it("surfaces duplicate maps as conflicts, not verified stock", () => {
    expect(listingMappingReviewStatus({
      isMarketingOnly: false,
      mappingConflict: true,
      hasOverride: false,
      componentCount: 0,
      complete: false,
      owned: null,
    })).toBe("duplicate_maps");
  });

  it("keeps marketing-only listings out of the physical stock review queue", () => {
    expect(listingMappingReviewStatus({
      isMarketingOnly: true,
      mappingConflict: false,
      hasOverride: false,
      componentCount: 0,
      complete: false,
      owned: null,
    })).toBe("marketing_only");
  });
});
