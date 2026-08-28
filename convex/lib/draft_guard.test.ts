import { describe, expect, it } from "vitest";
import { guardDraft } from "./draft_guard";

const baseOpts = {
  history: [],
  lastRenterMessage: "hygglo is asking me to verify my identity before I can book, how does that work",
};

describe("guardDraft — VERIFICATION_CIRCUMVENTION", () => {
  it("strips advice to use someone else's verified account to sidestep the hold", () => {
    const draft =
      "Hey! That's the platform's verification step, not something I handle directly. " +
      "The quickest route is to contact their live chat support. " +
      "Alternatively, if you know someone with a verified account, they can place the request mentioning it's for you, sometimes that sidesteps the hold. " +
      "Once you're through, just let me know and I'll get you sorted with the gear!";
    const result = guardDraft(draft, baseOpts);
    expect(result.text).not.toMatch(/verified account/i);
    expect(result.text).not.toMatch(/sidesteps/i);
    const flag = result.flags.find((f) => f.type === "VERIFICATION_CIRCUMVENTION");
    expect(flag).toBeDefined();
    expect(flag?.action).toBe("stripped");
    expect(flag?.severity).toBe("critical");
    // The legitimate first half of the draft must survive the strip.
    expect(result.text).toMatch(/live chat support/i);
  });

  it("does not false-positive on a normal verification explanation", () => {
    const draft =
      "That's Hygglo's own verification step, not something I handle directly. " +
      "Head to your Profile section and follow the prompts, it's usually quick. " +
      "Once you're verified, just let me know and I'll get you sorted with the gear!";
    const result = guardDraft(draft, baseOpts);
    const flag = result.flags.find((f) => f.type === "VERIFICATION_CIRCUMVENTION");
    expect(flag).toBeUndefined();
  });
});

describe("guardDraft — LOCATION_ASK_FOR_DISCOUNT", () => {
  const discountOpts = {
    history: [],
    lastRenterMessage:
      "do you give any discount for renters outside central london, and if so how much exactly",
  };

  it("strips a renter-location question tied to a discount", () => {
    const draft =
      "I do offer benefits for renters outside central London, but I'd need to know your postcode to look into exactly what that means for your rental. " +
      "What's your area?";
    const result = guardDraft(draft, discountOpts);
    expect(result.text).not.toMatch(/what'?s your area/i);
    const flag = result.flags.find((f) => f.type === "LOCATION_ASK_FOR_DISCOUNT");
    expect(flag).toBeDefined();
    expect(flag?.action).toBe("stripped");
    // The discount acknowledgement itself is legitimate and must survive.
    expect(result.text).toMatch(/benefits/i);
  });

  it("flags (without mangling) a declarative postcode-for-discount statement", () => {
    const draft =
      "I do offer location-based discounts that are automatically applied at checkout, depending on pickup location, but I'd need to know your postcode to see if you'd qualify. " +
      "Happy to check once you've got your dates locked in.";
    const result = guardDraft(draft, discountOpts);
    const flag = result.flags.find((f) => f.type === "LOCATION_ASK_FOR_DISCOUNT");
    expect(flag).toBeDefined();
    expect(flag?.action).toBe("flagged");
    // Flag-only: text is untouched, not mangled.
    expect(result.text).toContain("I'd need to know your postcode");
  });

  it("does not false-positive on a delivery-postcode ask with no discount mention", () => {
    const draft =
      "Happy to look into delivery for you. Could you send me the postcode you'd like it delivered to? " +
      "I'll quote based on distance and gear size.";
    const result = guardDraft(draft, {
      history: [],
      lastRenterMessage: "can you deliver this to me, I don't have a car",
    });
    const flag = result.flags.find((f) => f.type === "LOCATION_ASK_FOR_DISCOUNT");
    expect(flag).toBeUndefined();
  });
});

describe("guardDraft — PRICE_HALLUCINATION addon-band scoping", () => {
  const priceOpts = {
    history: [],
    lastRenterMessage: "hi just want the fx3 for a single day, whats the cheapest that can be",
    factPack: {
      pricing: {
        itemPrices: [{ name: "Sony FX3", min: 30, max: 30 }],
      },
    },
  };

  it("flags a wrong daily-rate quote even though it falls in the old blanket 5-15 addon band", () => {
    // Real bug (2026-08-17): the 5-15 "small addon" tolerance band was
    // unconditional, so it silently validated ANY stated price in that
    // range regardless of whether it had anything to do with the real
    // item price (here a real £30/day item quoted at a wildly wrong £10,
    // nowhere near the legitimate +/-10% tolerance around 30).
    const draft = "Hey! The daily rate for the Sony FX3 is £10.";
    const result = guardDraft(draft, priceOpts);
    const flag = result.flags.find((f) => f.type === "PRICE_HALLUCINATION");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("critical");
  });

  it("does not false-positive on a genuine small-addon price in the same band", () => {
    const draft =
      "The Sony FX3 is £30/day. An extra battery is £8 if you'd like a spare.";
    const result = guardDraft(draft, priceOpts);
    const flag = result.flags.find((f) => f.type === "PRICE_HALLUCINATION");
    expect(flag).toBeUndefined();
  });
});

describe("guardDraft — FALSE_ACTION_CLAIM future-conditional exclusion", () => {
  // Real bug (2026-08-17): a real, correct draft that deferred the pickup
  // address with the system prompt's OWN recommended phrasing ("I'll send
  // the exact address the moment the booking is confirmed") tripped this
  // check as if it were falsely claiming the booking IS confirmed right
  // now — which then tripped generateDraft's hard-escalation backstop,
  // forcing an unnecessary escalation on an otherwise good answer.
  const opts = {
    history: [],
    lastRenterMessage: "can my flatmate pick up the gopro for me instead since I'm stuck at work",
    ownerApproved: false,
  };

  it("does not flag a future-conditional deferral of the pickup address", () => {
    const draft =
      "Your flatmate can pick it up for you with the booking reference and forwarded confirmation. " +
      "I'll send the exact address the moment the booking is confirmed.";
    const result = guardDraft(draft, opts);
    const flag = result.flags.find((f) => f.type === "FALSE_ACTION_CLAIM");
    expect(flag).toBeUndefined();
  });

  it("still flags a genuine present-tense false confirmation claim", () => {
    const draft = "Great news, your booking is confirmed! See you at pickup.";
    const result = guardDraft(draft, opts);
    const flag = result.flags.find((f) => f.type === "FALSE_ACTION_CLAIM");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("critical");
  });

  it("does not flag when the booking genuinely is approved", () => {
    const draft = "Great news, your booking is confirmed! See you at pickup.";
    const result = guardDraft(draft, { ...opts, ownerApproved: true });
    const flag = result.flags.find((f) => f.type === "FALSE_ACTION_CLAIM");
    expect(flag).toBeUndefined();
  });
});

describe("guardDraft — MARKETING_ITEM_AVAILABLE negation handling", () => {
  const opts = {
    ...baseOpts,
    lastRenterMessage: "is the red komodo available next week?",
    factPack: { marketingItems: ["RED Komodo"] },
  };

  it("does NOT fire on the required concealment wording", () => {
    // This is the script the system mandates for a not-owned item. Before the
    // negation fix, rule 8 matched "available" anywhere plus the item name
    // anywhere, so EVERY correct reply on this path was flagged critical and
    // escalated — no renter ever received the alternative.
    const r = guardDraft(
      "That exact RED Komodo isn't available for next week, but I have the Sony FX3 at £40/day if that works.",
      opts,
    );
    expect(r.flags.map((f) => f.type)).not.toContain("MARKETING_ITEM_AVAILABLE");
  });

  it("still fires when the draft actually claims it IS available", () => {
    const r = guardDraft(
      "Yes, the RED Komodo is available next week, happy to get that booked in for you.",
      opts,
    );
    expect(r.flags.map((f) => f.type)).toContain("MARKETING_ITEM_AVAILABLE");
  });

  it("still fires on an 'I have got one' style claim", () => {
    const r = guardDraft("The RED Komodo I have got ready for those dates.", opts);
    expect(r.flags.map((f) => f.type)).toContain("MARKETING_ITEM_AVAILABLE");
  });

  it("is not excused by a negation attached to a different item later", () => {
    const r = guardDraft(
      "The RED Komodo is available then. The Sony FX3 isn't available that week.",
      opts,
    );
    expect(r.flags.map((f) => f.type)).toContain("MARKETING_ITEM_AVAILABLE");
  });
});

describe("PRICE_HALLUCINATION vs prices we supplied", () => {
  const itemPrices = [{ name: "BMPCC 6K Pro", min: 80, max: 80 }];
  const draft =
    "Yes it's free. I also rent the PL to EF mount adapter for £8/day if you " +
    "want to use the Blazar Remus anamorphics at £26/day.";
  const opts = (offeredPrices?: number[]) => ({
    history: [],
    lastRenterMessage: "any anamorphics that work with it?",
    factPack: { pricing: { itemPrices, ...(offeredPrices ? { offeredPrices } : {}) } },
  });

  it("flags an add-on price we never supplied", () => {
    const r = guardDraft(draft, opts());
    expect(r.flags.some((f) => f.type === "PRICE_HALLUCINATION")).toBe(true);
  });

  it("accepts the same prices once the fact pack offered them", () => {
    // The system told the bot to quote these. Escalating the reply that did
    // is the system contradicting itself.
    const r = guardDraft(draft, opts([8, 26]));
    expect(r.flags.some((f) => f.type === "PRICE_HALLUCINATION")).toBe(false);
  });

  it("still catches an invented price alongside supplied ones", () => {
    const r = guardDraft(`${draft} A spare body is £999/day.`, opts([8, 26]));
    expect(r.flags.some((f) => f.type === "PRICE_HALLUCINATION")).toBe(true);
  });
});

describe("FALSE_ACTION_CLAIM — apostrophes and the object of 'confirm'", () => {
  const opts = { history: [], lastRenterMessage: "yes please, and what's in the kit?" };
  const fired = (draft: string) =>
    guardDraft(draft, opts).flags.some((f) => f.type === "FALSE_ACTION_CLAIM");

  it("catches a real admin claim written with a CURLY apostrophe", () => {
    // The model writes U+2019. Every "I'?ll" pattern in the guard used ASCII,
    // so these walked straight through and the guard only looked strict.
    expect(fired("I’ll confirm the booking for you.")).toBe(true);
    expect(fired("I’ll get it approved for you.")).toBe(true);
    expect(fired("I’ve approved your request.")).toBe(true);
  });

  it("still catches the ASCII spelling", () => {
    expect(fired("I'll get it approved for you.")).toBe(true);
    expect(fired("I'm accepting your booking now.")).toBe(true);
  });

  it("does NOT fire on ordinary 'confirm' with a non-booking object", () => {
    // The fact pack literally instructs the bot to say it will confirm the
    // kit when kit data is missing. Blocking that withheld a whole reply.
    expect(fired("Let me confirm what's in the kit and come back to you.")).toBe(false);
    expect(fired("I can confirm the 100mm is available for those dates.")).toBe(false);
    expect(fired("I'll confirm the exact kit contents shortly.")).toBe(false);
  });
});

describe("FALSE_ACTION_CLAIM — booking edits", () => {
  const opts = (bookingModified: boolean) => ({
    history: [],
    lastRenterMessage: "yes please add the 100mm",
    bookingModified,
  });
  const fired = (draft: string, modified: boolean) =>
    guardDraft(draft, opts(modified)).flags.some((f) => f.type === "FALSE_ACTION_CLAIM");

  it("flags a claimed edit when nothing was actually changed", () => {
    // Production: the chat cannot edit a booking, so this is fabricated and
    // the renter turns up expecting a lens nobody put on the order.
    expect(fired("I've added the 100mm to your booking.", false)).toBe(true);
    expect(fired("I’ve added the adapter — your booking now includes both.", false)).toBe(true);
  });

  it("allows the same sentence when the edit really happened", () => {
    expect(fired("I've added the 100mm to your booking.", true)).toBe(false);
  });

  it("never blocks an OFFER to add, which is the upsell we want", () => {
    expect(fired("I can add the Canon EF 24-105mm f4 for £20/day.", false)).toBe(false);
    expect(fired("Happy to add the adapter for £8/day if you'd like.", false)).toBe(false);
  });
});

describe("INVENTED_POPULARITY", () => {
  const fired = (draft: string, hasPairingData: boolean) =>
    guardDraft(draft, {
      history: [],
      lastRenterMessage: "what do most people rent alongside it?",
      hasPairingData,
    }).flags.some((f) => f.type === "INVENTED_POPULARITY");

  it("flags a popularity claim made with no pairing data", () => {
    // Live-caught: a confident list of "the most common additions" for an item
    // we held no co-rental data on. It reads as sales patter, which is why it
    // went unnoticed — but it is a claim about our own rental history.
    expect(fired("The most common additions are lighting and an external monitor.", false)).toBe(true);
    expect(fired("Most people also rent a wide lens with it.", false)).toBe(true);
    expect(fired("It's a popular pairing with the gimbal.", false)).toBe(true);
  });

  it("allows the same claim once real counts were supplied", () => {
    expect(fired("Most people also rent the 24-70mm with it.", true)).toBe(false);
  });

  it("does not fire on a plain recommendation", () => {
    // Recommending is fine; asserting what OTHERS do is the regulated part.
    expect(fired("For interviews I'd suggest the 24-70mm — it's the most versatile.", false)).toBe(false);
    expect(fired("I can add the 16-35mm for £20/day if you want something wider.", false)).toBe(false);
  });
});
