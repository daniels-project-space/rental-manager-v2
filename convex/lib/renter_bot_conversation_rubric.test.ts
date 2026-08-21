import { describe, it, expect } from "vitest";
import {
  scoreConversation,
  similarity,
  renterTopics,
  type ConversationGroundTruth,
} from "./renter_bot_conversation_rubric";

/**
 * The REAL transcript Daniel reviewed on 2026-08-21, verbatim. Six defects, and
 * the previous single-draft rubric scored it "flag" without naming any of them.
 * This suite exists to make that impossible again — every check below must FAIL
 * on this input.
 */
const BAD_TURNS = [
  {
    renter: "hi sorry is this avaliavbke tomorrw and what time could i come to pickup ?",
    draft:
      "Hi! That exact BMPCC 6K Pro isn't available for tomorrow, but I have the BMPCC 6K Full Frame available for £35/day if that works for your shoot? For pickup tomorrow, my windows are 10am to 12pm or 7pm to 9pm in central London (I'll share the exact address once the booking is confirmed).",
  },
  {
    renter: "does that price include a lens ?",
    draft:
      "That exact BMPCC 6K Pro isn't available for tomorrow, but I have the BMPCC 6K Full Frame available for £35/day (comes with cage, 1TB card, and batteries, lens not included). Alternatively, if you're looking for a setup with a lens included, I have the Sony A7 III kit with a 28-70mm lens for £25/day. Pickup is between 10am to 12pm or 7pm to 9pm.",
  },
  {
    renter: "can i pickup the day before and return the day after ?",
    draft:
      "That exact BMPCC 6K Pro isn't available for those dates, but I have the BMPCC 6K Full Frame available for £35/day if that works for you!\n\nRegarding the timing, doing both a pickup the day before and return the day after would count as an extra rental day. my standard collection and return windows are 10am to 12pm and 7-9pm. Let me know if you'd like to go with the 6K Full Frame!",
  },
];

const GT: ConversationGroundTruth = {
  requestedItem: "BMPCC 6K Pro",
  // The calendar said FREE — verified live via getItemAvailabilityForChat.
  requestedItemAvailable: true,
  requestedItemOwned: true,
  ownedItems: [
    { name: "BMPCC 6K Pro", kind: "camera", lens_mount: "Canon EF mount" },
    { name: "BMPCC 6K Full Frame", kind: "camera", lens_mount: "Leica L-mount (native)", includes_lens: false },
    { name: "Sony A7 III", kind: "camera", lens_mount: "Sony E-mount (full frame)", includes_lens: true },
  ],
  // BMPCC 6K Pro has ZERO index rows → no listing → no kit data at all.
  knownKit: { "BMPCC 6K Pro": null, "BMPCC 6K Full Frame": null },
};

describe("the real 2026-08-21 transcript — every defect must be caught", () => {
  const out = scoreConversation(BAD_TURNS, GT);

  it("catches the FALSE unavailability claim", () => {
    expect(out.failures).toContain("false_unavailability");
    const f = out.results.find((r) => r.check === "false_unavailability")!;
    expect(f.status).toBe("fail");
    expect(f.evidence).toMatch(/isn't available/i);
  });

  it("catches the same opener repeated across turns", () => {
    expect(out.failures).toContain("cross_turn_repetition");
    // turns 2 and 3 both re-open with the unavailability line
    const reps = out.results.filter((r) => r.check === "cross_turn_repetition" && r.status === "fail");
    expect(reps.length).toBeGreaterThanOrEqual(2);
  });

  it("catches the lens question being answered with availability boilerplate", () => {
    const q = out.results.filter((r) => r.check === "question_answered" && r.status === "fail");
    expect(q.length).toBeGreaterThan(0);
  });

  it("catches the silent brand jump to Sony when the sibling Blackmagic existed", () => {
    expect(out.failures).toContain("substitution_sanity");
    const s = out.results.find((r) => r.check === "substitution_sanity" && r.status === "fail")!;
    expect(s.evidence).toBe("Sony A7 III");
  });

  it("catches the fabricated kit contents", () => {
    expect(out.failures).toContain("kit_hallucination");
    const k = out.results.find((r) => r.check === "kit_hallucination" && r.status === "fail")!;
    expect(k.evidence).toMatch(/cage, 1TB card, and batteries/i);
  });

  it("catches the day-count ask being priced but never negotiated", () => {
    expect(out.failures).toContain("day_count_negotiation");
  });

  it("catches 'lens not included' with no offer to add one", () => {
    expect(out.failures).toContain("lens_follow_through");
  });

  it("scores the conversation overall as FAIL", () => {
    expect(out.overall).toBe("fail");
  });
});

describe("a corrected conversation passes", () => {
  const GOOD = [
    {
      renter: "hi sorry is this avaliavbke tomorrw and what time could i come to pickup ?",
      draft:
        "Hi! Yes, the BMPCC 6K Pro is free tomorrow. For pickup I have 10am to 12pm or 7pm to 9pm in central London, whichever suits you better.",
    },
    {
      renter: "does that price include a lens ?",
      draft:
        "Good question - the BMPCC 6K Pro goes out as a body only, so no lens included. I can add the Canon EF 24-105mm f4 for £15/day so you're ready to shoot straight away, it's a native fit on the EF mount.",
    },
    {
      renter: "can i pickup the day before and return the day after ?",
      draft:
        "That would technically span two days on the booking. What I can do instead: collect in my 7pm to 9pm window the evening before and bring it back in the 10am to 12pm window, so you get the full shooting day while it stays a single-day hire. Want me to set it up that way?",
    },
  ];

  it("passes every check", () => {
    const out = scoreConversation(GOOD, GT);
    expect(out.failures).toEqual([]);
    expect(out.overall).toBe("pass");
  });
});

describe("price consistency across turns", () => {
  // Caught live: find_owned_alternatives resolved price by cheapest
  // token-overlap while lookup_pricing resolved by identity, so one
  // conversation quoted the same camera at two different daily rates.
  const DRIFT = [
    { renter: "how much is the fx3?", draft: "The Sony FX3 is £18/day if that works." },
    { renter: "whats the total for 4 days?", draft: "For 4 days the Sony FX3 comes to £160, so £40/day." },
  ];

  it("fails when one item is quoted at two different daily rates", () => {
    const out = scoreConversation(DRIFT, {
      requestedItem: "Sony FX3",
      requestedItemAvailable: true,
      requestedItemOwned: true,
    });
    expect(out.failures).toContain("price_consistency");
  });

  it("passes when the rate is stable", () => {
    const out = scoreConversation(
      [
        { renter: "how much is the fx3?", draft: "The Sony FX3 is £40/day." },
        { renter: "and for 4 days?", draft: "For 4 days it works out at £112 total, still £40/day before the multi-day rate." },
      ],
      { requestedItem: "Sony FX3", requestedItemAvailable: true, requestedItemOwned: true },
    );
    expect(out.failures).not.toContain("price_consistency");
  });
});

describe("phantom products and unfounded absence (live-caught 2026-08-21)", () => {
  const INV = [
    { name: "BMPCC 6K Pro", kind: "camera", lens_mount: "Canon EF mount" },
    { name: "BMPCC 6K Full Frame", kind: "camera", lens_mount: "Leica L-mount (native)" },
    { name: "Canon EF 16-35mm f2.8", kind: "lens", lens_mount: "Canon EF mount" },
  ];
  const base = {
    requestedItem: "BMPCC 6K",
    requestedItemAvailable: true,
    requestedItemOwned: true,
    ownedItems: INV,
  };

  it("catches an invented product variant", () => {
    // Only the Pro and Full Frame exist; a plain "BMPCC 6K" does not.
    const out = scoreConversation(
      [
        {
          renter: "whats the difference between them?",
          draft: "The BMPCC 6K has a Super 35 sensor and a fixed screen, while the Pro adds motorized ND filters.",
        },
      ],
      { ...base, phantomPatterns: ["BMPCC 6K(?!\\s*(Pro|Full))"] },
    );
    expect(out.failures).toContain("phantom_product");
  });

  it("does not flag the real products", () => {
    const out = scoreConversation(
      [
        {
          renter: "whats the difference between them?",
          draft: "I have the BMPCC 6K Pro (Canon EF mount) and the BMPCC 6K Full Frame (L-mount). Which mount suits your glass?",
        },
      ],
      { ...base, phantomPatterns: ["BMPCC 6K(?!\\s*(Pro|Full))"] },
    );
    expect(out.failures).not.toContain("phantom_product");
  });

  it("catches denying a wide lens we actually own", () => {
    const out = scoreConversation(
      [
        {
          renter: "can i get it with a wide lens",
          draft: "I don't have a wide EF lens available at the moment, so you'd need to bring your own EF glass.",
        },
      ],
      base,
    );
    expect(out.failures).toContain("unfounded_absence");
  });

  it("passes when the wide lens is actually offered", () => {
    const out = scoreConversation(
      [
        {
          renter: "can i get it with a wide lens",
          draft: "Yes, I can add the Canon EF 16-35mm f2.8 for £20/day, that's a native fit on the EF mount.",
        },
      ],
      base,
    );
    expect(out.failures).not.toContain("unfounded_absence");
  });
});

describe("helpers", () => {
  it("similarity spots the near-duplicate opener", () => {
    const a = "That exact BMPCC 6K Pro isn't available for tomorrow, but I have the BMPCC 6K Full Frame available for £35/day if that works for your shoot?";
    const b = "That exact BMPCC 6K Pro isn't available for those dates, but I have the BMPCC 6K Full Frame available for £35/day if that works for you!";
    expect(similarity(a, b)).toBeGreaterThan(0.6);
  });

  it("does not treat two genuinely different sentences as duplicates", () => {
    expect(
      similarity(
        "Yes, the BMPCC 6K Pro is free tomorrow.",
        "I can add the Canon EF 24-105mm f4 for £15 a day.",
      ),
    ).toBeLessThan(0.3);
  });

  it("detects renter topics", () => {
    expect(renterTopics("does that price include a lens ?")).toContain("lens");
    expect(renterTopics("can i pickup the day before and return the day after ?")).toContain("day_count");
  });

  it("does not fire false_unavailability when the item genuinely is not free", () => {
    const out = scoreConversation(BAD_TURNS, { ...GT, requestedItemAvailable: false });
    const f = out.results.find((r) => r.check === "false_unavailability")!;
    expect(f.status).toBe("n_a");
  });
});
