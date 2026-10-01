import { v, type Infer } from "convex/values";

export const draftEvidenceValidator = v.object({
  model_id: v.string(),
  stage: v.string(),
  cost_usd: v.optional(v.number()),
  stock: v.array(v.object({
    item: v.string(), start_date: v.string(), end_date: v.string(),
    quantity: v.number(), available: v.union(v.boolean(), v.null()),
    free_units: v.union(v.number(), v.null()),
    checked_at: v.number(), call_id: v.string(),
  })),
});
export type DraftEvidence = Infer<typeof draftEvidenceValidator>;

/** Model self-reports are diagnostics, never independent proof. Empty call id
 * means attribution was not supplied; do not manufacture a receipt for it. */
export function normalizeClaimedFacts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const f = raw as Record<string, unknown>;
    if (typeof f.kind !== "string" || !f.kind.trim() || typeof f.value !== "string" || !f.value.trim()) return [];
    return [{ kind: f.kind, value: f.value,
      sourceTool: typeof f.sourceTool === "string" && f.sourceTool.trim() ? f.sourceTool : "unattributed",
      sourceCallId: typeof f.sourceCallId === "string" ? f.sourceCallId : "", verified: false }];
  });
}
