import { describe, it, expect } from "vitest";
import { scoreDraft } from "./renter_bot_rubric";

describe("renter_bot_rubric.scoreDraft", () => {
  it("fails format_integrity on an empty draft", () => {
    const r = scoreDraft({ accountSlug: "leo", draftText: "   " });
    expect(r.overall_status).toBe("fail");
    const fmt = r.results.find((x) => x.category === "format_integrity");
    expect(fmt?.status).toBe("fail");
  });

  it("flags (not fails) a price when factsClaimed is empty — no data to confirm or refute", () => {
    const r = scoreDraft({
      accountSlug: "leo",
      draftText: "Sure, that would be £45 for the weekend, sounds good?",
      factsClaimed: [],
    });
    const pricing = r.results.find((x) => x.category === "pricing_quoting");
    expect(pricing?.status).toBe("flag");
    expect(r.filter_violation_categories).toContain("UNVERIFIABLE_PRICE");
    expect(r.filter_violation_categories).not.toContain("MADE_UP_PRICE");
  });

  it("fails pricing_quoting on a real mismatch when factsClaimed IS populated", () => {
    const r = scoreDraft({
      accountSlug: "leo",
      draftText: "Sure, that would be £45 for the weekend, sounds good?",
      factsClaimed: [{ kind: "price", value: "£99", verified: true }],
    });
    const pricing = r.results.find((x) => x.category === "pricing_quoting");
    expect(pricing?.status).toBe("fail");
    expect(r.filter_violation_categories).toContain("MADE_UP_PRICE");
  });

  it("passes pricing_quoting when the price matches a verified fact", () => {
    const r = scoreDraft({
      accountSlug: "leo",
      draftText: "Sure, that would be £45 for the weekend, sounds good?",
      factsClaimed: [{ kind: "price", value: "£45", verified: true }],
    });
    const pricing = r.results.find((x) => x.category === "pricing_quoting");
    expect(pricing?.status).toBe("pass");
  });

  it("fails cross_account_consistency when another persona is named with a same-business link", () => {
    const r = scoreDraft({
      accountSlug: "dbcinema_web",
      draftText: "Yeah Leo and I are actually the same business, don't worry about it.",
    });
    const cross = r.results.find(
      (x) => x.category === "cross_account_consistency",
    );
    expect(cross?.status).toBe("fail");
    expect(r.filter_violation_categories).toContain("DUAL_ACCOUNT");
  });

  it("does not flag DUAL_ACCOUNT just for mentioning another name without a link claim", () => {
    const r = scoreDraft({
      accountSlug: "dbcinema_web",
      draftText: "My name is Leo, happy to help with your booking.",
    });
    // "Leo" appears but there's no same-business/also-known-as language.
    expect(r.filter_violation_categories).not.toContain("DUAL_ACCOUNT");
  });

  it("flags location_handling on an unfilled placeholder artifact", () => {
    const r = scoreDraft({
      accountSlug: "leo",
      draftText: "Pickup will be at [LOCATION] around 10am.",
    });
    const loc = r.results.find((x) => x.category === "location_handling");
    expect(loc?.status).toBe("flag");
  });

  it("flags format_integrity as TOO_LONG on an oversized reply", () => {
    const longDraft = Array(200).fill("word").join(" ");
    const r = scoreDraft({ accountSlug: "leo", draftText: longDraft });
    expect(r.filter_violation_categories).toContain("TOO_LONG");
  });

  it("always scores tone_language n_a for diogo (no rule defined yet)", () => {
    const r = scoreDraft({
      accountSlug: "diogo",
      draftText: "Hey, sounds great, let me know if you need anything else!",
    });
    const tone = r.results.find((x) => x.category === "tone_language");
    expect(tone?.status).toBe("n_a");
  });

  it("passes tone_language for a professional dbcinema_web reply in the good length band", () => {
    const draft =
      "Hi, thanks for reaching out. The camera is confirmed available for those dates, and pickup is from our verified location between 10am-12pm. " +
      "It includes two batteries and a charger, and the booking can be made directly through the platform whenever you're ready to go ahead with it.";
    const r = scoreDraft({ accountSlug: "dbcinema_web", draftText: draft });
    const tone = r.results.find((x) => x.category === "tone_language");
    expect(tone?.status).toBe("pass");
  });

  it("flags tone_language for an overly casual dbcinema_web reply", () => {
    const r = scoreDraft({
      accountSlug: "dbcinema_web",
      draftText: "yeah cool dude gonna sort that for you, no worries mate",
    });
    const tone = r.results.find((x) => x.category === "tone_language");
    expect(tone?.status).toBe("flag");
  });

  it("leaves categories with no automated check as n_a, never invented", () => {
    const r = scoreDraft({
      accountSlug: "leo",
      draftText: "Sounds good, let me check and get back to you shortly.",
    });
    for (const cat of [
      "gear_knowledge",
      "negotiation",
      "discounts_retention",
      "follow_up_texting",
      "problem_solving",
    ]) {
      const entry = r.results.find((x) => x.category === cat);
      expect(entry?.status).toBe("n_a");
    }
  });

  it("overall_status is pass when nothing fails or flags", () => {
    const draft =
      "Hi, thanks for reaching out. The camera is confirmed available for those dates, and pickup is from our verified location between 10am-12pm. " +
      "It includes two batteries and a charger, and the booking can be made directly through the platform whenever you're ready to go ahead with it.";
    const r = scoreDraft({ accountSlug: "dbcinema_web", draftText: draft });
    expect(r.overall_status).toBe("pass");
  });
});
