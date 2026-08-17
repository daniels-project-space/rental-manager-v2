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
