import { sameMount } from "./item_name_match";
import { verifiedItemSpec, type SpecRecord } from "./verified_item_spec";

export type CameraRole = "action" | "interchangeable_lens";
export type SensorFormat = "full_frame" | "super35" | "aps_c" | "small_sensor";
export type CameraCapabilities = { role: CameraRole; sensor_format: SensorFormat; native_mount?: string; internal_4k: boolean; built_in_nd?: boolean };
export type CameraRequirements = { role?: CameraRole; sensor_format?: SensorFormat; internal_4k?: boolean; built_in_nd?: boolean };
export type CameraSpec = SpecRecord & { camera_capabilities?: CameraCapabilities & { verified_model?: string; source_url?: string; verified_at?: number } };

export function verifiedCameraCapabilities(spec: CameraSpec | null | undefined, name: string): CameraCapabilities | null {
  const cap = spec?.camera_capabilities;
  if (!cap || !verifiedItemSpec(spec, name) || cap.verified_model !== spec!.verified_model || cap.source_url !== spec!.source_url || !Number.isFinite(cap.verified_at) || cap.verified_at! < spec!.verified_at! || cap.verified_at! <= 0) return null;
  return cap;
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
  return !nativeMount || sameMount(capabilities.native_mount, nativeMount);
}
