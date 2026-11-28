import { normalizeMount } from "./item_name_match";
import { reviewedCameraNativeMount } from "./reviewed_camera_specs";
import { reviewedLensMount } from "./reviewed_lens_mounts";

/** Resolve exact reviewed mount data; a conflict with the inventory row stays unknown. */
export function resolveInventoryMount(item: { name_canonical: string; kind?: string; lens_mount?: string | null }) {
  const recorded = item.lens_mount?.trim() || null;
  const reviewed = ["camera", "camera_body"].includes(item.kind ?? "")
    ? reviewedCameraNativeMount(item.name_canonical)
    : item.kind === "lens" ? reviewedLensMount(item.name_canonical) : null;
  if (recorded && reviewed && normalizeMount(recorded) !== normalizeMount(reviewed.mount))
    return { mount: null, evidence: {
      status: "conflict" as const,
      recorded_mount: recorded,
      reviewed_mount: reviewed.mount,
      model: reviewed.model,
      source_url: reviewed.source_url,
      ...( "identity_source" in reviewed ? { identity_source: reviewed.identity_source } : {}),
    } };
  if (reviewed)
    return { mount: reviewed.mount, evidence: {
      status: "manufacturer_reviewed" as const,
      mount: reviewed.mount,
      model: reviewed.model,
      source_url: reviewed.source_url,
      ...( "identity_source" in reviewed ? { identity_source: reviewed.identity_source } : {}),
    } };
  if (recorded)
    return { mount: recorded, evidence: { status: "inventory_record" as const, mount: recorded } };
  return { mount: null, evidence: { status: "unknown" as const } };
}
