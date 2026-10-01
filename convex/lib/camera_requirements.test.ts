import { describe, expect, it } from "vitest";
import { meetsCameraRequirements, requestedCameraRole, verifiedCameraCapabilities, type CameraCapabilities } from "./camera_requirements";
const full: CameraCapabilities = { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "L", internal_4k: true };
const action: CameraCapabilities = { role: "action", sensor_format: "small_sensor", internal_4k: true };
describe("hard camera requirements before stock ranking", () => {
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
