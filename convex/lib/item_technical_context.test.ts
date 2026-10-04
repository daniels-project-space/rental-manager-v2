import { describe, expect, it } from "vitest";
import { equipmentUsageContext, itemTechnicalContext } from "./item_technical_context";

describe("technical evidence reaching the generation prompt", () => {
  it("preserves exact identity, source and manual-focus facts in a recommendation", () => {
    const context = itemTechnicalContext({
      spec_text: "11mm fisheye, Sony E mount.",
      spec_verification: { model: "TTArtisan 11mm f/2.8", source_url: "https://ttartisan.com/" },
      lens_capabilities: { model: "TTArtisan 11mm f/2.8", source_url: "https://ttartisan.com/", focus_mode: "manual_focus", projection: "fisheye" },
    });
    expect(context).toContain("TTArtisan 11mm f/2.8");
    expect(context).toContain("https://ttartisan.com/");
    expect(context).toContain('"focus_mode":"manual_focus"');
    expect(context).toContain('"projection":"fisheye"');
    expect(context).toContain("Focus mode does not establish electronic contacts");
  });
  it("does not infer a camera from a lens-only rental", () => {
    const context = equipmentUsageContext([{ inventory_components: [
      { name: "TTArtisan 11mm f/2.8 (Sony E)", kind: "lens", owned: true },
    ] }]);
    expect(context.supplied_camera_bodies).toEqual([]);
    expect(context.renter_camera_body).toBeNull();
  });
  it("preserves all supplied bodies without selecting the renter's camera", () => {
    const context = equipmentUsageContext([{ inventory_components: [
      { name: "Sony FX3", kind: "camera", owned: true },
      { name: "Sony FX3", kind: "camera", owned: true },
      { name: "Canon R5", kind: "camera_body", owned: true },
    ] }]);
    expect(context.supplied_camera_bodies).toEqual(["Sony FX3", "Canon R5"]);
    expect(context.renter_camera_body).toBeNull();
  });
  it("does not promote unowned or unresolved components into supplied cameras", () => {
    expect(equipmentUsageContext([{ inventory_components: [
      { name: "Canon R5", kind: "camera_body", owned: false },
      { name: "Sony FX3", kind: "camera", owned: null },
      { name: null, kind: "camera", owned: true },
    ] }, {}]).supplied_camera_bodies).toEqual([]);
  });
  it("does not promote legacy prose into reviewed specifications", () => {
    const context = itemTechnicalContext({ spec_text: "Sony autofocus lens" });
    expect(context).not.toContain("Sony autofocus lens");
    expect(context).toContain("not reviewed");
  });
});
