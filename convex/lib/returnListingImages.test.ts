import { describe, expect, it } from "vitest";
import { returnListingImages } from "./returnListingImages";

describe("return listing images", () => {
  it("keeps each booked listing image across grouped rentals without duplicates", () => {
    const members = [
      { hygglo_items: [{ image_url: "camera.jpg" }, { image_url: "lens.jpg" }] },
      { hygglo_items: [{ image_url: "lens.jpg" }, { image_url: "light.jpg" }] },
    ];
    expect(returnListingImages(members)).toEqual(["camera.jpg", "lens.jpg", "light.jpg"]);
  });

  it("retains the legacy fallback and bounds the gallery", () => {
    const members = [
      { photos_urls: ["fallback.jpg"], hygglo_items: [] },
      { hygglo_items: [{ image_url: "camera.jpg" }, { image_url: "lens.jpg" }] },
    ];
    expect(returnListingImages(members, 2)).toEqual(["fallback.jpg", "camera.jpg"]);
  });
});
