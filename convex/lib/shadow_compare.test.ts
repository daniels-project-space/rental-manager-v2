import { describe, it, expect } from "vitest";
import { compareToReal, extractPrices } from "./shadow_compare";

/**
 * The comparison decides every number the shadow report prints, so a bug here
 * invents defects that do not exist or hides ones that do. Both directions are
 * tested, and so is the case this method most easily gets wrong: grading a
 * date-dependent answer as a contradiction when the calendar simply moved.
 */
describe("extractPrices", () => {
  it("reads both £ and worded amounts", () => {
    expect(extractPrices("it's £35/day or 120 pounds for the week")).toEqual([35, 120]);
  });
  it("ignores non-money numbers", () => {
    expect(extractPrices("the 24-105 lens, 3 batteries")).toEqual([]);
  });
});

const base = { ask: "how much is it?", realReply: "£35 a day", draft: "£35 a day" };

describe("compareToReal", () => {
  it("calls an empty draft a defect — silence is the worst outcome", () => {
    const r = compareToReal({ ...base, draft: "" });
    expect(r.defects).toBe(1);
    expect(r.verdicts[0].category).toBe("produced_a_reply");
  });

  it("flags a price contradiction", () => {
    const r = compareToReal({ ...base, draft: "It's £45 a day." });
    const p = r.verdicts.find((v) => v.category === "price_agreement");
    expect(p?.status).toBe("defect");
  });

  it("accepts a matching price", () => {
    const p = compareToReal(base).verdicts.find((v) => v.category === "price_agreement");
    expect(p?.status).toBe("match");
  });

  it("flags deferring where the human answered outright", () => {
    const r = compareToReal({ ...base, draft: "Let me check and get back to you." });
    const d = r.verdicts.find((v) => v.category === "deferred_where_human_answered");
    expect(d?.status).toBe("defect");
  });

  it("does NOT punish answering where the human deferred", () => {
    const r = compareToReal({
      ask: "does it come with a mic?",
      realReply: "let me check for you",
      draft: "No, but I can add one to your order.",
    });
    const d = r.verdicts.find((v) => v.category === "deferred_where_human_answered");
    expect(d?.status).toBe("divergent");
    expect(d?.status).not.toBe("defect");
  });

  it("catches a yes/no contradiction on kit contents", () => {
    const r = compareToReal({
      ask: "does it come with a mic?",
      realReply: "Not by itself but I can add the microphones to your order",
      draft: "Yes, a microphone is included with the camera.",
    });
    const y = r.verdicts.find((v) => v.category === "yes_no_agreement");
    expect(y?.status).toBe("defect");
  });

  it("does NOT grade a date-dependent yes/no as a contradiction", () => {
    // Replayed months later against a different calendar: a difference here is
    // the world moving on, not the bot being wrong. Grading it would
    // manufacture a failure.
    const r = compareToReal({
      ask: "is it free on the 20th?",
      realReply: "Yes that's available for those dates",
      draft: "No, unfortunately it's booked on the 20th.",
    });
    const y = r.verdicts.find((v) => v.category === "yes_no_agreement");
    expect(y?.status).toBe("incomparable");
    expect(r.defects).toBe(0);
  });

  it("notices the human asked a clarifying question and the bot did not", () => {
    const r = compareToReal({
      ask: "can i pick up early?",
      realReply: "when would you be looking to pick up?",
      draft: "Early pickup is usually fine.",
    });
    expect(
      r.verdicts.find((v) => v.category === "clarifying_question")?.status,
    ).toBe("divergent");
  });

  it("flags a draft many times longer than the real reply", () => {
    const r = compareToReal({
      ask: "all good?",
      realReply: "Yes should all be good",
      draft: "Thank you so much for reaching out about this. ".repeat(4),
    });
    expect(r.verdicts.find((v) => v.category === "length")?.status).toBe("divergent");
  });

  it("passes guard flags straight through as defects", () => {
    const r = compareToReal({ ...base, guardFlags: ["INVENTED_POPULARITY"] });
    expect(r.verdicts.some((v) => v.category === "guard" && v.status === "defect")).toBe(true);
  });

  it("reports a clean exchange with no defects", () => {
    expect(compareToReal(base).defects).toBe(0);
  });
});
