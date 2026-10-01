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
