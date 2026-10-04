import { describe, expect, it } from "vitest";
import type { PriceEvidence } from "./price_claims";
import updatedSetupCapture from "../../src/lib/fixtures/renter-updated-setup-guard.json";
import { guardDraft } from "./draft_guard";
import { scoreDraft } from "./renter_bot_rubric";

const baseOpts = {
  history: [],
  lastRenterMessage: "hygglo is asking me to verify my identity before I can book, how does that work",
};

describe("contract follows a proven booking transition", () => {
  const liveReply = "All sorted! I've swapped the TTArtisan 11mm for the Sony FE 16-35mm f/2.8 GM on your booking for 20-21 October. Your updated total is £40.\n\nPickup is at 5 Pall Mall, London SW1Y 5LU during my collection windows (10:00 to 12:00 or 19:00 to 21:00). Just drop a message saying 'arrived' when you get there, no need to head inside.";
  const opts = { history: [], lastRenterMessage: "Yes please", stage: "CONFIRMED_UPCOMING" };
  it("does not apply the acknowledgment length limit to the actual amendment reply", () => {
    const result = guardDraft(liveReply, { ...opts, bookingModified: true });
    expect(result.flags.some(f => f.type === "CONTRACT:maxLength")).toBe(false);
    expect(result.text).toContain("swapped the TTArtisan 11mm");
    expect(result.text).toContain("updated total is £40");
  });
  it("retains the acknowledgment limit without a server-proven transition", () => {
    for (const bookingModified of [false, undefined]) {
      expect(guardDraft(liveReply, { ...opts, bookingModified }).flags).toContainEqual(
        expect.objectContaining({ type: "CONTRACT:maxLength", detail: expect.stringContaining("ACKNOWLEDGMENT") }),
      );
    }
  });
  it("keeps unsolicited upselling restricted after an amendment", () => {
    const result = guardDraft(liveReply + " You might want to add a microphone.", { ...opts, bookingModified: true });
    expect(result.text).not.toContain("You might want");
    expect(result.flags).toContainEqual(expect.objectContaining({ type: "CONTRACT", action: "stripped" }));
  });
});

describe("recommendation cleanup preserves offer content", () => {
  const opts = { history: [], lastRenterMessage: "Recommend two Sony bodies that record 4K internally and show each three-day price." };
  it("preserves both offers in the actual Lab candidate with bold model names", () => {
    const candidate = "For these dates, here are two options:\n\n• **Sony A7 V** — records 4K internally; 3-day total is £110\n• **Sony FX3** — full-frame cinema body recording 4K internally; 3-day total is £126\n\nBoth come with batteries and memory cards included.";
    const result = guardDraft(candidate, opts);
    expect(result.text).toContain("Sony A7 V");
    expect(result.text).toContain("£110");
    expect(result.text).toContain("Sony FX3");
    expect(result.text).toContain("£126");
    expect(result.text).toMatch(/£110\n.*Sony FX3/);
    expect(result.flags.some(f => f.type === "INTERNAL_ACTION")).toBe(false);
  });
  it("keeps monetary totals and legitimate emphasized renter instructions", () => {
    const result = guardDraft("**Sony FX3 records 4K internally**, with the three-day total coming to £126. *Check your booking dates before requesting.*", opts);
    expect(result.text).toContain("coming to £126");
    expect(result.text).toContain("Check your booking dates");
    expect(result.flags.some(f => ["INTERNAL_ACTION", "PHYSICAL_PRESENCE"].includes(f.type))).toBe(false);
  });
  it("removes actual backstage instructions without losing either offer", () => {
    const result = guardDraft("Sony A7 V: £110.\n*Notify Daniel on Telegram immediately*\nSony FX3: £126.", opts);
    expect(result.text).toContain("Sony A7 V: £110");
    expect(result.text).toContain("Sony FX3: £126");
    expect(result.text).not.toContain("Telegram");
    expect(result.flags.some(f => f.type === "INTERNAL_ACTION")).toBe(true);
  });
  it("removes a real arrival claim while preserving separate offer lines", () => {
    const result = guardDraft("I'm coming to you now.\nSony A7 V: £110\nSony FX3: £126", opts);
    expect(result.text).not.toContain("coming to you");
    expect(result.text).toContain("Sony A7 V: £110\nSony FX3: £126");
    expect(result.flags.some(f => f.type === "PHYSICAL_PRESENCE")).toBe(true);
  });
  it("blocks an emptied draft rather than resurrecting removed content", () => {
    const result = guardDraft("*Internal note: notify Daniel on Telegram*", opts);
    expect(result.text.trim()).toBe("");
    expect(result.flags).toContainEqual(expect.objectContaining({ type: "EMPTY_DRAFT", severity: "critical", action: "flagged" }));
  });
});

describe("positive stock does not prove a negative for an unknown request", () => {
  const opts = { history: [], lastRenterMessage: "Do you actually have the Pyxis?", hasItemGrounding: true, groundedDuringTurn: { availability: true, unavailability: false } };
  it("blocks the actual unsupported denial even with a verified alternative", () => {
    for (const text of ["The Pyxis isn't available for those dates, but the BMPCC 6K Full Frame is available.", "The Pyxis isn’t available for those dates.", "The Pyxis is unavailable.", "If the Sony is unavailable, the Pyxis is unavailable for your dates."]) {
      expect(guardDraft(text, opts).flags.some(f => f.type === "UNGROUNDED_UNAVAILABILITY" && f.severity === "critical")).toBe(true);
    }
  });
  it("allows honest uncertainty and conditional planning", () => {
    for (const text of ["I cannot verify the Pyxis for these dates. BMPCC 6K Full Frame is available.", "If the Pyxis is unavailable, I can offer a verified alternative.", "I'll check whether the Pyxis is unavailable."]) {
      expect(guardDraft(text, opts).flags.some(f => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(false);
    }
  });
  it("does not confuse recording features and pickup policy with equipment stock", () => {
    for (const text of ["4K isn't available on the A7 II.", "That pickup slot isn't available. The camera is available."]) {
      expect(guardDraft(text, opts).flags.some(f => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(false);
    }
    expect(guardDraft("The Sony A7 II 4K camera isn't available for those dates.", opts).flags.some(f => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(true);
  });
  it("accepts a real negative receipt", () => {
    expect(guardDraft("The Pyxis isn't available for those dates.", { ...opts, groundedDuringTurn: { availability: false, unavailability: true } }).flags.some(f => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(false);
  });
});

describe("authoritative booking transitions", () => {
  const opts = { history: [], lastRenterMessage: "Has my request been accepted?", stage: "AWAITING_OWNER_APPROVAL" };
  it.each(["INQUIRY", "UNCONFIRMED", "CANCELLED", "VERIFICATION_FAILED", "AWAITING_OWNER_APPROVAL", "AWAITING_PAYMENT", "AWAITING_VERIFICATION"])("rejects false current confirmation in %s", stage => {
    expect(guardDraft("Your booking is confirmed.", {...opts,stage}).flags).toContainEqual(expect.objectContaining({type:"PREMATURE_CONFIRMATION",severity:"critical"}));
    expect(guardDraft("I'll share the address once the platform confirms your booking.", {...opts,stage}).flags.some(f=>f.type==="PREMATURE_CONFIRMATION")).toBe(false);
  });
  it("blocks the live false promise that acceptance alone confirms a rental", () => {
    const result = guardDraft("It's awaiting approval on my end. Once accepted, the booking will be confirmed and I'll share the exact pickup address.", opts);
    expect(result.flags.some(f => f.type === "PREMATURE_CONFIRMATION" && f.severity === "critical")).toBe(true);
  });
  it("allows waiting for actual platform confirmation without promising acceptance", () => {
    const result = guardDraft("The request is still awaiting my approval. I'll share the address once the platform confirms the booking.", opts);
    expect(result.flags.some(f => f.type === "PREMATURE_CONFIRMATION")).toBe(false);
  });
});

describe("first-person agreement",()=>{
 it("reports a harmless voice correction separately from an internal leak",()=>{
  const opts={history:[],lastRenterMessage:"Thank you",firstPerson:true};
  const result=guardDraft("We are happy to help.",opts);
  expect(result.text).toBe("I am happy to help.");
  expect(result.flags).toContainEqual(expect.objectContaining({type:"FIRST_PERSON_STYLE",severity:"low",action:"rewritten"}));
  expect(result.flags.some(f=>f.type==="INTERNAL_ACTION")).toBe(false);
  const scored=scoreDraft({accountSlug:"leo",draftText:result.text,productionFlags:result.flags});
  expect(scored.results.find(r=>r.category==="production_guard:FIRST_PERSON_STYLE")?.status).toBe("pass");
  const leaked=guardDraft("We are happy to help.\n*Internal note: notify Daniel on Telegram*",opts);
  expect(leaked.flags).toContainEqual(expect.objectContaining({type:"INTERNAL_ACTION",severity:"critical",action:"stripped"}));
  const leakScore=scoreDraft({accountSlug:"leo",draftText:leaked.text,productionFlags:leaked.flags});
  expect(leakScore.results.find(r=>r.category==="production_guard:INTERNAL_ACTION")?.status).toBe("flag");
 });
 it("preserves the verification-failure meaning when rewriting the owner's voice",()=>{
  const result=guardDraft("We aren't able to release the collection address without a confirmed booking.",{history:[],lastRenterMessage:"Verification failed, can I collect?",stage:"VERIFICATION_FAILED",firstPerson:true});
  expect(result.text).toBe("I'm not able to release the collection address without a confirmed booking.");
 });
 it("handles written-out and typographic contractions without corrupting well or were",()=>{
  const result=guardDraft("We are happy to help. We’re happy it went well when you were shooting. We’d recommend the recorded battery.",{history:[],lastRenterMessage:"Thanks",firstPerson:true});
  expect(result.text).toBe("I am happy to help. I'm happy it went well when you were shooting. I'd recommend the recorded battery.");
 });
 it("retains plural accounts' wording",()=>{
  const text="We aren't able to release the collection address without a confirmed booking.";
  expect(guardDraft(text,{history:[],lastRenterMessage:"Verification failed",firstPerson:false}).text).toBe(text);
 });
});

describe("owner approval assertions", () => {
  const opts = { history: [], lastRenterMessage: "Is my booking approved?", ownerApproved: false, stage: "awaiting_owner_approval" };
  it.each([
    "Your request has not been accepted yet. It is still awaiting approval.",
    "Once the platform has fully confirmed your booking, I will share the address.",
    "I'll share the address once your booking is confirmed.",
  ])("does not block a negative or conditional statement: %s", text => {
    expect(guardDraft(text, opts).flags.some(f => f.action === "flagged" && ["FALSE_ACTION_CLAIM", "PREMATURE_CONFIRMATION"].includes(f.type))).toBe(false);
  });
  it.each([
    "Your request is accepted.",
    "I've accepted your request.",
    "I'll share the address once your booking is confirmed. Your request is accepted.",
  ])("still blocks an actual unapproved assertion: %s", text => {
    expect(guardDraft(text, opts).flags.some(f => f.type === "FALSE_ACTION_CLAIM")).toBe(true);
  });
});

describe("pickup time acceptance", () => {
  const opts = { history: [], lastRenterMessage: "Can I collect at 8am?", pickupWindows: [{ start: "10:00", end: "12:00" }, { start: "19:00", end: "21:00" }] };
  it("does not flag an explicit refusal with a conditional confirmation later", () => {
    const r = guardDraft("I won't be able to do 8:00am. My pickup windows are 10:00 to 12:00 and 19:00 to 21:00. I'll send the address once your booking is confirmed.", opts);
    expect(r.flags.some((f) => f.type === "INVALID_TIME_ACCEPTED")).toBe(false);
  });
  it("flags direct agreement to the requested closed time", () => {
    const r = guardDraft("Sure, 8am works. See you then.", opts);
    expect(r.flags.some((f) => f.type === "INVALID_TIME_ACCEPTED")).toBe(true);
  });
  it("flags an implicit agreement without repeating the time", () => {
    const r = guardDraft("Sure, see you then.", opts);
    expect(r.flags.some((f) => f.type === "INVALID_TIME_ACCEPTED")).toBe(true);
  });
});

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
    availability: {items:[{name:"RED Komodo",available:false},{name:"Sony FX3",available:true}]},
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
  it("does not let the second guard block a correct decline and owned alternative",()=>{
    const result=guardDraft("The RED Komodo isn't available for those dates, but the Sony FX3 is available.",{...opts,unfulfillableItems:["RED Komodo"],hasItemGrounding:true,availability:{items:[{name:"RED Komodo",available:false},{name:"Sony FX3",available:true}]}});
    expect(result.flags.filter(f=>["MARKETING_ITEM_AVAILABLE","UNFULFILLABLE_BOOKING"].includes(f.type))).toEqual([]);
  });
  it("does not let a same-sentence denial of another model hide a false offer",()=>{
    const result=guardDraft("The RED Komodo is available, but the Sony FX3 isn't available.",opts);
    expect(result.flags.some(f=>f.type==="MARKETING_ITEM_AVAILABLE")).toBe(true);
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
  it("accepts a denial of editing but still catches a separate affirmative edit claim",()=>{
    for(const denial of ["I haven't changed your booking.","I haven’t changed your booking.","I have not updated your booking.","I didn't move your dates."])
      expect(fired(denial,false)).toBe(false);
    expect(fired("I haven't changed your booking dates, but I've added the extra camera.",false)).toBe(true);
    expect(fired("I haven't changed your booking. I moved your dates to tomorrow.",false)).toBe(true);
  });

  it("allows a current-state acknowledgement while a replay still cannot claim a new edit",()=>{
    expect(fired("Your dates are already set to 22–23 October.",false)).toBe(false);
    expect(fired("That lens is already on your booking.",false)).toBe(false);
    expect(fired("The current booking has the original camera kit without that extra lens.",false)).toBe(false);
    expect(fired("All done! I've moved your booking to 22–23 October.",false)).toBe(true);
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

describe("UNGROUNDED_DELIVERY_FEE", () => {
  const opts = {
    history: [],
    lastRenterMessage: "how much would delivery cost to E1 6AN?",
    factPack: { pricing: { itemPrices: [{ name: "BMPCC 6K Pro", min: 80, max: 80 }] } },
  };
  const fired = (draft: string) =>
    guardDraft(draft, opts).flags.some((f) => f.type === "UNGROUNDED_DELIVERY_FEE");

  it("catches the exact invented quote seen live", () => {
    // Verbatim from a sweep transcript. We hold no delivery rate anywhere and
    // the policy is "request postcode + courier quote", so this is a
    // commercial commitment on a price we do not know.
    expect(
      fired(
        "Addison Lee courier rates depend on the exact time of day and traffic, but to E1 6AN it's typically around £15, £25 each way at direct cost.",
      ),
    ).toBe(true);
    expect(fired("Delivery to that postcode is about £20.")).toBe(true);
  });

  it("was previously waved through by the £10-100 delivery whitelist", () => {
    // The same sentence must ALSO not be silently validated as a normal price.
    const r = guardDraft("Delivery there is around £25.", opts);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_DELIVERY_FEE")).toBe(true);
  });

  it("leaves the correct answer alone", () => {
    expect(
      fired(
        "I use Addison Lee, so the cost is their live courier quote for the distance. I can pull an exact quote once the booking is set up.",
      ),
    ).toBe(false);
  });

  it("does not fire on the rental price in a delivery conversation", () => {
    // The £80/day is grounded and unrelated to the courier fee.
    expect(fired("The camera is £80/day. I can arrange a courier if you'd like.")).toBe(false);
  });
});

describe("guardDraft — UNGROUNDED_PRICE respects the fetched-price whitelist", () => {
  // hasItemGrounding is computed BEFORE the agent runs, from prefetched context
  // only. A turn that resolves the item by calling tools still arrives with it
  // false, so this rule used to block on the mere presence of "£<digit>" and
  // never looked at what the tools returned. A reply built from five successful
  // lookup_pricing calls was withheld for "no pricing grounding" and the renter
  // got silence.
  const opts = (offeredPrices: number[]) => ({
    ...baseOpts,
    lastRenterMessage: "one A7iii and one A7V plus lenses — what's the total per day?",
    hasItemGrounding: false as const,
    factPack: { pricing: { offeredPrices } },
  });

  it("allows prices the tools actually returned", () => {
    const r = guardDraft("The A7 III is £26/day and the A7 V is £30/day.", opts([26, 30]));
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("still catches a price we never supplied", () => {
    const r = guardDraft("I can do the pair for £15/day.", opts([26, 30]));
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(true);
  });

  it("flags the invented figure even when another price is grounded", () => {
    const r = guardDraft("The A7 III is £26/day, and a tripod is £3/day.", opts([26, 30]));
    const f = r.flags.find((x) => x.type === "UNGROUNDED_PRICE");
    expect(f).toBeTruthy();
    expect(f!.detail).toContain("3");
  });

  it("accepts a multi-day multiple of a supplied daily rate", () => {
    const r = guardDraft("For the three days that's £78.", opts([26]));
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("blocks any price when the tools returned none", () => {
    const r = guardDraft("It's £26/day.", opts([]));
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(true);
  });
});

describe("guardDraft — UNGROUNDED_PRICE on a mixed order", () => {
  // The real blocked reply: "one A7iii and one A7V plus lenses and a tripod".
  // The tools returned 25.714 (A7 III), 42.857 (A7 V + lens) and 5 (tripod);
  // the bot wrote £25, £42, £5 and a £72 total. Matching only Math.round
  // rejected every one of them — its own tool results — and the renter got
  // silence on a message that said "happy to proceed".
  const mixed = {
    ...baseOpts,
    lastRenterMessage: "one A7iii and one A7V plus lenses and a tripod, total per day?",
    hasItemGrounding: false as const,
    factPack: { pricing: { offeredPrices: [25.714285, 42.857142, 5] } },
  };

  it("accepts components quoted as either floor or ceil of a fractional rate", () => {
    const r = guardDraft("The A7 III is £25/day and the A7 V with lens is £42/day.", mixed);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("accepts the rounded-up form too", () => {
    const r = guardDraft("That's £26/day for the A7 III, £43/day for the A7 V.", mixed);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("accepts the TOTAL of a mixed order", () => {
    const r = guardDraft("Altogether that comes to £72 a day.", mixed);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("accepts a partial total (two of the three items)", () => {
    // 25.714 + 5 = 30.714 -> £30 or £31
    const r = guardDraft("Just the A7 III and the tripod would be £31/day.", mixed);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("STILL rejects a total that is not a sum of grounded parts", () => {
    const r = guardDraft("I'll do the lot for £55 a day.", mixed);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(true);
  });
});

describe("guardDraft — grounding established DURING the turn", () => {
  // The root defect, of which the price bug was one symptom. hasItemGrounding
  // is computed BEFORE the agent runs, from prefetched context, and armed four
  // rules off that single verdict. A thread whose item never resolved up front
  // is exactly the thread where the agent goes and looks things up — so replies
  // built entirely from real tool results were withheld as "ungrounded" and the
  // renter got silence. Each rule now asks whether the tool behind ITS OWN
  // claim actually ran.
  const noPrefetch = {
    ...baseOpts,
    lastRenterMessage: "is this available and what are the specs?",
    hasItemGrounding: false as const,
  };

  it("allows an availability claim when check_availability ran", () => {
    const r = guardDraft("Yes, it's available for those dates.", {
      ...noPrefetch,
      groundedDuringTurn: { availability: true },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_AVAILABILITY")).toBe(false);
  });

  it("still blocks an availability claim when it did NOT run", () => {
    const r = guardDraft("Yes, it's available for those dates.", noPrefetch);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_AVAILABILITY")).toBe(true);
  });

  it("allows a negative claim when the stock result is negative", () => {
    // The tool must return a negative verdict, not merely run.
    const r = guardDraft("Sorry, that one's fully booked those days.", {
      ...noPrefetch,
      groundedDuringTurn: { unavailability: true },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(false);
  });

  it("still blocks a NEGATIVE availability claim when it did not run", () => {
    const r = guardDraft("Sorry, that one's fully booked those days.", noPrefetch);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(true);
  });

  it("allows a spec claim when the listing context was fetched", () => {
    const r = guardDraft("It shoots 4K and the sensor is full frame.", {
      ...noPrefetch,
      groundedDuringTurn: { specs: true },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(false);
  });

  it("still blocks a spec claim when nothing supplied one", () => {
    const r = guardDraft("It shoots 4K and the sensor is full frame.", noPrefetch);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(true);
  });

  it("grounding one class does NOT unlock another", () => {
    // The whole point of per-claim grounding: fetching a price must not license
    // an availability assertion. One coarse verdict is what caused this.
    const r = guardDraft("Yes it's available, and it's £30/day.", {
      ...noPrefetch,
      groundedDuringTurn: { price: true },
      factPack: { pricing: { offeredPrices: [30] } },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_AVAILABILITY")).toBe(true);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_PRICE")).toBe(false);
  });

  it("omitting groundedDuringTurn keeps the old strict behaviour", () => {
    const r = guardDraft("Yes, it's available.", noPrefetch);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_AVAILABILITY")).toBe(true);
  });
});

describe("guardDraft — availability grounding is asymmetric", () => {
  // With no dates in the renter's message there is nothing for
  // check_availability to check, so it is never called: zero times across 80
  // sweep turns. The fact pack meanwhile computed the calendar position and
  // told the bot, in those words, to "tell them when it's back and the earliest
  // they can collect" — and UNGROUNDED_UNAVAILABILITY withheld the reply for
  // doing so. The rule was unreachable-by-design and blocked its own
  // instruction. Only the negative direction is unlocked: a false "yes it's
  // free" is how a renter turns up to gear that isn't there.
  const noDates = {
    ...baseOpts,
    lastRenterMessage: "hi is this available?",
    hasItemGrounding: false as const,
  };

  it("lets the bot say it is OUT when the calendar showed that", () => {
    const r = guardDraft("It's out on a rental right now, back Saturday.", {
      ...noDates,
      groundedDuringTurn: { unavailability: true },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(false);
  });

  it("does NOT let that same signal license a positive claim", () => {
    // The whole point of splitting the flag.
    const r = guardDraft("Yes, it's available for those dates.", {
      ...noDates,
      groundedDuringTurn: { unavailability: true },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_AVAILABILITY")).toBe(true);
  });

  it("checked stock verdicts ground their own direction", () => {
    const pos = guardDraft("Yes, it's available for those dates.", {
      ...noDates,
      groundedDuringTurn: { availability: true },
    });
    const neg = guardDraft("Sorry, it's fully booked then.", {
      ...noDates,
      groundedDuringTurn: { unavailability: true },
    });
    expect(pos.flags.some((f) => f.type === "UNGROUNDED_AVAILABILITY")).toBe(false);
    expect(neg.flags.some((f) => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(false);
  });

  it("still blocks a negative when the calendar said nothing", () => {
    const r = guardDraft("Sorry, that's fully booked.", noDates);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_UNAVAILABILITY")).toBe(true);
  });
});

describe("guardDraft — UNGROUNDED_SPEC stops flagging non-claims", () => {
  // All five live firings sampled were false positives, in two shapes: the
  // number was part of the item's own NAME, or the draft was DENYING the spec.
  const base = {
    ...baseOpts,
    lastRenterMessage: "what are the specs, is it 4k?",
    hasItemGrounding: false as const,
    factPack: {
      pricing: {
        itemPrices: [
          { name: "Blackmagic camera 6k pro BMPCC6K", min: 47, max: 47 },
          { name: "Blazar Remus full frame 33mm t1.8", min: 30, max: 30 },
          { name: "Senheiser MKE 600 Shotgun Mic", min: 12, max: 12 },
        ],
      },
    },
  };

  it("does not flag the item's own name back at us", () => {
    const r = guardDraft(
      "Two Blackmagic camera 6k pro BMPCC6K would come to £94/day.",
      base,
    );
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(false);
  });

  it("does not flag a focal length that is part of the product name", () => {
    const r = guardDraft("The Blazar Remus full frame 33mm t1.8 is a great lens.", base);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(false);
  });

  it("does not flag a DENIAL of the spec", () => {
    const r = guardDraft(
      "The Senheiser MKE 600 Shotgun Mic records audio, so 4K video resolution doesn't apply to it.",
      base,
    );
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(false);
  });

  it("does not flag 'depends on what you mount it to'", () => {
    const r = guardDraft(
      "This is a lens rather than a body, so resolution like 4K depends on the camera you mount it to.",
      base,
    );
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(false);
  });

  it("STILL flags a spec the draft invented", () => {
    // The fabrication this rule exists for: a dimension we hold no data on.
    const r = guardDraft("It has a 7 inch screen and weighs 2.4kg.", base);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(true);
  });

  it("STILL flags an invented resolution not present in any item name", () => {
    const r = guardDraft("It records internally at 8K.", base);
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(true);
  });

  it("does not flag anything once specs were actually fetched", () => {
    const r = guardDraft("It has a 7 inch screen.", {
      ...base,
      groundedDuringTurn: { specs: true },
    });
    expect(r.flags.some((f) => f.type === "UNGROUNDED_SPEC")).toBe(false);
  });
});


describe("independent availability clauses", () => {
  const opts = { history: [], lastRenterMessage: "Are both available?", hasItemGrounding: true,
    availability: { items: [{ name: "Sony FX3", available: false }, { name: "Sony GM 24-70mm", available: true }] } };
  it("does not let another negative conceal a false positive", () => {
    const result = guardDraft("Sony FX3 is available, but Sony GM 24-70mm is unavailable.", opts);
    expect(result.flags.filter((f) => f.type === "AVAILABILITY_CONTRADICTION")).toHaveLength(2);
  });
  it("accepts a correct mixed basket answer", () => {
    const result = guardDraft("Sony FX3 is unavailable, but Sony GM 24-70mm is available.", opts);
    expect(result.flags.some((f) => f.type === "AVAILABILITY_CONTRADICTION")).toBe(false);
  });
  it("does not interpret an explicit refusal as a positive", () => {
    const result = guardDraft("Sony FX3 isn't available.", opts);
    expect(result.flags.some((f) => f.type === "AVAILABILITY_CONTRADICTION")).toBe(false);
  });
});


describe("quantity-aware sales replies", () => {
  const opts = { history: [], lastRenterMessage: "Are two Sony FX3 cameras available?", hasItemGrounding: true,
    availability: { items: [{ name: "Sony FX3", available: false, quantity: 2, free_units: 1 }] } };
  it("allows a truthful offer of the one remaining camera", () => {
    const r = guardDraft("I only have 1 Sony FX3 free for those dates. Would one camera work for your shoot?", opts);
    expect(r.flags.some((f) => f.type === "AVAILABILITY_CONTRADICTION")).toBe(false);
    expect(r.text).toContain("Would one camera work");
  });
  it("still catches falsely offering both cameras", () => {
    const r = guardDraft("Both Sony FX3 cameras are available for those dates.", opts);
    expect(r.flags.some((f) => f.type === "AVAILABILITY_CONTRADICTION")).toBe(true);
  });
  it("does not strip a grounded alternative from an availability answer", () => {
    const r = guardDraft("Sony FX3 is unavailable. I can pair the remaining camera with a Sony A7 III. Would that work?", opts);
    expect(r.text).toContain("Sony A7 III");
    expect(r.text).toContain("Would that work");
  });
  it("keeps a model clarification when the equipment identity is ambiguous", () => {
    const r = guardDraft("Which BMPCC 6K model do you mean, the Pro or the Full Frame?", { ...opts, lastRenterMessage: "Does the BMPCC 6K take EF lenses?" });
    expect(r.text).toContain("Which BMPCC 6K");
  });
});

describe("unknown-kit subject attribution", () => {
  const opts = { history: [], lastRenterMessage: "What does the alternative include?", factPack: {
    itemsWithoutKitData: ["Blackmagic Pyxis"],
    kitEvidence: [{ names: ["BMPCC 6K Full Frame", "Blackmagic Cinema Camera 6K"], contents: ["NP-F570 batteries 5x", "1TB CFexpress Type B card", "EF-to-L mount adapter"] }],
  } };
  it("accepts the actual alternative reply without borrowing its kit for the unknown original", () => {
    const result = guardDraft("The Pyxis is unavailable. I can offer the Blackmagic Cinema Camera 6K Full Frame. In terms of power and storage, it includes 5x NP-F570 batteries and a 1TB CFexpress Type B card.", opts);
    expect(result.flags.filter(f => f.type === "KIT_HALLUCINATION")).toEqual([]);
  });
  it("still blocks an explicit switch back to the unknown original", () => {
    const result = guardDraft("BMPCC 6K Full Frame includes batteries. Blackmagic Pyxis includes batteries and a card.", opts);
    expect(result.flags.some(f => f.type === "KIT_HALLUCINATION")).toBe(true);
  });
  it("still blocks unsupported alternative contents and unattributed unknown kits", () => {
    for (const text of ["BMPCC 6K Full Frame includes a charger.", "It includes a charger and batteries.", "The kit includes:\n- batteries\n- a charger"]) {
      expect(guardDraft(text, opts).flags.some(f => f.type === "KIT_HALLUCINATION")).toBe(true);
    }
  });
  it("requires human review for wrong specific accessory details, while allowing the actual kit", () => {
    for (const included of ["six NP-F570 batteries", "five LP-E6NH batteries", "a 1TB CFast card", "a 2TB CFexpress Type B card"]) {
      const result = guardDraft(`BMPCC 6K Full Frame includes ${included}.`, opts);
      expect(result.flags.some(f => f.type === "KIT_HALLUCINATION" && f.severity === "critical")).toBe(true);
    }
    expect(guardDraft("BMPCC 6K Full Frame includes five NP-F570 batteries and a 1TB CFexpress Type B card.", opts)
      .flags.filter(f => f.type === "KIT_HALLUCINATION")).toEqual([]);
  });
});


describe("booked-kit references still require the current owner approval", () => {
  const common={history:[],lastRenterMessage:"Does my kit include the Canon lens?",stockRequest:{items:[{name:"Canon EF 24-105mm f4",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"},stockEvidence:[]};
  it("accepts the exact kit reference after confirmation and blocks it before approval", () => {
    const text="Your booked kit includes the Canon EF 24-105mm f4 lens.";
    expect(guardDraft(text,{...common,stage:"confirmed",ownerApproved:true}).flags.some(f=>f.type==="UNGROUNDED_UNAVAILABILITY"||f.type==="FALSE_ACTION_CLAIM")).toBe(false);
    expect(guardDraft(text,{...common,stage:"inquiry",ownerApproved:false}).flags.some(f=>f.type==="FALSE_ACTION_CLAIM")).toBe(true);
  });
  it("checks customer booking predicates independently from equipment stock", () => {
    expect(guardDraft("Your Canon EF 24-105mm f4 is booked for you.",{...common,stage:"inquiry",ownerApproved:false}).flags.some(f=>f.type==="FALSE_ACTION_CLAIM")).toBe(true);
  });
  it("does not describe a conditional future booking as an approval that happened", () => {
    expect(guardDraft("Once your kit is booked, I can confirm the collection details.",{...common,stage:"inquiry",ownerApproved:false}).flags.some(f=>f.type==="FALSE_ACTION_CLAIM")).toBe(false);
  });
});


describe("quote review uses native amount evidence instead of a price presence metric",()=>{
 const opts={history:[],lastRenterMessage:"Does the TTArtisan 11mm autofocus? If manual, quote an autofocus wide-angle alternative.",priceEvidence:[{kind:"rental" as const,names:["TTArtisan 11mm f2.8 Fisheye (Sony E)"],quantity:1,days:2,start_date:"2026-10-20",end_date:"2026-10-21",total_gbp:42,source:"hygglo_tier",call_id:"native-quote"}],priceRequest:{items:[{name:"TTArtisan 11mm f2.8 Fisheye (Sony E)",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"}};
 it("does not demand an unrelated existing rental price in a truthful partial answer",()=>{
  const result=guardDraft("The TTArtisan 11mm is manual focus. I own the Sony GM 16-35mm, but need to confirm its exact specs and availability before quoting.",opts);
  expect(result.flags.some(f=>f.type==="CONTRACT:price-figure")).toBe(false);
 });
 it("still blocks a fabricated amount for the known rental",()=>{
  const result=guardDraft("The TTArtisan 11mm f2.8 Fisheye (Sony E) costs £99 total for 20 to 21 October.",opts);
  expect(result.flags.some(f=>f.type==="PRICE_HALLUCINATION"&&f.severity==="critical")).toBe(true);
 });
 it("accepts the exact native quote when that is what the reply supplies",()=>{
  const result=guardDraft("The TTArtisan 11mm f2.8 Fisheye (Sony E) costs £42 total for 20 to 21 October.",opts);
  expect(result.flags.some(f=>f.type==="PRICE_HALLUCINATION")).toBe(false);
 });
});


describe("reasoning cleanup preserves rental facts",()=>{
  const opts={history:[],lastRenterMessage:"Can I add the Pro kit?",hasItemGrounding:true,groundedDuringTurn:{availability:true,unavailability:true}};
  it("preserves the actual full-kit refusal before the separately priced body offer",()=>{
    const text="For the Blackmagic 6K Pro kit with the 24-105mm lens, I only have one Canon EF 24-105mm lens in stock (which is currently assigned to your Full Frame booking), so I can't supply a second 24-105mm lens for those dates.\n\nHowever, the BMPCC 6K Pro body set is available for 20 to 21 October.\n\nBoth cameras can go out with five native NP-F570 batteries each.";
    const result=guardDraft(text,opts);
    expect(result.text).toContain("currently assigned to your Full Frame booking");
    expect(result.text).toContain("can't supply a second 24-105mm lens");
    expect(result.text).toContain("However, the BMPCC 6K Pro");
    expect(result.flags.some(f=>f.type==="CHAIN_OF_THOUGHT")).toBe(false);
  });
  it("does not erase factual stock quantities in a multi-line renter reply",()=>{
    const result=guardDraft("There are 2 units available for your dates.\n\nYour Full Frame booking already includes the Canon lens.\n\nThe inventory shows enough batteries for both cameras.",opts);
    expect(result.text).toContain("2 units available");
    expect(result.text).toContain("Full Frame booking");
    expect(result.text).toContain("enough batteries");
    expect(result.flags.some(f=>f.type==="CHAIN_OF_THOUGHT")).toBe(false);
  });
  it("still strips explicit deliberation and its stock working before the renter answer",()=>{
    const result=guardDraft("Let me think through the stock.\nThe inventory shows 2 units available.\nI should suggest the body kit.\n\nThe body kit is available for your dates, and your existing booking remains unchanged.",opts);
    expect(result.text).toContain("The body kit is available");
    expect(result.text).not.toContain("Let me think");
    expect(result.text).not.toContain("I should suggest");
    expect(result.flags.some(f=>f.type==="CHAIN_OF_THOUGHT")).toBe(true);
  });
  it("does not attach a later internal paragraph to an earlier stock explanation",()=>{
    const result=guardDraft("Your Full Frame booking already includes the Canon lens.\n\nLet me think about the next sentence.\n\nThe body kit is available for your dates.",opts);
    expect(result.text).toContain("Full Frame booking already includes the Canon lens");
    expect(result.text).not.toContain("Let me think");
    expect(result.text).toContain("body kit is available");
  });
  it("still removes explicitly tagged internal reasoning",()=>{
    const result=guardDraft("<think>The inventory shows enough batteries.</think>The body kit is available for your dates.",opts);
    expect(result.text).not.toContain("inventory shows");
    expect(result.text).toContain("body kit is available");
    expect(result.flags.some(f=>f.type==="CHAIN_OF_THOUGHT")).toBe(true);
  });
});

describe("captured updated-setup booking confirmation",()=>{
 const text=updatedSetupCapture.reply;
 const opts={history:[],lastRenterMessage:"Yes, please add both.",stage:"confirmed",bookingModified:true,
  factPack:{kitEvidence:[{names:["BMPCC 6K Full Frame"],contents:["Canon EF 24-105mm lens","EF to L mount"],booked_camera:true}]},
  stockRequest:updatedSetupCapture.stockRequest,priceRequest:updatedSetupCapture.priceRequest,priceEvidence:updatedSetupCapture.priceEvidence as PriceEvidence[]};
 it("passes the full guard for the exact actual model wording",()=>{
  const result=guardDraft(text,opts);expect(result.flags.filter(f=>f.severity==="critical")).toEqual([]);expect(result.text).toBe(text.replace("20–21","20-21"));
 });
 it("keeps an explicitly wrong mount blocked",()=>{
  const result=guardDraft(text.replace("the adapter for","the PL to EF mount adapter for"),opts);expect(result.flags.some(f=>f.type==="KIT_HALLUCINATION")).toBe(true);
 });
});
