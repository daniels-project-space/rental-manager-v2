import { describe, expect, it } from "vitest";
import { unsupportedKitClaims } from "./kit_claims";
const kit = { names: ["Sony A7 V"], contents: ["Sony A7 V", "NP-FZ100 batteries", "256GB card"] };
describe("per-item included-content claims", () => {
  it("checks the actual multiline inclusion list instead of only its empty heading", () => {
    const text = "Sony A7 V is available.\n\nThe kit includes:\n- NP-FZ100 batteries (plus charger)\n- 256GB card\n\nLet me know if you would like it.";
    expect(unsupportedKitClaims(text, [kit]).map(f => f.content)).toEqual(["charger"]);
    expect(unsupportedKitClaims(text.replace("includes:\n", "includes:\n\n"), [kit]).map(f => f.content)).toEqual(["charger"]);
    expect(unsupportedKitClaims(text.replace(" (plus charger)", ""), [kit])).toEqual([]);
  });
  it("rejects an unlisted charger even though batteries and a card are known", () => {
    expect(unsupportedKitClaims("Sony A7 V is £110. That includes the body, batteries, charger, and a 256GB card.", [kit]).map(f => f.content)).toEqual(["charger"]);
  });
  it("also checks contents stated before the word included", () => {
    expect(unsupportedKitClaims("Sony A7 V charger included at no extra cost.", [kit]).map(f => f.content)).toEqual(["charger"]);
  });
  it("accepts actual included contents and preserves negative qualifications", () => {
    expect(unsupportedKitClaims("Sony A7 V comes with batteries and a card, but not a charger.", [kit])).toEqual([]);
    expect(unsupportedKitClaims("Sony A7 V does not include a charger.", [kit])).toEqual([]);
  });
  it("does not borrow a different model's inclusions", () => {
    const other = { names: ["Sony FX3"], contents: ["charger"] };
    expect(unsupportedKitClaims("Sony A7 V includes a charger.", [kit, other]).map(f => f.content)).toEqual(["charger"]);
  });
  it("requires the recorded battery type and individual count", () => {
    const bm = { names: ["Blackmagic 6K Full Frame"], contents: ["5 × NP-F570 batteries", "1 × 1TB CFexpress Type B card"] };
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes five NP-F570 batteries and a 1TB CFexpress Type B card.", [bm])).toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes 5 × NP-F570 batteries and 1 × 1TB CF Express B card.", [bm])).toEqual([]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes six NP-F570 batteries.", [bm]).map(f => f.content)).toEqual(["battery"]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes three NP-F570 batteries.", [bm]).map(f => f.content)).toEqual(["battery"]);
    expect(unsupportedKitClaims("Blackmagic 6K Full Frame includes five LP-E6NH batteries.", [bm]).map(f => f.content)).toEqual(["battery"]);
  });
  it("does not infer individual batteries from ambiguous sets", () => {
    const sony = { names: ["Sony FX3"], contents: ["Sony NP-FZ100 batteries 2x sets"] };
    expect(unsupportedKitClaims("Sony FX3 includes two NP-FZ100 batteries.", [sony]).map(f => f.content)).toEqual(["battery"]);
    expect(unsupportedKitClaims("Sony FX3 includes NP-FZ100 batteries.", [sony])).toEqual([]);
  });
  it("checks storage interface, capacity and count without adding duplicate descriptions", () => {
    const bm = { names: ["Blackmagic 6K Full Frame"], contents: ["1 × 1TB CFexpress Type B card", "CFexpress Type B card"] };
    for (const contents of ["a 1TB CFast card", "a 1TB CFexpress Type A card", "a 2TB CFexpress Type B card", "two CFexpress Type B cards"]) {
      expect(unsupportedKitClaims(`Blackmagic 6K Full Frame includes ${contents}.`, [bm]).map(f => f.content)).toEqual(["card"]);
    }
  });
  it("does not combine attributes from different supplied cards", () => {
    const mixed = { names: ["Sony FX3"], contents: ["1 × 256GB CFexpress Type A card", "1 × 1TB SD card"] };
    expect(unsupportedKitClaims("Sony FX3 includes a 1TB CFexpress Type A card.", [mixed]).map(f => f.content)).toEqual(["card"]);
    expect(unsupportedKitClaims("Sony FX3 includes a 256GB CFexpress Type A card and a 1TB SD card.", [mixed])).toEqual([]);
  });
  it("attributes Roman numeral model names exactly", () => {
    const older = { names: ["Sony A7 II"], contents: ["NP-FW50 batteries"] };
    const newer = { names: ["Sony A7 III"], contents: ["NP-FZ100 batteries"] };
    expect(unsupportedKitClaims("Sony A7 III includes NP-FZ100 batteries.", [older, newer])).toEqual([]);
    expect(unsupportedKitClaims("Sony A7 II includes NP-FZ100 batteries.", [older, newer]).map(f => f.content)).toEqual(["battery"]);
  });
});
