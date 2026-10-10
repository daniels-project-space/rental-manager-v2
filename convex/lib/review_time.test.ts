import { describe, it, expect } from "vitest";
import {
  reviewTime,
  reviewTimeLabel,
  reviewTimestamp,
  reviewFingerprint,
} from "./review_time";
describe("provider review dates", () => {
  it("preserves relative dates without Invalid Date", () =>
    expect(reviewTimeLabel("2 weeks ago")).toBe("2 weeks ago"));
  it("formats actual dates", () =>
    expect(reviewTimeLabel("2026-05-01")).toBe("1 May 2026"));
  it("normalizes epoch seconds and milliseconds", () =>
    expect(reviewTime(1791504000)).toBe(reviewTime(1791504000000)));
  it("prefers the real timestamp over a relative label", () =>
    expect(
      reviewTimestamp({
        createdAt: "2026-05-01",
        relativeLabel: "5 months ago",
      }),
    ).toBe("2026-05-01T00:00:00.000Z"));
  it("shows an explicit missing date", () =>
    expect(reviewTimeLabel(null)).toBe("Date not supplied"));
  it("does not duplicate a review when its relative date changes", () =>
    expect(reviewFingerprint({ rating: 5, text: "Good", author: "A" })).toBe(
      reviewFingerprint({ rating: 5, text: " Good ", author: "A" }),
    ));
});
