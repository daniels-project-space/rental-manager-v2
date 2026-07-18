import { describe, expect, it } from "vitest";
import {
  isLikelyMultiItemListing,
  listingResolutionSegments,
} from "./item-resolution";
import { parseLeadingQty } from "../../convex/lib/reservations/itemUnits";

describe("isLikelyMultiItemListing", () => {
  it("does not mistake SEO copy for a multi-item kit", () => {
    expect(
      isLikelyMultiItemListing(
        "TTArtisan Sony 11mm f/2.8 Fisheye / Ultra Wide Lens – E-Mount Lens for Video & Photography",
      ),
    ).toBe(false);
  });

  it("recognises explicit and ampersand-separated gear kits", () => {
    expect(isLikelyMultiItemListing("Sony FX3 + 24-70mm lens + tripod")).toBe(true);
    expect(isLikelyMultiItemListing("Sony camera & 24-70mm lens")).toBe(true);
    expect(isLikelyMultiItemListing("2x Sony FX3 set")).toBe(true);
    expect(isLikelyMultiItemListing("2× Sony FX3")).toBe(true);
    expect(isLikelyMultiItemListing("Blazar 45mm 1.5x anamorphic lens")).toBe(false);
  });
});

describe("listingResolutionSegments", () => {
  it("splits physical kit components and removes comparison-only models", () => {
    expect(
      listingResolutionSegments(
        "Blackmagic BMPCC 6K + Canon 24-105mm lens + DJI RS3 Pro (like Zhiyun Crane)",
      ),
    ).toEqual([
      "Blackmagic BMPCC 6K",
      "Canon 24-105mm lens",
      "DJI RS3 Pro",
    ]);
  });

  it("keeps quantities attached to pipe-separated items", () => {
    expect(
      listingResolutionSegments(
        "2x Sony FX3 Camera Kit | 2x Sony 24-70mm GM Lens | 2x Tripods",
      ),
    ).toEqual([
      "2x Sony FX3 Camera Kit",
      "2x Sony 24-70mm GM Lens",
      "2x Tripods",
    ]);
  });

  it("removes compatibility SEO tails from a single product", () => {
    expect(
      listingResolutionSegments(
        "Camera flash compatible with Sony, Canon, Nikon, Leica and Fuji",
      ),
    ).toEqual(["Camera flash"]);
  });
});

describe("parseLeadingQty", () => {
  it("supports both ASCII x and the multiplication sign", () => {
    expect(parseLeadingQty("2x Sony FX3")).toBe(2);
    expect(parseLeadingQty("2× JBL Club 120 speakers")).toBe(2);
  });
});
