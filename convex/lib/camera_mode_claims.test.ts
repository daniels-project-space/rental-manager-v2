import { describe, expect, it } from "vitest";
import { unsupportedCameraModeClaims, type CameraEvidence } from "./camera_mode_claims";
import { guardDraft } from "./draft_guard";
import type { RecordingMode } from "./camera_requirements";
const mode = (fps: number, format: "full_frame" | "aps_c", width: boolean): RecordingMode => ({ resolution: "uhd_4k", nominal_fps: [fps], capture_format: format, full_width: width, internal: true, conditions: [], verified_model: "model", source_url: "https://manufacturer.example/mode", verified_at: 1 });
const evidence: CameraEvidence[] = [
  { names: ["Sony A7 V", "A7V"], capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", internal_4k: true, recording_modes: [mode(60, "full_frame", true), mode(120, "aps_c", false)] } },
  { names: ["Sony FX3", "FX3"], capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", internal_4k: true, recording_modes: [mode(60, "full_frame", true), mode(120, "full_frame", false)] } },
];
describe("recording mode claims use exact model and capture area", () => {
  it("blocks the actual misleading A7 V full-frame 4K120 recommendation", () => {
    expect(unsupportedCameraModeClaims("Sony A7 V: Records internally up to 4K 120p on a full-frame sensor. 3-day total is £110.", evidence)).toHaveLength(1);
  });
  it("permits cropped A7 V 4K120 and qualified full-frame 4K60", () => {
    expect(unsupportedCameraModeClaims("Sony A7 V records 4K120p in APS-C/Super 35 mode. It can do full-frame 4K60p using the required angle-of-view priority setting.", evidence)).toEqual([]);
  });
  it("distinguishes full-frame FX3 4K120 from an uncropped promise", () => {
    expect(unsupportedCameraModeClaims("Sony FX3 records full-frame 4K120p with a narrower angle of view.", evidence)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony FX3 records uncropped full-width 4K120p.", evidence)).toHaveLength(1);
  });
  it("does not let one model's mode evidence qualify another", () => {
    expect(unsupportedCameraModeClaims("Sony FX3 records full-frame 4K120p. Sony A7 V also records full-frame 4K120p.", evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("An unknown body records uncropped 4K120p.", evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony FX3 records full-frame 4K120p. Canon C70 also records full-frame 4K120p.", evidence)).toHaveLength(1);
    expect(unsupportedCameraModeClaims("Sony A7 V cannot record full-frame 4K120p, but Sony FX3 records full-frame 4K120p with a narrower angle of view.", evidence)).toEqual([]);
  });
  it("keeps roman-numeral model identities separate", () => {
    const identities = [
      { ...evidence[1], names: ["Sony A7 III"] },
      { ...evidence[0], names: ["Sony A7 II"], capabilities: { ...evidence[0].capabilities, recording_modes: [] } },
    ];
    expect(unsupportedCameraModeClaims("Sony A7 III records full-frame 4K120p.", identities)).toEqual([]);
    expect(unsupportedCameraModeClaims("Sony A7 II records full-frame 4K120p.", identities)).toHaveLength(1);
  });
  it("permits honest negative/uncertain mode statements", () => {
    for (const text of ["Sony A7 V cannot record uncropped full-frame 4K120p.", "I'll check whether that unknown body records 4K120p."]) {
      expect(unsupportedCameraModeClaims(text, evidence)).toEqual([]);
    }
  });
  it("blocks a positive promise after a conditional clause", () => {
    expect(unsupportedCameraModeClaims("If you need 4K120p, Sony A7 V records uncropped full-frame 4K120p.", evidence)).toHaveLength(1);
  });
  it("reaches the real guard as an unresolved critical review flag", () => {
    const result = guardDraft("Sony A7 V records uncropped full-frame 4K120p.", { history: [], lastRenterMessage: "I need uncropped 4K120p", cameraEvidence: evidence });
    expect(result.flags).toContainEqual(expect.objectContaining({ type: "CAMERA_MODE_HALLUCINATION", severity: "critical", action: "flagged" }));
  });
});
