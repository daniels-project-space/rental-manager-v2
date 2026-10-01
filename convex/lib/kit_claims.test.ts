import { describe, expect, it } from "vitest";
import { unsupportedKitClaims } from "./kit_claims";
const kit = { names: ["Sony A7 V"], contents: ["Sony A7 V", "NP-FZ100 batteries", "256GB card"] };
describe("per-item included-content claims", () => {
  it("checks the actual multiline inclusion list instead of only its empty heading", () => {
    const text = "Sony A7 V is available.\n\nThe kit includes:\n- NP-FZ100 batteries (plus charger)\n- 256GB card\n\nLet me know if you would like it.";
    expect(unsupportedKitClaims(text, [kit]).map(f => f.content)).toEqual(["charger"]);
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
});
