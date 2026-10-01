import { describe, expect, it } from "vitest";
import { meetsCameraRequirements, requestedCameraRole, verifiedCameraCapabilities, type CameraCapabilities, type RecordingMode } from "./camera_requirements";
const full: CameraCapabilities = { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "L", internal_4k: true };
const action: CameraCapabilities = { role: "action", sensor_format: "small_sensor", internal_4k: true };
describe("hard camera requirements before stock ranking", () => {
  const mode = (fps: number, format: "full_frame" | "aps_c", width: boolean): RecordingMode => ({ resolution: "uhd_4k", nominal_fps: [fps], capture_format: format, full_width: width, internal: true, conditions: [], verified_model: "model", source_url: "https://manufacturer.example/modes", verified_at: 1 });
  it("distinguishes full-frame sensors from capture area and uncropped modes", () => {
    const a7v = { ...full, recording_modes: [mode(60, "full_frame", true), mode(120, "aps_c", false)] };
    const fx3 = { ...full, recording_modes: [mode(60, "full_frame", true), mode(120, "full_frame", false)] };
    const requirement = { recording: { resolution: "uhd_4k" as const, min_fps: 120, capture_format: "full_frame" as const, internal: true } };
    expect(meetsCameraRequirements(a7v, requirement)).toBe(false);
    expect(meetsCameraRequirements(fx3, requirement)).toBe(true);
    expect(meetsCameraRequirements(fx3, { recording: { ...requirement.recording, full_width: true } })).toBe(false);
    expect(meetsCameraRequirements(a7v, { recording: { ...requirement.recording, min_fps: 60, full_width: true } })).toBe(true);
    expect(meetsCameraRequirements(full, requirement)).toBe(false);
  });
  it("rejects stale or wrong-model mode proof independently of a valid body profile", () => {
    const spec = { item_name_canonical: "Body", description: "Reviewed", source: "manufacturer-verified", source_url: "https://manufacturer.example/body", verified_model: "model", verified_at: 2,
      camera_capabilities: { ...full, verified_model: "model", verified_at: 2, source_url: "https://manufacturer.example/body", recording_modes: [mode(120, "aps_c", false), { ...mode(60, "full_frame", true), verified_at: 2 }, { ...mode(120, "full_frame", true), verified_at: 2, verified_model: "other-model" }] } };
    expect(verifiedCameraCapabilities(spec, "Body")?.recording_modes).toHaveLength(1);
    expect(verifiedCameraCapabilities(spec, "Body")?.recording_modes?.[0].nominal_fps).toEqual([60]);
  });
  it("does not substitute action cameras for the actual two-body Pyxis request", () => {
    const role = requestedCameraRole("Blackmagic Pyxis", "camera");
    expect(role).toBe("interchangeable_lens");
    expect(meetsCameraRequirements(action, { role: role! })).toBe(false);
    expect(meetsCameraRequirements(full, { role: role! })).toBe(true);
  });
  it("preserves action-camera and generic-camera intent", () => {
    expect(requestedCameraRole("GoPro HERO12", "camera")).toBe("action");
    expect(requestedCameraRole("DJI Osmo Action 5 Pro", "camera")).toBe("action");
    expect(requestedCameraRole("RED Komodo", "camera_body")).toBe("interchangeable_lens");
    expect(requestedCameraRole("A camera", "camera")).toBe(null);
    expect(requestedCameraRole("Sony a7 lens", "lens")).toBe(null);
  });
  it("combines sensor, native mount and internal recording requirements", () => {
    expect(meetsCameraRequirements(full, { sensor_format: "full_frame", internal_4k: true }, "Leica L-mount")).toBe(true);
    expect(meetsCameraRequirements({ ...full, internal_4k: false }, { internal_4k: true })).toBe(false);
    expect(meetsCameraRequirements({ ...full, sensor_format: "super35", native_mount: "EF" }, { sensor_format: "full_frame" }, "L")).toBe(false);
    expect(meetsCameraRequirements(full, { built_in_nd: true })).toBe(false);
  });
  it("does not claim unknown or unverified capabilities meet a requirement", () => {
    expect(meetsCameraRequirements(null, { role: "interchangeable_lens" })).toBe(false);
    expect(meetsCameraRequirements(null, {})).toBe(true);
    const spec = { item_name_canonical: "Actual body", description: "Full frame", source: "v1-handwritten", verified_at: 1, verified_model: "model", camera_capabilities: full };
    expect(verifiedCameraCapabilities(spec, "Actual body")).toBe(null);
    const reviewed = { ...spec, source: "manufacturer-verified", source_url: "https://manufacturer.example/model", camera_capabilities: { ...full, verified_model: "model", verified_at: 1, source_url: "https://manufacturer.example/model" } };
    expect(verifiedCameraCapabilities(reviewed, "Actual body")).toMatchObject(full);
    expect(verifiedCameraCapabilities({ ...reviewed, verified_model: "new-model" }, "Actual body")).toBe(null);
    expect(verifiedCameraCapabilities({ ...reviewed, verified_at: 2 }, "Actual body")).toBe(null);
    expect(verifiedCameraCapabilities({ ...reviewed, camera_capabilities: full }, "Actual body")).toBe(null);
    expect(verifiedCameraCapabilities({ ...spec, source: "owner-verified" }, "Another body")).toBe(null);
  });
});
