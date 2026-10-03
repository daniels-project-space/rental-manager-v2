import type { LensCapabilities } from "./lens_requirements";

export type ItemTechnicalEvidence = {
  spec_text?: string | null;
  spec_verification?: { model: string; source_url: string | null } | null;
  lens_capabilities?: LensCapabilities | null;
};

/** Preserve the same reviewed evidence in requested-item and recommendation
 * prompts. Names, mount, advertising and old messages are lookup context,
 * not a substitute for a missing technical property. */
export function itemTechnicalContext(item: ItemTechnicalEvidence): string {
  const spec = item.spec_verification;
  const lens = item.lens_capabilities;
  const sections = [
    spec && item.spec_text
      ? `Reviewed model ${spec.model}; source ${spec.source_url ?? "owner"}; specifications: ${item.spec_text}`
      : "Technical specifications are not reviewed for this exact item.",
  ];
  if (lens) {
    sections.push(`Reviewed lens capabilities: ${JSON.stringify(lens)}. Omitted properties are unknown.`);
  }
  sections.push("Use this evidence for technical claims. A listing name, brand, mount or prior reply does not establish an unrecorded property.");
  return sections.join(" ");
}
