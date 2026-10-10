import { it, expect } from "vitest";
import { profileImageUrl } from "./profile_image";
it("reads actual Hygglo full-size portraits", () =>
  expect(
    profileImageUrl({
      fullSizeUrl: "https://cdn.example.com/renter.jpg",
      thumbnailUrl: "https://cdn.example.com/small.jpg",
    }),
  ).toBe("https://cdn.example.com/renter.jpg"));
it("reads thumbnail-only profiles", () =>
  expect(
    profileImageUrl({ thumbnailUrl: "https://cdn.example.com/photo.jpg" }),
  ).toBe("https://cdn.example.com/photo.jpg"));
it("rejects unsafe or missing portraits", () => {
  for (const value of [
    null,
    {},
    "javascript:alert(1)",
    "http://example.com/a",
    "https://user:pass@example.com/a",
  ])
    expect(profileImageUrl(value)).toBeUndefined();
});
