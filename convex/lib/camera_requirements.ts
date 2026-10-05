import {cameraIdentityReviewedAt} from "./camera_identity_review";
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
  capture_format?: SensorFormat;
  full_width: boolean;
  internal: boolean;
  conditions: string[];
  verified_model: string;
  source_url: string;
  verified_at: number;
};
export type RecordingRequirement = { resolution: RecordingRequirementResolution; min_fps?: number; capture_format?: SensorFormat; full_width?: boolean; internal?: boolean };
export type CameraCapabilities = { role: CameraRole; sensor_format: SensorFormat; native_mount?: string; internal_4k: boolean; built_in_nd?: boolean; built_in_nd_review?:{verified_model:string;source_url:string;verified_at:number}; recording_modes?: RecordingMode[] };
export type CameraRequirements = { role?: CameraRole; sensor_format?: SensorFormat; internal_4k?: boolean; built_in_nd?: boolean; recording?: RecordingRequirement };
export type CameraSpec = SpecRecord & { camera_capabilities?: CameraCapabilities & { identity_review?:{verified_model:string;verified_at:number}; verified_model?: string; source_url?: string; verified_at?: number } };

/** Source-qualified mode reviews, including any conflict with a later profile.
 * Review UI retains these references; public capability evidence filters conflicts. */
export function cameraRecordingReviews(spec:CameraSpec) {
 const identityAt=cameraIdentityReviewedAt(spec);
 return spec.camera_capabilities?.recording_modes?.filter(m=>m.verified_model===spec.verified_model&&/^https:\/\//.test(m.source_url)&&
  Number.isFinite(m.verified_at)&&m.verified_at>=identityAt&&m.nominal_fps.length>0&&m.nominal_fps.every(f=>Number.isFinite(f)&&f>0))??[];
}

export function verifiedCameraCapabilities(spec: CameraSpec | null | undefined, name: string): CameraCapabilities | null {
  const cap = spec?.camera_capabilities;
  if (!cap || !verifiedItemSpec(spec, name) || cap.verified_model !== spec!.verified_model || cap.source_url !== spec!.source_url || !Number.isFinite(cap.verified_at) || cap.verified_at! < spec!.verified_at! || cap.verified_at! <= 0) return null;
  // Mode provenance is independent: a sensor profile does not qualify a
  // recording mode, and an older mode review cannot survive a new model review.
  const identityAt=cameraIdentityReviewedAt(spec!);
  const nd=cap.built_in_nd_review;
  const ndValid=!nd || nd.verified_model===spec!.verified_model && /^https:\/\//.test(nd.source_url) && Number.isFinite(nd.verified_at) && nd.verified_at>=identityAt;
  const visible={...cap};delete visible.identity_review;
  return { ...visible, built_in_nd:ndValid?cap.built_in_nd:undefined, recording_modes: cameraRecordingReviews(spec!).filter(m=>!m.internal||cap.internal_4k) };
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

export function hasCameraRequirements(requirements:CameraRequirements,nativeMount?:string|null) {
  return !!nativeMount?.trim() || Object.values(requirements).some(value=>value!==undefined);
}
/** Positive mode reviews are not an exhaustive negative specification. A
 * missing mode therefore needs review; known body/mount mismatches exclude it. */
export function assessCameraRequirements(capabilities:CameraCapabilities|null,requirements:CameraRequirements,nativeMount?:string|null) {
  const unknown:string[]=[],mismatched:string[]=[];
  for(const key of ["role","sensor_format","internal_4k","built_in_nd"] as const) {
    if(requirements[key]===undefined)continue;
    if(capabilities?.[key]===undefined)unknown.push(key);
    else if(capabilities[key]!==requirements[key])mismatched.push(key);
  }
  if(nativeMount) {
    if(!capabilities?.native_mount)unknown.push("native_mount");
    else if(!sameMount(capabilities.native_mount,nativeMount))mismatched.push("native_mount");
  }
  const recording=requirements.recording;
  if(recording) {
    if(recording.internal===true && (capabilities?.internal_4k===false||requirements.internal_4k===false))mismatched.push("internal_4k");
    // Recording capture describes the area actually read from the sensor.
    // Missing positive mode rows remain unknown, but cannot make a smaller
    // reviewed physical sensor a possible full-frame capture candidate. Keep
    // APS-C/Super35 together: their exact dimensions vary by model, so this
    // comparison only establishes unequivocal sensor-class impossibilities.
    const sensorClass:Record<SensorFormat,number>={small_sensor:1,aps_c:2,super35:2,full_frame:3};
    if(recording.capture_format && capabilities?.sensor_format &&
      sensorClass[recording.capture_format]>sensorClass[capabilities.sensor_format])mismatched.push("capture_format");
    if(!RECORDING_REQUIREMENT_RESOLUTIONS.includes(recording.resolution) || recording.min_fps!==undefined&&(!Number.isFinite(recording.min_fps)||recording.min_fps<=0))mismatched.push("recording");
    else {
      // Reviewed internal 4K is positive proof of the generic 4K family,
      // regardless of which requirement representation the caller uses.
      // It establishes no exact format, frame rate, crop or capture area,
      // and cannot establish external-only recording.
      const broadInternal4K=capabilities?.internal_4k===true && recording.resolution==="4k"
        && recording.min_fps===undefined && recording.capture_format===undefined
        && recording.full_width===undefined && recording.internal!==false;
      if(!broadInternal4K && !capabilities?.recording_modes?.some(mode=>matchesRecordingRequirement(mode,recording)))unknown.push("recording");
    }
  }
  return {status:mismatched.length?"mismatch" as const:unknown.length?"unknown" as const:"match" as const,unknown,mismatched};
}
/** Unknown does not satisfy a hard requirement. Stock is checked separately. */
export function meetsCameraRequirements(capabilities: CameraCapabilities | null, requirements: CameraRequirements, nativeMount?: string) {
  return assessCameraRequirements(capabilities,requirements,nativeMount).status==="match";
}
