import { describe, expect, it } from "vitest";
import { unsupportedSensorIdentityClaims } from "./camera_sensor_comparisons";
import { guardDraft } from "./draft_guard";

describe("manufacturer reviewed sensor comparisons", () => {
  it("qualifies the captured marketing refusal followed by the owned alternative", () => {
    expect(unsupportedSensorIdentityClaims("The Sony A7S III isn't available. I can offer the Sony FX3 instead, which shares the same full-frame sensor and native E-mount.")).toEqual([]);
    expect(unsupportedSensorIdentityClaims("The FX3 has the same sensor as the A7s3.")).toEqual([]);
  });
  it("does not extend a reviewed pair to variants or another manufacturer", () => {
    for (const text of ["The FX3 and FX30 have the same sensor.", "The FX3 has the same sensor as the A7 III.", "The FX3 and Canon R5 have identical sensors.", "The FX3 has the same sensor as the FX6."]) {
      expect(unsupportedSensorIdentityClaims(text)).toHaveLength(1);
    }
  });
  it("also checks shared and possessive sensor phrasing without treating every sensor mention as identity", () => {
    expect(unsupportedSensorIdentityClaims("The FX3 shares its sensor with the A7S III.")).toEqual([]);
    expect(unsupportedSensorIdentityClaims("The FX3 uses the A7S III's sensor.")).toEqual([]);
    expect(unsupportedSensorIdentityClaims("The FX30 shares its sensor with the FX3.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("The FX3 uses the FX6's sensor.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("The FX3 uses a full-frame CMOS sensor.")).toEqual([]);
  });
  it("requires exact subjects instead of reusing a previous reviewed pair", () => {
    expect(unsupportedSensorIdentityClaims("The FX3 and A7S III have the same sensor. The FX30 shares the same sensor.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("The FX3 and A7S III have the same sensor. The Sony A7R III shares the same sensor.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("They have the same sensor.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("They have the same sensor.", ["Sony FX3", "Sony A7S III"])).toEqual([]);
    expect(unsupportedSensorIdentityClaims("They all have the same sensor.", ["Sony FX3", "Sony A7S III", "Sony FX6"])).toHaveLength(1);
  });
  it("keeps format comparisons, uncertainty and local negatives separate", () => {
    for (const text of ["The FX3 and FX6 have the same sensor format.", "The FX30 does not have the same sensor as the FX3.", "I'll check whether the FX3 and FX6 have the same sensor.", "Do the FX3 and FX6 have the same sensor?"]) expect(unsupportedSensorIdentityClaims(text)).toEqual([]);
    expect(unsupportedSensorIdentityClaims("The FX30 doesn't have the same sensor as the FX3, but the FX6 has the same sensor as the FX3.")).toHaveLength(1);
  });
  it("connects unsupported comparisons to the critical output guard", () => {
    expect(guardDraft("The FX3 and FX30 have the same sensor.", { history: [], lastRenterMessage: "Are those cameras the same?" }).flags)
      .toContainEqual(expect.objectContaining({ type: "CAMERA_COMPARISON_HALLUCINATION", severity: "critical", action: "flagged" }));
  });
  it("does not let an unrelated decline or stock check excuse a sensor assertion", () => {
    expect(unsupportedSensorIdentityClaims("The A7S III isn't available and the FX30 has the same sensor as the FX3.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("I'll check the dates; the FX30 has the same sensor as the FX3.")).toHaveLength(1);
    expect(unsupportedSensorIdentityClaims("I'll check stock and the FX30 has the same sensor as the FX3.")).toHaveLength(1);
  });
  it("checks the actual numeric and sensor-family adjectives without losing decimal precision", () => {
    const captured = "The Sony A7S III isn't available for 6 to 7 October, but the Sony FX3 is available. It shares the same 12.1MP full-frame Exmor R sensor as the A7S III.";
    expect(unsupportedSensorIdentityClaims(captured)).toEqual([]);
    expect(unsupportedSensorIdentityClaims("The FX30 shares the same 12.1MP full-frame Exmor R sensor as the FX3.")).toHaveLength(1);
  });
});
