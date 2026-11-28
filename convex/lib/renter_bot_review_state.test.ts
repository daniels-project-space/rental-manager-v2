import { describe, expect, it } from "vitest";
import { renterBotNeedsHumanReview } from "./renter_bot_review_state";

describe("renterBotNeedsHumanReview", () => {
  it("does not treat a production-guard rewrite as a review required for the final reply", () => {
    expect(renterBotNeedsHumanReview(
      [{ category: "production_guard:TRAVEL_COMPENSATION_GATE", status: "flag" }],
      [{ type: "TRAVEL_COMPENSATION_GATE", action: "rewritten" }],
    )).toBe(false);
  });

  it("requires review for unresolved guard and rubric flags", () => {
    expect(renterBotNeedsHumanReview([], [{ type: "PRICE_HALLUCINATION", action: "flagged" }])).toBe(true);
    expect(renterBotNeedsHumanReview([{ category: "tone_language", status: "flag" }], [])).toBe(true);
  });
});
