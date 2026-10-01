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
