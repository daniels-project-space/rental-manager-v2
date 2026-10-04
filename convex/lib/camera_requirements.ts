import { sameMount } from "./item_name_match";
import { verifiedItemSpec, type SpecRecord } from "./verified_item_spec";

export type CameraRole = "action" | "interchangeable_lens";
export type SensorFormat = "full_frame" | "super35" | "aps_c" | "small_sensor";
// A requirement can ask for the 4K family. Recorded evidence always names
// a concrete mode; an unspecified family must never attest UHD or DCI.
export const RECORDING_MODE_RESOLUTIONS = ["uhd_4k", "dci_4k"] as const;
export const RECORDING_REQUIREMENT_RESOLUTIONS = ["4k", ...RECORDING_MODE_RESOLUTIONS] as const;
export type RecordingResolution = typeof RECORDING_MODE_RESOLUTIONS[number];
export type RecordingRequirementResolution = typeof RECORDING_REQUIREMENT_RESOLUTIONS[number];
export function canonicalRecordingResolution(value: RecordingRequirementResolution | "4K"): RecordingRequirementResolution {
  return value === "4K" ? "4k" : value;
}
export type RecordingMode = {
  resolution: RecordingResolution;
  nominal_fps: number[];
  capture_format: SensorFormat;
  full_width: boolean;
  internal: boolean;
  conditions: string[];
  verified_model: string;
  source_url: string;
  verified_at: number;
};
export type RecordingRequirement = { resolution: RecordingRequirementResolution; min_fps?: number; capture_format?: SensorFormat; full_width?: boolean; internal?: boolean };
export type CameraCapabilities = { role: CameraRole; sensor_format: SensorFormat; native_mount?: string; internal_4k: boolean; built_in_nd?: boolean; recording_modes?: RecordingMode[] };
export type CameraRequirements = { role?: CameraRole; sensor_format?: SensorFormat; internal_4k?: boolean; built_in_nd?: boolean; recording?: RecordingRequirement };
export type CameraSpec = SpecRecord & { camera_capabilities?: CameraCapabilities & { verified_model?: string; source_url?: string; verified_at?: number } };

export function verifiedCameraCapabilities(spec: CameraSpec | null | undefined, name: string): CameraCapabilities | null {
  const cap = spec?.camera_capabilities;
  if (!cap || !verifiedItemSpec(spec, name) || cap.verified_model !== spec!.verified_model || cap.source_url !== spec!.source_url || !Number.isFinite(cap.verified_at) || cap.verified_at! < spec!.verified_at! || cap.verified_at! <= 0) return null;
  // Mode provenance is independent: a sensor profile does not qualify a
  // recording mode, and an older mode review cannot survive a new model review.
  return { ...cap, recording_modes: cap.recording_modes?.filter(m =>
    m.verified_model === spec!.verified_model && /^https:\/\//.test(m.source_url) &&
    Number.isFinite(m.verified_at) && m.verified_at >= spec!.verified_at! &&
    m.nominal_fps.length > 0 && m.nominal_fps.every(f => Number.isFinite(f) && f > 0)) };
}

export function matchesRecordingRequirement(mode: RecordingMode, requirement: RecordingRequirement) {
  const resolutionMatches=requirement.resolution==="4k" ? RECORDING_MODE_RESOLUTIONS.some(r=>r===mode.resolution) : mode.resolution===requirement.resolution;
  return resolutionMatches && (requirement.min_fps===undefined || Number.isFinite(requirement.min_fps) && requirement.min_fps > 0 &&
    mode.nominal_fps.some(f => f >= requirement.min_fps!)) &&
    (requirement.capture_format === undefined || mode.capture_format === requirement.capture_format) &&
    (requirement.full_width === undefined || mode.full_width === requirement.full_width) &&
    (requirement.internal === undefined || mode.internal === requirement.internal);
}

/** Infer the requested equipment ROLE, never technical specs or ownership.
 * Model-family words only disambiguate camera versus action-camera intent. */
export function requestedCameraRole(name: string | null | undefined, kind?: string | null): CameraRole | null {
  if (!/^camera(?:_body)?$/i.test(kind ?? "")) return null;
  if (/\b(?:gopro|osmo\s+action|action\s+camera|insta360)\b/i.test(name ?? "")) return "action";
  if (kind === "camera_body" || /\b(?:blackmagic|bmpcc|pyxis|komodo|red|arri|fx[369]|a7|interchangeable|cinema)\b/i.test(name ?? "")) return "interchangeable_lens";
  return null;
}

/** Unknown does not satisfy a hard requirement. Stock is checked separately. */
export function meetsCameraRequirements(capabilities: CameraCapabilities | null, requirements: CameraRequirements, nativeMount?: string) {
  if (!Object.keys(requirements).length && !nativeMount) return true;
  if (!capabilities) return false;
  for (const key of ["role", "sensor_format", "internal_4k", "built_in_nd"] as const) {
    if (requirements[key] !== undefined && capabilities[key] !== requirements[key]) return false;
  }
  if (requirements.recording && !capabilities.recording_modes?.some(m => matchesRecordingRequirement(m, requirements.recording!))) return false;
  return !nativeMount || sameMount(capabilities.native_mount, nativeMount);
}
