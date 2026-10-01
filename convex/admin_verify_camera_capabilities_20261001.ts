import { internalMutation } from "./_generated/server";
import { verifiedItemSpec } from "./lib/verified_item_spec";
import type { CameraCapabilities } from "./lib/camera_requirements";

// Exact owned models already reviewed; these fields are manufacturer facts,
// not quantities, rental inclusions or permissions. Missing ND stays unknown.
const profiles: Array<{ name: string; model: string; capabilities: CameraCapabilities }> = [
  { name: "Sony A7 II", model: "ILCE-7M2", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: false } },
  { name: "Sony A7 III", model: "ILCE-7M3", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: true } },
  { name: "Sony A7 V", model: "ILCE-7M5", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: true } },
  { name: "Sony FX3", model: "ILME-FX3", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: true } },
  { name: "BMPCC 6K Pro", model: "Blackmagic Pocket Cinema Camera 6K Pro", capabilities: { role: "interchangeable_lens", sensor_format: "super35", native_mount: "EF", internal_4k: true, built_in_nd: true } },
  { name: "BMPCC 6K Full Frame", model: "Blackmagic Cinema Camera 6K", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "L", internal_4k: true } },
  { name: "GoPro 12 Hero", model: "HERO12 Black", capabilities: { role: "action", sensor_format: "small_sensor", internal_4k: true } },
  { name: "DJI Osmo Action Pro 5", model: "Osmo Action 5 Pro", capabilities: { role: "action", sensor_format: "small_sensor", internal_4k: true } },
];

export const run = internalMutation({ args: {}, handler: async ctx => {
  const changes = [];
  for (const profile of profiles) {
    const item = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", profile.name)).unique();
    if (!item || item.kind !== "camera") throw new Error(`Missing exact camera ${profile.name}`);
    const spec = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).unique();
    if (!spec || spec.verified_model !== profile.model || !verifiedItemSpec(spec, profile.name)) throw new Error(`Review provenance changed for ${profile.name}`);
    const capabilities = { ...profile.capabilities, verified_model: profile.model, source_url: spec.source_url, verified_at: Date.now() };
    await ctx.db.patch(spec._id, { camera_capabilities: capabilities });
    changes.push({ item: profile.name, model: profile.model, source_url: spec.source_url, previous: spec.camera_capabilities ?? null, capabilities });
  }
  return { changes };
} });
