/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Item Taxonomy — typed ItemKind union + classifier helpers.
 *  Pure module: no Convex db handles, no side effects.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The `items.kind` column is a free-string in `convex/schema.ts:51` with ~21
 * documented values (see the trailing comment on that line). This module gives
 * those raw strings a typed shape used by the revenue attribution engine
 * (`convex/lib/revenue_attribution.ts`) to decide which items are
 * "included accessories" (battery / SD card / etc) and which are full-weight
 * standalone rentals.
 *
 * No DB migration: legacy strings stay as-is; `normalizeKind()` maps any raw
 * string onto the typed union, returning `"unknown"` for anything unmapped.
 *
 * Phase 1.5a extensions (audit_data_quality.md §5):
 *   - action_cam → distinct kind (drones / GoPro / Osmo). Standalone rental.
 *   - media_av → distinct kind (DJ / JBL / speakers). Standalone rental.
 *   - filter → mapped onto existing `nd_filter`.
 *   - adapter / mount → mapped onto existing `support` (PL mounts, suction cups).
 */

/** Closed set of typed item kinds for Phase 1 attribution. */
export const ITEM_KINDS = [
  "camera_body",
  "lens",
  "nd_filter",
  "support",
  "audio",
  "lighting",
  "power",
  "storage_card",
  "monitor",
  "transmitter",
  "media",
  "media_av",
  "action_cam",
  "accessory_consumable",
  "bundle",
  "marketing_only",
  "unknown",
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Kinds considered "included with a parent body/kit by default".
 *
 * Items whose canonical name appears in some other item's
 * `compatibility.included_with_rental` list AND whose kind falls in this set
 * receive £0 share when both that parent and the included item appear on the
 * same rental. Standalone rentals of these items (no parent body present)
 * still receive their normal weighted share.
 */
export const STANDARD_INCLUDED_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "power", // batteries
  "storage_card", // SD / CFexpress / etc.
  "accessory_consumable",
]);

/**
 * Kinds that are ALWAYS standalone (never inherit weight from a parent).
 * Even if listed in a parent's `included_with_rental` set, these keep their
 * full proportional share (e.g. lens kit-bundled with body still has value).
 */
export const STANDALONE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "lens",
  "nd_filter",
  "audio",
  "monitor",
  "transmitter",
  "support",
  "lighting",
  "media",
  "media_av",
  "action_cam",
]);

/**
 * Normalize a raw `items.kind` string onto the typed `ItemKind` union.
 *
 * Mapping derived from the schema comment at `convex/schema.ts:51` plus the
 * 15 raw kinds emitted by `seed-items-from-v1-master-inventory.mjs:inferMeta`:
 *   camera_body, lens, lighting, support, monitor, audio, power, media,
 *   accessory, effects, action_cam, av, filter, adapter, mount.
 *
 * Strategy: lowercase, strip whitespace and underscores for matching, then
 * map onto the typed kinds. Anything unrecognized → `"unknown"`.
 */
export function normalizeKind(raw: string | undefined): ItemKind {
  if (!raw) return "unknown";
  const k = raw.toLowerCase().trim();
  // Direct hits (typed kinds that match raw strings already)
  switch (k) {
    case "lens":
    case "lenses":
      return "lens";
    case "nd_filter":
    case "nd":
    case "ndfilter":
    case "filter":
    case "filters":
      return "nd_filter";
    case "audio":
    case "dj_audio":
    case "dj-audio":
    case "djaudio":
      return "audio";
    case "av":
    case "media_av":
    case "mediaav":
    case "av_media":
      return "media_av";
    case "lighting":
    case "lights":
    case "light":
      return "lighting";
    case "power":
    case "battery":
    case "batteries":
      return "power";
    case "storage_card":
    case "storage":
    case "card":
    case "sd_card":
    case "sdcard":
      return "storage_card";
    case "monitor":
    case "monitors":
      return "monitor";
    case "transmitter":
    case "transmission":
    case "transmitters":
      return "transmitter";
    case "media":
    case "smoke_fx":
    case "effects":
    case "video":
      return "media";
    case "accessory":
    case "accessory_consumable":
    case "consumable":
    case "accessories":
      return "accessory_consumable";
    case "bundle":
    case "kit":
    case "set":
    case "bundles":
      return "bundle";
    case "marketing_only":
    case "marketing":
      return "marketing_only";
    case "camera":
    case "camera_body":
    case "body":
      return "camera_body";
    case "drone":
    case "drones":
    case "action_cam":
    case "actioncam":
    case "action-cam":
      return "action_cam";
    case "support":
    case "grip":
    case "gimbal":
    case "gimbals":
    case "stabilizer":
    case "stabilisers":
    case "stabilizers":
    case "motion":
    case "tripod":
    case "rig":
    case "adapter":
    case "adapters":
    case "mount":
    case "mounts":
      return "support";
    case "unknown":
    case "":
      return "unknown";
    default:
      return "unknown";
  }
}
