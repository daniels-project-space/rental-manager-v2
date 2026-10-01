/** A generated/imported description is not independently verified product data. */
export type SpecRecord = { item_name_canonical: string; description: string; specs_long?: string; source: string; source_url?: string; verified_at?: number; verified_model?: string };
export function verifiedItemSpec(spec: SpecRecord | null | undefined, itemName: string): { text: string; source_url: string | null; model: string } | null {
  if (!spec || spec.item_name_canonical !== itemName || !spec.verified_model?.trim() || !Number.isFinite(spec.verified_at) || spec.verified_at! <= 0) return null;
  if (spec.source !== "manufacturer-verified" && spec.source !== "owner-verified") return null;
  if (spec.source === "manufacturer-verified") {
    try { if (new URL(spec.source_url ?? "").protocol !== "https:") return null; } catch { return null; }
  }
  const text = `${spec.description} ${spec.specs_long ?? ""}`.replace(/\s+/g, " ").trim();
  return text ? { text, source_url: spec.source_url ?? null, model: spec.verified_model } : null;
}
