import { describe, it, expect } from "vitest";
import { recommendationKit } from "./recommendation_kit";
const body = { _id: "body", name_canonical: "BMPCC 6K Full Frame", kind: "camera", compatibility: { included_with_rental: ["5× NP-F570 batteries", "1TB CFexpress Type B"] } };
const lens = { _id: "lens", name_canonical: "Native L lens", kind: "lens" };
describe("recommendation kit provenance", () => {
  it("uses corrected body facts and physical components", () => {
    const kit = recommendationKit(body, { components: [{ item_id: "body", qty: 1 }] }, [body]);
    expect(kit.includes_lens).toBe(false);
    expect(kit.included).toContain("NP-F570"); expect(kit.included).toContain("CFexpress Type B");
    expect(kit.source).toBe("physical_mapping_and_inventory");
  });
  it("proves lens inclusion only from a complete physical mapping", () => {
    expect(recommendationKit(body, { components: [{ item_id: "body", qty: 1 }, { item_id: "lens", qty: 1 }] }, [body, lens]).includes_lens).toBe(true);
    for (const mapping of [undefined, { components: [] }, { components: [{ item_id: "missing", qty: 1 }] }]) {
      const kit = recommendationKit(body, mapping, [body, lens]);
      expect(kit.includes_lens).toBe(null); expect(kit.included).toContain("NP-F570");
    }
  });
  it("does not treat a standalone lens as a camera kit with included glass", () => {
    expect(recommendationKit(lens, { components: [{ item_id: "lens", qty: 1 }] }, [lens]).includes_lens).toBe(null);
  });
});
