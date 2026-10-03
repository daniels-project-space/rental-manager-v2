import { describe, expect, it } from "vitest";
import { itemTechnicalContext } from "./item_technical_context";

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
  });
  it("does not promote legacy prose into reviewed specifications", () => {
    const context = itemTechnicalContext({ spec_text: "Sony autofocus lens" });
    expect(context).not.toContain("Sony autofocus lens");
    expect(context).toContain("not reviewed");
  });
});
