import { inventorySpecMap, inventorySpec, ownedInventoryItem, verifiedLensFocus } from "./inventory_spec_grounding";
import { describe, expect, it } from "vitest";
import { verifiedItemSpec } from "./verified_item_spec";
const official = { item_name_canonical: "Sony A7 V", description: "33MP full-frame camera", source: "manufacturer-verified", source_url: "https://www.sony.co.uk/electronics/support/e-mount-body-ilce-7-series/ilce-7m5/specifications", verified_model: "ILCE-7M5", verified_at: 1790812800000 };
describe("verified model specifications", () => {
  it("rejects generated/imported prose even when it sounds plausible", () => {
    expect(verifiedItemSpec({ ...official, source: "grok-generated-2026-05-08" }, "Sony A7 V")).toBeNull();
    expect(verifiedItemSpec({ item_name_canonical: "Sony A7 V", source: "v1-handwritten", description: "61MP" }, "Sony A7 V")).toBeNull();
  });
  it("requires the exact inventory identity and recorded model/source verification", () => {
    expect(verifiedItemSpec(official, "Sony A7R V")).toBeNull();
    expect(verifiedItemSpec({ ...official, verified_model: "" }, "Sony A7 V")).toBeNull();
    expect(verifiedItemSpec({ ...official, source_url: "not a source" }, "Sony A7 V")).toBeNull();
  });
  it("provides the authoritative text and its source together", () => {
    expect(verifiedItemSpec(official, "Sony A7 V")).toMatchObject({ text: "33MP full-frame camera", model: "ILCE-7M5", source_url: official.source_url });
  });
});


describe("inventory chat spec grounding", () => {
  it("joins physical IDs and refuses duplicate or mismatched spec identities", () => {
    const row = {...official, item_id: "body"};
    expect(inventorySpec(inventorySpecMap([row]).get("body"), "Sony A7 V")?.model).toBe("ILCE-7M5");
    expect(inventorySpec(inventorySpecMap([row]).get("other-body"), "Sony A7 V")).toBeNull();
    expect(inventorySpec(row, "Sony A7 III")).toBeNull();
    expect(inventorySpecMap([row, {...row, description: "conflicting description"}]).has("body")).toBe(false);
  });
  it("does not expose generated specs as the answer source", () => {
    expect(inventorySpec({...official, source: "grok-generated"}, "Sony A7 V")).toBeNull();
  });
  it("does not infer focus from a brand, mount, manual iris or camera AF features", () => {
    expect(verifiedLensFocus("lens", undefined)).toBeNull();
    expect(verifiedLensFocus("lens", "Sony E mount; manual iris")).toBeNull();
    expect(verifiedLensFocus("camera", "autofocus")).toBeNull();
    expect(verifiedLensFocus("lens", "Autofocus lens with manual focus override")).toBe("autofocus");
    expect(verifiedLensFocus("lens", "Manual-focus only, no autofocus")).toBe("manual_focus");
  });
  it("requires active positive owned stock even when marketing flags disagree", () => {
    expect(ownedInventoryItem({status:"marketing_only", is_marketing_only:false, qty:1})).toBe(false);
    expect(ownedInventoryItem({status:"active", is_marketing_only:true, qty:1})).toBe(false);
    expect(ownedInventoryItem({status:"active", qty:0})).toBe(false);
    expect(ownedInventoryItem({status:"active", qty:1})).toBe(true);
  });
});
