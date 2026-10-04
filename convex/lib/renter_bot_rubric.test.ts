import type {PriceEvidence} from "./price_claims";
import { describe, it, expect } from "vitest";
import { scoreDraft, scoreSkippedGeneration } from "./renter_bot_rubric";

describe("generation outcome", () => {
  it("never passes an upstream failure even for an escalation fixture", () => {
    expect(scoreSkippedGeneration("subscription_unavailable", true).overall_status).toBe("fail");
  });
  it("does not count a normal sales inquiry being withheld as success", () => {
    expect(scoreSkippedGeneration("needs_human:model_declined", false).overall_status).toBe("fail");
  });
  it("passes an explicitly expected policy escalation", () => {
    expect(scoreSkippedGeneration("needs_human:complaint", true).overall_status).toBe("pass");
  });
  it("does not pass an empty or undiagnosed result", () => {
    expect(scoreSkippedGeneration(undefined, true).overall_status).toBe("fail");
  });
});

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

  it("does not confuse an unverified model claim with contradictory evidence", () => {
    const r = scoreDraft({ accountSlug: "leo", draftText: "The total is £126.", factsClaimed: [{ kind: "price", value: "£126", verified: false }] });
    expect(r.results.find((x) => x.category === "pricing_quoting")?.status).toBe("flag");
    expect(r.filter_violation_categories).not.toContain("MADE_UP_PRICE");
  });

  it("reads separate currency values instead of concatenating all digits", () => {
    const r = scoreDraft({ accountSlug: "leo", draftText: "£42/day, £126 total.", factsClaimed: [{ kind: "price", value: "3 days at £42/day, total £126", verified: true }] });
    expect(r.results.find((x) => x.category === "pricing_quoting")?.status).toBe("pass");
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


describe("Native price grading",()=>{
 const request={start_date:"2026-10-22",end_date:"2026-10-23",items:[{name:"TTArtisan 11mm f2.8 Fisheye (Sony E)",quantity:1}]};
 const prices:PriceEvidence[]=[{names:[],items:request.items,start_date:request.start_date,end_date:request.end_date,kind:"basket",days:2,total_gbp:42,source:"native_inquiry_basket",quote_role:"inquiry",call_id:"native-quote"},
  {names:[request.items[0].name,"TTArtisan 11mm f/2.8 fisheye (E)"],kind:"rental",days:2,quantity:1,start_date:request.start_date,end_date:request.end_date,total_gbp:42,source:"native_inquiry_basket",call_id:"native-quote:line"}];
 const text="For 2 days (22 October 2026 to 23 October 2026):\n- 1 × TTArtisan 11mm f/2.8 fisheye (E): £42\nTotal: £42\n\nThis new hire is not yet confirmed. I can send the exact address once the new booking is confirmed.";
 const score=(draftText=text,priceEvidence=prices)=>scoreDraft({accountSlug:"leo",draftText,priceEvidence,priceRequest:request,factsClaimed:[],productionFlags:[]});
 it("grades a real Native quote despite an empty model claim list",()=>{
  expect(score().results.find(r=>r.category==="pricing_quoting")?.status).toBe("pass");
  expect(score().filter_violation_categories).not.toContain("UNVERIFIABLE_PRICE");
 });
 it("does not let matching whole totals hide an edited line price",()=>{
  expect(score(text.replace("(E): £42","(E): £43")).results.find(r=>r.category==="pricing_quoting")?.status).toBe("fail");
 });
 it("rejects missing or mismatched Native proof despite a model's verified assertion",()=>{
  for(const priceEvidence of [[],prices.map(p=>({...p,start_date:"2026-10-24",end_date:"2026-10-25"})),prices.map(p=>({...p,call_id:""}))])expect(score(text,priceEvidence).results.find(r=>r.category==="pricing_quoting")?.status).toBe("fail");
  expect(scoreDraft({accountSlug:"leo",draftText:"The total is £99.",priceEvidence:prices,priceRequest:request,factsClaimed:[{kind:"price",value:"£99",verified:true}]}).results.find(r=>r.category==="pricing_quoting")?.status).toBe("fail");
 });
 it("distinguishes a supplied empty production guard result from a missing result",()=>{
  expect(score().results.find(r=>r.category==="production_guard")?.status).toBe("pass");
  expect(scoreDraft({accountSlug:"leo",draftText:"Thanks!"}).results.find(r=>r.category==="production_guard")?.status).toBe("n_a");
 });
});
