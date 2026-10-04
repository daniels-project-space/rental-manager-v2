import { describe, it, expect } from "vitest";
import { recordedKit, recommendationKit } from "./recommendation_kit";
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

describe("selected kit source boundary", () => {
  it("keeps a physical mapping partial, with no inferred charger or cable", () => {
    const kit = recordedKit([{ name: body.name_canonical, qty: 1 }], body.compatibility.included_with_rental);
    expect(kit.completeness).toBe("partial");
    expect(kit.contents).toEqual(["1 × BMPCC 6K Full Frame", "5× NP-F570 batteries", "1TB CFexpress Type B"]);
    expect(kit.included).not.toMatch(/LP-E6|charger|cable|3×/i);
  });
  it("retains set wording without inventing individual counts", () => {
    expect(recordedKit([], ["NP-FZ100 batteries 2×sets"]).included).toBe("NP-FZ100 batteries 2×sets");
    expect(recordedKit([], []).completeness).toBe("unknown");
  });
  it("deduplicates records and does not turn invalid mapping quantities into contents", () => {
    const kit = recordedKit([{ name: "body", qty: 0 }, { name: null, qty: 1 }], [" charger ", "charger", ""]);
    expect(kit.contents).toEqual(["charger"]);
    expect(kit.source).toBe("inventory_record");
  });
});

it("does not list the same five physical batteries twice through mapping and inventory wording",()=>{
 const kit=recordedKit([{name:"NP-F570 batteries",qty:5}],["5x NP-F570 battery","camera cage"]);
 expect(kit.contents).toEqual(["5 × NP-F570 batteries","camera cage"]);
 expect(recordedKit([{name:"NP-F570 batteries",qty:5}],["10x NP-F570 battery","1x BMPCC battery pack"]).contents).toEqual(["5 × NP-F570 batteries","10x NP-F570 battery","1x BMPCC battery pack"]);
});

describe("mapped media and accessory-note identity",()=>{
 it("keeps the actual generic card without inventing its format or a second card",()=>{
  const kit=recordedKit([{name:"256GB card",qty:1}],["CF Express Type A card","2× battery sets"]);
  expect(kit.contents).toEqual(["1 × 256GB card","2× battery sets"]);
  expect(kit.unreconciled_contents).toEqual(["CF Express Type A card"]);
 });
 it("collapses a note already established by one exact mapped medium",()=>{
  const kit=recordedKit([{name:"256GB CFexpress Type A card",qty:1}],["CF Express Type A card","1x 256GB CFexpress Type A card"]);
  expect(kit.contents).toEqual(["1 × 256GB CFexpress Type A card"]);expect(kit.unreconciled_contents).toEqual([]);
 });
 it("retains provably different media without merging card capacities or formats",()=>{
  expect(recordedKit([{name:"256GB SD card",qty:1}],["1TB CFexpress Type A card"]).contents).toEqual(["1 × 256GB SD card","1TB CFexpress Type A card"]);
  expect(recordedKit([{name:"256GB card",qty:1}],["1TB CFexpress Type B card"]).unreconciled_contents).toEqual([]);
 });
 it("does not add mismatched counts or assign an unqualified note across two possible units",()=>{
  expect(recordedKit([{name:"256GB SD card",qty:1}],["2x 256GB SD card"]).unreconciled_contents).toEqual(["2x 256GB SD card"]);
  expect(recordedKit([{name:"256GB CFexpress Type A card",qty:1},{name:"512GB CFexpress Type A card",qty:1}],["CFexpress Type A card"]).unreconciled_contents).toEqual(["CFexpress Type A card"]);
 });
});
