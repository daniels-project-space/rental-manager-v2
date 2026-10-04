import {v} from "convex/values";
import {RECORDING_REQUIREMENT_RESOLUTIONS} from "./camera_requirements";
export const cameraRequirementsValidator=v.object({
 role:v.optional(v.union(v.literal("action"),v.literal("interchangeable_lens"))),
 sensor_format:v.optional(v.union(v.literal("full_frame"),v.literal("super35"),v.literal("aps_c"),v.literal("small_sensor"))),
 internal_4k:v.optional(v.boolean()),built_in_nd:v.optional(v.boolean()),
 recording:v.optional(v.object({
  resolution:v.union(...RECORDING_REQUIREMENT_RESOLUTIONS.map(r=>v.literal(r))),min_fps:v.optional(v.number()),
  capture_format:v.optional(v.union(v.literal("full_frame"),v.literal("super35"),v.literal("aps_c"),v.literal("small_sensor"))),
  full_width:v.optional(v.boolean()),internal:v.optional(v.boolean()),
 })),
});
