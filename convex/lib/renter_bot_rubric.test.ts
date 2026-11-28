import type {OwnerCheck} from "./owner_checks";
import type {PriceEvidence} from "./price_claims";
import { describe, it, expect } from "vitest";
import { scoreDraft, scoreSkippedGeneration } from "./renter_bot_rubric";
import { scoreTone } from "./renter_bot_tone_scorer";
import { assessTravelCompensation, discountConcessionExceedsCap, isDiscountConcessionOffer, withoutAuthorizedTravelCompensationClaim } from "./travel_compensation";

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
  it("uses the canonical DB Cinema tone score for the Lab account slug", () => {
    const text = "Yes, we can arrange delivery and collection to E1 6AN. The total charge is £62.";
    expect(scoreTone("dbcinema", text).score).toBe(scoreTone("dbcinema_web", text).score);
    expect(scoreDraft({ accountSlug: "dbcinema", draftText: text }).results
      .find(result => result.category === "tone_language")?.status).toBe("pass");
  });

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

  it("fails an unanswered updated-total request when the verified current basket total is available", () => {
    const priceRequest = {
      start_date: "2026-12-11",
      end_date: "2026-12-11",
      items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }],
    };
    const priceEvidence: PriceEvidence[] = [
      {
        names: [], kind: "basket", total_gbp: 50, days: 1,
        start_date: priceRequest.start_date, end_date: priceRequest.end_date,
        items: priceRequest.items, call_id: "lab:current-total", source: "lab_order_quote",
      },
      {
        names: ["BMPCC 6K Full Frame"], kind: "rental", total_gbp: 50, daily_rate_gbp: 50,
        days: 1, quantity: 1, start_date: priceRequest.start_date, end_date: priceRequest.end_date,
        call_id: "lab:current-total:line", source: "lab_order_quote",
      },
    ];
    const common = {
      accountSlug: "dbcinema",
      lastRenterMessage: "Yes, the Northumberland Street area works for my dates. Could you add the DJI RS3 Pro gimbal as well and tell me the new total?",
      priceRequest,
      priceEvidence,
    };
    const incomplete = scoreDraft({
      ...common,
      draftText: "I can't add the DJI RS3 Pro gimbal right now, so your request remains the BMPCC 6K Full Frame for 11 December.",
    });
    expect(incomplete.results.find(result => result.category === "pricing_quoting")?.status).toBe("fail");

    const complete = scoreDraft({
      ...common,
      draftText: "I can't add the DJI RS3 Pro gimbal right now, so the basket is unchanged and the current total remains £50 for the BMPCC 6K Full Frame.",
    });
    expect(complete.results.find(result => result.category === "pricing_quoting")?.status).toBe("pass");
  });

  it("does not mark receipt-backed booking confirmations incomplete for model-only checks", () => {
    const common = {
      accountSlug: "leo",
      draftText: "Done — I've updated the items and rental dates as agreed. The new total is £252.00.",
      lastRenterMessage: "Yes, please update the request to 2 Sony FX3s for 10–12 December at the quoted £252.",
      priceEvidence: [{
        names: ["Sony FX3"], kind: "basket" as const, total_gbp: 252, days: 3,
        start_date: "2026-12-10", end_date: "2026-12-12",
        items: [{ name: "Sony FX3", quantity: 2 }],
        call_id: "lab-action:test:complete-basket", source: "lab_order_transaction",
      }],
      priceRequest: {
        start_date: "2026-12-10", end_date: "2026-12-12",
        items: [{ name: "Sony FX3", quantity: 2 }],
      },
    };
    const action = scoreDraft({ ...common, serverVerifiedAction: true });
    expect(action.overall_status).toBe("pass");
    for (const category of ["owner_review_completion", "renter_camera_identity", "production_guard"]) {
      expect(action.results.find(result => result.category === category)?.status).toBe("n_a");
    }

    const generated = scoreDraft(common);
    expect(generated.overall_status).toBe("incomplete");
    expect(generated.results.find(result => result.category === "production_guard")?.status).toBe("unassessed");
  });

  it("scores an applied travel adjustment from its transaction receipt rather than as a new offer", () => {
    const text = "Done — I've applied the one-time travel adjustment. The updated rental total is £45.00.";
    expect(isDiscountConcessionOffer(text)).toBe(false);
    const result = scoreDraft({
      accountSlug: "dbcinema",
      draftText: text,
      factsClaimed: [{
        kind: "price",
        value: "The updated rental total is £45.00",
        verified: true,
      }],
      priceEvidence: [{
        names: ["BMPCC 6K Full Frame"],
        kind: "basket",
        total_gbp: 45,
        travel_adjustment: { base_total_gbp: 50, amount_gbp: 5, total_gbp: 45 },
        days: 1,
        start_date: "2026-12-10",
        end_date: "2026-12-10",
        items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }],
        call_id: "lab-action:test:travel-compensation",
        source: "lab_order_transaction",
      }],
      priceRequest: {
        start_date: "2026-12-10",
        end_date: "2026-12-10",
        items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }],
      },
    });
    expect(result.results.find(item => item.category === "pricing_quoting")?.status,
      JSON.stringify({ violations: result.filter_violation_categories, failures: result.results.filter(item => item.status === "fail") })).toBe("pass");

    const mismatchedReceipt = scoreDraft({
      accountSlug: "dbcinema",
      draftText: text,
      priceEvidence: [{
        names: ["BMPCC 6K Full Frame"], kind: "basket", total_gbp: 45,
        travel_adjustment: { base_total_gbp: 50, amount_gbp: 4, total_gbp: 45 },
        days: 1, start_date: "2026-12-10", end_date: "2026-12-10",
        items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }],
        call_id: "lab-action:test:travel-compensation", source: "lab_order_transaction",
      }],
      priceRequest: { start_date: "2026-12-10", end_date: "2026-12-10", items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }] },
    });
    expect(mismatchedReceipt.results.find(item => item.category === "pricing_quoting")?.status).toBe("fail");
  });

  it("does not leave a receipt-backed Diogo transaction confirmation incomplete for missing model-tone rules", () => {
    const result = scoreDraft({
      accountSlug: "diogo",
      draftText: "Done — I've applied the one-time travel adjustment. The updated rental total is £49.50.",
      lastRenterMessage: "Yes, that works. Please apply the £5.50 travel adjustment to my request.",
      conversationHistory: [
        { role: "renter", content: "Can I collect it in Shoreditch?" },
        { role: "owner", content: "Pickup and return are arranged from the Charing Cross Station area. Would that work for your dates?" },
        { role: "renter", content: "The Charing Cross area is too far for me. Could you offer a travel discount?" },
        { role: "owner", content: "I can offer a one-time £5.50 travel adjustment on this rental. Let me know if that works for you." },
      ],
      pickupArea: "Charing Cross Station area",
      rentalChargeGbp: 55,
      serverVerifiedAction: true,
      productionFlags: [],
      priceEvidence: [{
        names: ["Sony FX3"], kind: "basket", total_gbp: 49.5,
        travel_adjustment: { base_total_gbp: 55, amount_gbp: 5.5, total_gbp: 49.5 },
        days: 1, start_date: "2026-12-12", end_date: "2026-12-12",
        items: [{ name: "Sony FX3", quantity: 1 }],
        call_id: "lab-action:test:travel-compensation", source: "lab_order_transaction",
      }],
      priceRequest: { start_date: "2026-12-12", end_date: "2026-12-12", items: [{ name: "Sony FX3", quantity: 1 }] },
    });
    expect(result.results.find(item => item.category === "tone_language")?.status).toBe("n_a");
    expect(result.overall_status).toBe("pass");
  });

  it("accepts a guarded £5 travel offer as a concession, not a second rental quote", () => {
    const lastRenterMessage = "Yes, Northumberland Street works for me, although it is still quite far. Is Shoreditch a real pickup location for this account?";
    const history = [
      { role: "renter" as const, content: "Hi, the listing says pickup is in Shoreditch. Is that right? It's quite a trek for me. Could you take 10% off?" },
      { role: "owner" as const, content: "Collection and return for this kit are arranged from the Northumberland Street area. Does that work for your dates?" },
      { role: "renter" as const, content: lastRenterMessage },
    ];
    const travel = assessTravelCompensation({ history, lastRenterMessage, pickupArea: "Northumberland Street", rentalChargeGbp: 50 });
    expect(travel, JSON.stringify(travel)).toMatchObject({ eligible: true, maximumGbp: 5 });
    const offerText = "For this rental, the kit is only available for collection and return from the Northumberland Street area. I can't arrange a handoff from Shoreditch for this rental. I can offer a one-time £5.00 travel adjustment on this rental if you'd like.";
    expect(isDiscountConcessionOffer(offerText)).toBe(true);
    expect(discountConcessionExceedsCap(offerText, 50, travel.maximumGbp)).toBe(false);
    expect(withoutAuthorizedTravelCompensationClaim(offerText, travel.maximumGbp, true)).not.toContain("£5.00");
    const result = scoreDraft({
      accountSlug: "dbcinema",
      draftText: offerText,
      priceEvidence: [{
        names: ["BMPCC 6K Full Frame"], kind: "rental", total_gbp: 50, days: 1,
        start_date: "2026-12-10", end_date: "2026-12-10", call_id: "server-price:0", source: "lab_order_quote",
      }],
      priceRequest: {
        start_date: "2026-12-10", end_date: "2026-12-10",
        items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }],
      },
      lastRenterMessage,
      conversationHistory: history,
      pickupArea: "Northumberland Street",
      rentalChargeGbp: 50,
    });
    expect(result.results.find(item => item.category === "pricing_quoting")?.status,
      JSON.stringify({ violations: result.filter_violation_categories, failures: result.results.filter(item => item.status === "fail") })).toBe("pass");
    expect(result.filter_violation_categories).not.toContain("NATIVE_PRICE_UNSUPPORTED");
  });

  it("recognizes natural travel-cost objections without treating neutral costs as objections", () => {
    const history = [{ role: "owner" as const, content: "Pickup and return are in the Trafalgar Square area. Does that work for you?" }];
    const objectionBeforeAcceptance = assessTravelCompensation({
      history,
      lastRenterMessage: "I live in Shoreditch, so travelling to Trafalgar Square adds quite a bit of cost for me.",
      pickupArea: "Trafalgar Square area",
      rentalChargeGbp: 70,
    });
    expect(objectionBeforeAcceptance).toMatchObject({ eligible: true, pickupAreaDisclosed: true, pickupAreaAccepted: false, renterObjected: true, maximumGbp: 7 });

    const objectionAfterAcceptance = assessTravelCompensation({
      history: [
        ...history,
        { role: "renter" as const, content: "Yes, Trafalgar Square works for me." },
        { role: "owner" as const, content: "Thanks for confirming the pickup area." },
      ],
      lastRenterMessage: "I live in Shoreditch, so travelling to Trafalgar Square adds quite a bit of cost for me.",
      pickupArea: "Trafalgar Square area",
      rentalChargeGbp: 70,
    });
    expect(objectionAfterAcceptance).toMatchObject({ eligible: true, pickupAreaDisclosed: true, pickupAreaAccepted: true, renterObjected: true, maximumGbp: 7 });

    const neutral = assessTravelCompensation({
      history,
      lastRenterMessage: "The travel cost is reasonable for me; Trafalgar Square works.",
      pickupArea: "Trafalgar Square area",
      rentalChargeGbp: 70,
    });
    expect(neutral).toMatchObject({ eligible: false, pickupAreaDisclosed: true, pickupAreaAccepted: true, renterObjected: false, maximumGbp: 7 });

    const undisclosed = assessTravelCompensation({
      history: [],
      lastRenterMessage: "The trip is a bit expensive for me.",
      pickupArea: "Trafalgar Square area",
      rentalChargeGbp: 70,
    });
    expect(undisclosed).toMatchObject({ eligible: false, pickupAreaDisclosed: false, renterObjected: true });
  });

  it("grades an explicit travel-cost request against the one-time policy instead of leaving negotiation unassessed", () => {
    const request = { start_date: "2026-12-11", end_date: "2026-12-11", items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }] };
    const renter = "That is a long way from Shoreditch for me. Is there any help with the travel cost?";
    const common = {
      accountSlug: "dbcinema",
      lastRenterMessage: renter,
      conversationHistory: [
        { role: "owner" as const, content: "For this rental, pickup and return are arranged from the Northumberland Street area. Would that work for your dates?" },
        { role: "renter" as const, content: "Yes, the Northumberland Street area works for me." },
      ],
      pickupArea: "Northumberland Street area",
      rentalChargeGbp: 50,
      priceRequest: request,
      priceEvidence: [{ names: ["BMPCC 6K Full Frame"], kind: "rental" as const, total_gbp: 50, days: 1, quantity: 1,
        start_date: request.start_date, end_date: request.end_date, call_id: "lab:exact-quote", source: "lab_order_quote" }],
      productionFlags: [],
      pendingOwnerChecks: [],
    };
    const refused = scoreDraft({ ...common,
      draftText: "I'm afraid I can't help with travel costs or offer a discount on the rental. Collection and return would need to be from the Northumberland Street area.",
    });
    expect(refused.results.find(row => row.category === "negotiation")?.status).toBe("n_a");
    expect(refused.results.find(row => row.category === "discounts_retention")?.status).toBe("fail");

    const offered = scoreDraft({ ...common,
      draftText: "I understand that is a bit of a journey from Shoreditch. I can offer a one-time £5.00 travel adjustment on this rental if collecting and returning in the Northumberland Street area works for you.",
    });
    expect(offered.results.find(row => row.category === "negotiation")?.status).toBe("n_a");
    expect(offered.results.find(row => row.category === "discounts_retention")?.status).toBe("pass");
    expect(offered.results.find(row => row.category === "pricing_quoting")?.status).toBe("pass");
    expect(offered.overall_status).toBe("pass");
  });

  it("grades a location-first travel discount request through the travel policy instead of generic negotiation", () => {
    const renter = "The listing says pickup is in Shoreditch. Is that where I collect? If not, could you take £10 off for the extra travel?";
    const result = scoreDraft({
      accountSlug: "dbcinema",
      lastRenterMessage: renter,
      draftText: "Sorry for the confusion. For this rental, pickup and return are arranged from the Northumberland Street area. I can't arrange a handoff from Shoreditch. Would collecting and returning in Northumberland Street area work for your dates?",
      pickupArea: "Northumberland Street area",
      rentalChargeGbp: 50,
      conversationHistory: [],
      productionFlags: [],
    });
    expect(result.results.find(row => row.category === "negotiation")?.status).toBe("n_a");
    expect(result.results.find(row => row.category === "discounts_retention")?.status).toBe("pass");
  });

  it("keeps an independent rental-price bargain in a mixed travel request for review", () => {
    const result = scoreDraft({
      accountSlug: "dbcinema",
      lastRenterMessage: "The pickup is a long trip for me. Could you take £10 off the rental price as well?",
      draftText: "I can offer a one-time £5 travel adjustment if collecting from the Northumberland Street area works.",
      pickupArea: "Northumberland Street area",
      rentalChargeGbp: 50,
      conversationHistory: [],
      productionFlags: [],
    });
    expect(result.results.find(row => row.category === "negotiation")?.status).toBe("unassessed");
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

  it("fails cross_account_consistency when a reply refers to listings across rental accounts", () => {
    const r = scoreDraft({
      accountSlug: "dbcinema",
      draftText: "While other listings across accounts may reference different areas, this equipment is handled from Northumberland Street.",
    });
    expect(r.results.find((x) => x.category === "cross_account_consistency")?.status).toBe("fail");
    expect(r.filter_violation_categories).toContain("CROSS_ACCOUNT_REFERENCE");
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

  it("marks tone_language unassessed for diogo when no rule is defined", () => {
    const r = scoreDraft({
      accountSlug: "diogo",
      draftText: "Hey, sounds great, let me know if you need anything else!",
    });
    const tone = r.results.find((x) => x.category === "tone_language");
    expect(tone?.status).toBe("unassessed");
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

  it("marks long-horizon checks not relevant to a routine reply as N/A", () => {
    const r = scoreDraft({
      accountSlug: "leo",
      draftText: "Sounds good, thanks.",
    });
    for (const cat of [
      "gear_knowledge",
      "negotiation",
      "follow_up_texting",
      "problem_solving",
    ]) {
      const entry = r.results.find((x) => x.category === cat);
      expect(entry?.status, cat).toBe("n_a");
    }
    expect(r.results.find((x) => x.category === "discounts_retention")?.status).toBe("n_a");
    expect(r.overall_status).toBe("incomplete");
  });

  it("keeps gear, negotiation, follow-up, and recovery checks unassessed when triggered", () => {
    const relevantCases = [
      { category: "gear_knowledge", lastRenterMessage: "Does this lens autofocus?", draftText: "Yes, it does." },
      { category: "negotiation", lastRenterMessage: "Could you take 10% off?", draftText: "I can offer a one-time £5 travel adjustment." },
      { category: "follow_up_texting", lastRenterMessage: "Could you remind me tomorrow?", draftText: "I'll send you an update tomorrow." },
      { category: "problem_solving", lastRenterMessage: "The camera arrived damaged. Can I cancel?", draftText: "I'm sorry to hear that." },
    ];
    for (const item of relevantCases) {
      const result = scoreDraft({ accountSlug: "leo", ...item });
      expect(result.results.find(row => row.category === item.category)?.status, item.category).toBe("unassessed");
    }
  });

  it("does not mistake a basket addition for a kit-contents question", () => {
    const result = scoreDraft({
      accountSlug: "dbcinema",
      lastRenterMessage: "Could you add the BMPCC 6K Pro and tell me the new total?",
      draftText: "It is available on 13 December. Adding it would bring the combined total to £85; let me know if you want me to update your request to include it.",
    });
    expect(result.results.find(row => row.category === "gear_knowledge")?.status).toBe("n_a");
  });

  it("still requires evidence for an explicit kit-inclusion question", () => {
    const result = scoreDraft({
      accountSlug: "dbcinema",
      lastRenterMessage: "Does this kit include a charger?",
      draftText: "Yes, it does.",
    });
    expect(result.results.find(row => row.category === "gear_knowledge")?.status).toBe("unassessed");
  });

  it("scores only explicit, source-backed kit inclusion answers", () => {
    const shared = {
      accountSlug: "dbcinema",
      lastRenterMessage: "Does this kit include a 1TB or 2TB SSD?",
      kitEvidence: [{
        names: ["BMPCC 6K Pro"], contents: ["1× 2TB SSD", "5× NP-F570 batteries"],
        requested_item: true, source: "owner-confirmed kit contents", recorded_at: Date.now(),
      }],
    };
    expect(scoreDraft({...shared, draftText: "This kit includes one 2TB SSD."}).results.find(row => row.category === "gear_knowledge")?.status).toBe("pass");
    expect(scoreDraft({...shared, draftText: "This kit includes a 1TB SSD."}).results.find(row => row.category === "gear_knowledge")?.status).toBe("fail");
    expect(scoreDraft({...shared, draftText: "This kit includes one 2TB SSD.", kitEvidence: [{...shared.kitEvidence[0], source: undefined}]}).results.find(row => row.category === "gear_knowledge")?.status).toBe("unassessed");
  });

  it("does not report pass while any behavior remains unassessed", () => {
    const draft =
      "Hi, thanks for reaching out. The camera is confirmed available for those dates, and pickup is from our verified location between 10am-12pm. " +
      "It includes two batteries and a charger, and the booking can be made directly through the platform whenever you're ready to go ahead with it.";
    const r = scoreDraft({ accountSlug: "dbcinema_web", draftText: draft });
    expect(r.overall_status).toBe("incomplete");
    expect(r.results.some((entry) => entry.status === "unassessed")).toBe(true);
  });
});

describe("owner-confirmed pickup and travel rules", () => {
  it("requires an explicit item-availability reason tied to the account pickup point", () => {
    const common = {
      accountSlug: "dbcinema",
      lastRenterMessage: "so not Shoreditch?",
      conversationHistory: [{
        role: "owner" as const,
        content: "Collection is arranged from the Northumberland Street area.",
      }],
      pickupArea: "Northumberland Street area",
      pickupReason: "The BMPCC kit is only available for collection and return from the Northumberland Street area.",
      pickupAddress: "10 Northumberland Street, London WC2N 5DB, outside the Sherlock Holmes pub.",
    };
    const areaOnly = scoreDraft({
      ...common,
      draftText: "That's right, it's the Northumberland Street area. Does that work?",
    });
    const explained = scoreDraft({
      ...common,
      draftText: "That's right. For this rental, the kit is only available for collection and return from the Northumberland Street area. I can't arrange a Shoreditch handoff for this rental. Would that work for your dates?",
    });
    const weakArrangement = scoreDraft({
      ...common,
      draftText: "That's right. For this rental, pickup and return are arranged from the Northumberland Street area because the kit is only available for collection and return there. Would that work for your dates?",
    });

    expect(areaOnly.results.find((row) => row.category === "location_handling")?.status).toBe("fail");
    expect(weakArrangement.results.find((row) => row.category === "location_handling")?.status).toBe("fail");
    expect(explained.results.find((row) => row.category === "location_handling")?.status).toBe("pass");
  });

  it("passes the truthful account-area fallback when no temporary pickup reason is verified", () => {
    const result = scoreDraft({
      accountSlug: "dbcinema",
      lastRenterMessage: "Hi, your listing says the pickup is in Shoreditch. Is that right?",
      draftText: "Sorry for the confusion. For this rental, I can arrange collection and return only from the Northumberland Street area; I can't arrange a handoff from Shoreditch. Would collecting and returning in the Northumberland Street area work for your dates?",
      pickupArea: "Northumberland Street area",
      productionFlags: [],
    });
    const location = result.results.find((row) => row.category === "location_handling");
    expect(location?.status).toBe("pass");
    expect(location?.detail).toMatch(/no location-handling violations/i);
  });

  it("still fails a location mismatch reply that omits the handoff boundary", () => {
    const result = scoreDraft({
      accountSlug: "dbcinema",
      lastRenterMessage: "Hi, your listing says the pickup is in Shoreditch. Is that right?",
      draftText: "Collection and return are from the Northumberland Street area. Would that work for your dates?",
      pickupArea: "Northumberland Street area",
      productionFlags: [],
    });
    expect(result.results.find((row) => row.category === "location_handling")?.status).toBe("fail");
  });

  it("fails the Lab's false central-location explanation and first-turn discount", () => {
    const renterMessage = "The listing says pickup is in Shoreditch. Is that real? It is a long way for me. Can you take 10% off for travel?";
    const result = scoreDraft({
      accountSlug: "dbcinema",
      draftText: "That listing is currently being consolidated to our central location, so collection is in central London. I can certainly offer 10% off to make up for the travel. I'll send the exact pickup address the moment the booking is confirmed.",
      lastRenterMessage: renterMessage,
      conversationHistory: [{ role: "renter", content: renterMessage }],
      pickupArea: "Northumberland Street area",
      pickupAddress: "10 Northumberland Street, London WC2N 5DB, England, outside the Sherlock Holmes pub.",
      rentalChargeGbp: null,
    });
    expect(result.results.find((row) => row.category === "location_handling")?.status).toBe("fail");
    expect(result.results.find((row) => row.category === "discounts_retention")?.status).toBe("fail");
    expect(result.overall_status).toBe("fail");
  });

  it("keeps a generic discount request outside the travel-compensation rule", () => {
    const result = scoreDraft({
      accountSlug: "leo",
      draftText: "I can't offer a discount on a one-day rental; the single-day rate is fixed.",
      lastRenterMessage: "Could you take £10 off as a general discount for a one-day rental?",
    });
    expect(result.results.find((row) => row.category === "discounts_retention")?.status).toBe("n_a");
  });

  it("passes one capped offer only after the account area disclosure and renter objection", () => {
    const objection = "The Trafalgar Square area works for me, although that is a long way. Could you help with the extra travel cost?";
    const result = scoreDraft({
      accountSlug: "leo",
      draftText: "I can offer a one-time £3.50 travel adjustment on this rental.",
      lastRenterMessage: objection,
      conversationHistory: [
        { role: "owner", content: "For this rental, collection is arranged from the Trafalgar Square area." },
        { role: "renter", content: objection },
      ],
      pickupArea: "Trafalgar Square area",
      rentalChargeGbp: 35,
    });
    expect(result.results.find((row) => row.category === "discounts_retention")?.status).toBe("pass");
  });

  it("does not flag the exact capped travel adjustment as an unsupported rental price",()=>{
    const objection="Yes, the Northumberland Street area works, but it is quite far for me. Could you help with the travel cost?";
    const request={start_date:"2026-11-24",end_date:"2026-11-24",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
    const priceEvidence:PriceEvidence[]=[{names:["BMPCC 6K Full Frame"],kind:"rental",daily_rate_gbp:35,total_gbp:35,days:1,quantity:1,start_date:request.start_date,end_date:request.end_date,call_id:"lab-order-quote",source:"lab_order_quote"}];
    const result=scoreDraft({accountSlug:"dbcinema",draftText:"I can offer a one-time £3.50 travel adjustment on this rental.",lastRenterMessage:objection,
      conversationHistory:[{role:"owner",content:"Collection is arranged from the Northumberland Street area."},{role:"renter",content:objection}],pickupArea:"Northumberland Street area",rentalChargeGbp:35,priceRequest:request,priceEvidence});
    expect(result.filter_violation_categories).not.toContain("NATIVE_PRICE_UNSUPPORTED");
  });

  it("scores the saved Lab pickup-disclosure and capped-offer turn against its full Native evidence",()=>{
    const objection="Yes, Northumberland Street works for me, although it is still quite far. Is Shoreditch a real pickup location for this account? The listing says it.";
    const request={start_date:"2026-12-10",end_date:"2026-12-10",items:[{name:"BMPCC 6K Full Frame",aliases:["BMPCC 6K Full Frame","BMPCC 6K Full Frame","BMPCC 6K Full Frame"],quantity:1,components:[
      {name:"BMPCC 6K Full Frame",quantity:1},{name:"NP-F570 batteries",quantity:5},{name:"EF to L mount",quantity:1}],complete:true}]};
    const priceEvidence:PriceEvidence[]=[
      {names:["BMPCC 6K Full Frame"],kind:"replacement",total_gbp:2200,call_id:"prefetch:listing-context",source:"inventory_replacement_value"},
      {names:["BMPCC 6K Full Frame"],kind:"rental",daily_rate_gbp:50,base_rate_gbp:50,total_gbp:50,days:1,quantity:1,start_date:request.start_date,end_date:request.end_date,call_id:"server-price:0:BMPCC 6K Full Frame",source:"lab_order_quote"},
      {names:[],kind:"basket",total_gbp:50,days:1,items:[{name:"BMPCC 6K Full Frame",quantity:1}],start_date:request.start_date,end_date:request.end_date,call_id:"server-price:0",source:"lab_order_quote"},
      {names:["BMPCC 6K Full Frame"],kind:"rental",daily_rate_gbp:50,base_rate_gbp:50,total_gbp:50,days:1,quantity:1,call_id:"server-price:1",source:"hygglo_tier"},
      {names:["BMPCC 6K Full Frame"],kind:"rental",daily_rate_gbp:50,base_rate_gbp:50,total_gbp:50,days:1,quantity:1,start_date:request.start_date,end_date:request.end_date,call_id:"selected-price:2",source:"hygglo_tier"},
    ];
    const result=scoreDraft({accountSlug:"dbcinema",draftText:"For this rental, the kit is only available for collection and return from the Northumberland Street area. I can't arrange a handoff from Shoreditch for this rental. I can offer a one-time £5.00 travel adjustment on this rental if you'd like.",lastRenterMessage:objection,
      conversationHistory:[{role:"renter",content:"Hi, the listing says pickup is in Shoreditch. Is that right? It's quite a trek for me. Could you take 10% off?"},{role:"owner",content:"I can see why the listing location is confusing. For this rental, pickup and return are arranged from the Northumberland Street area, which is this account's collection point. Would that work for your dates? The listing's location wording doesn't match the collection point confirmed for this rental."},{role:"renter",content:objection}],pickupArea:"Northumberland Street area",rentalChargeGbp:null,priceRequest:request,priceEvidence});
    expect(result.results.find(row=>row.category==="pricing_quoting")?.status).toBe("pass");
    expect(result.results.find(row=>row.category==="discounts_retention")?.status).toBe("pass");
  });

  it("fails a percentage offer above the £10 cap", () => {
    const objection = "That is a long way for me. Could you help with the extra travel cost?";
    const result = scoreDraft({
      accountSlug: "leo",
      draftText: "I can offer 10% off for travel.",
      lastRenterMessage: objection,
      conversationHistory: [
        { role: "owner", content: "Collection is in the Trafalgar Square area." },
        { role: "renter", content: objection },
      ],
      pickupArea: "Trafalgar Square area",
      rentalChargeGbp: 200,
    });
    expect(result.results.find((row) => row.category === "discounts_retention")?.status).toBe("fail");
  });

  it("scores the one-time cap from an exact quote and ignores a daily rate alone", () => {
    const request = {
      start_date: "2026-11-24",
      end_date: "2026-11-24",
      items: [{ name: "BMPCC 6K Full Frame", quantity: 1 }],
    };
    const shared = {
      accountSlug: "dbcinema",
      draftText: "I can offer a one-time £3.50 travel adjustment on this rental.",
      lastRenterMessage: "The Northumberland Street area works for me, but it is quite far. Could you help with the travel cost?",
      conversationHistory: [{ role: "owner" as const, content: "Collection is arranged in the Northumberland Street area." }],
      pickupArea: "Northumberland Street area",
      rentalChargeGbp: null,
      priceRequest: request,
    };
    const exact = scoreDraft({
      ...shared,
      priceEvidence: [{ names: ["BMPCC 6K Full Frame"], kind: "rental", total_gbp: 35, days: 1, quantity: 1,
        start_date: request.start_date, end_date: request.end_date, call_id: "native:total", source: "native_quote" }],
    });
    expect(exact.results.find((row) => row.category === "discounts_retention")?.status).toBe("pass");

    const rateOnly = scoreDraft({
      ...shared,
      priceEvidence: [{ names: ["BMPCC 6K Full Frame"], kind: "rental", daily_rate_gbp: 35, base_rate_gbp: 35,
        days: 1, quantity: 1, start_date: request.start_date, end_date: request.end_date,
        call_id: "native:daily-rate", source: "native_listing_rate" }],
    });
    expect(rateOnly.results.find((row) => row.category === "discounts_retention")?.status).toBe("fail");
  });

  it("scores a verified delivery quote without treating the renter postcode as private pickup data", () => {
    const result = scoreDraft({
      accountSlug: "dbcinema",
      draftText: "Yes, we can arrange delivery and collection for E1 6AN. The total charge for both is £62.",
      lastRenterMessage: "Thanks, what is the total charge?",
      conversationHistory: [{ role: "renter", content: "Can you deliver and collect the BMPCC kit from E1 6AN?" }],
      verifiedDeliveryFeeGbp: 62,
      pickupArea: "Northumberland Street area",
      pickupAddress: "10 Northumberland Street, London WC2N 5DB",
      pickupPrivacySources: ["10 Northumberland Street, London WC2N 5DB"],
      productionFlags: [],
    });
    expect(result.results.find(row => row.category === "location_handling")?.status).toBe("pass");
    expect(result.filter_violation_categories).not.toContain("PICKUP_DETAILS_EARLY");
  });

  it("grades compensation as a breach after verification has failed", () => {
    const result = scoreDraft({
      accountSlug: "leo",
      draftText: "Your booking was cancelled because verification failed. I can't release the pickup point without a confirmed booking. I can take £10 off for the inconvenience.",
      lastRenterMessage: "Verification failed; can I still collect?",
      rentalStage: "VERIFICATION_FAILED",
      pickupArea: "Trafalgar Square area",
      pickupAddress: "Outside Waterstones at The Grand Building, Trafalgar Square, London WC2N 5EJ.",
    });
    expect(result.results.find((row) => row.category === "discounts_retention")?.status).toBe("fail");
    expect(result.results.find((row) => row.category === "location_handling")?.status).toBe("pass");
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
  expect(scoreDraft({accountSlug:"leo",draftText:"Thanks!"}).results.find(r=>r.category==="production_guard")?.status).toBe("unassessed");
 });
});


describe("Native owner-review completion",()=>{
 const score=(pendingOwnerChecks?:OwnerCheck[])=>scoreDraft({accountSlug:"leo",draftText:"I will check the lens details and get back to you.",productionFlags:[],pendingOwnerChecks});
 it("flags unresolved work without treating a truthful deferral as fabrication",()=>{
  const result=score([{kind:"listing_mapping",source_call_id:"native-listing-call",product_id:123,start_date:"2026-10-22",end_date:"2026-10-24",quantity:1}]);
  expect(result.results.find(r=>r.category==="owner_review_completion")?.status).toBe("flag");
  expect(result.overall_status).toBe("flag");
  expect(result.results.some(r=>r.status==="fail")).toBe(false);
 });
 it("distinguishes an inspected empty task set from missing workflow evidence",()=>{
  expect(score([]).results.find(r=>r.category==="owner_review_completion")?.status).toBe("pass");
  expect(score().results.find(r=>r.category==="owner_review_completion")?.status).toBe("unassessed");
 });
});
