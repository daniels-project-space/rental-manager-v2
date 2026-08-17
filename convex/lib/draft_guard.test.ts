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
