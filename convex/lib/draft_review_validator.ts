import { v } from "convex/values";
import { draftEvidenceValidator } from "./renter_draft_evidence";
export const reviewFlagValidator = v.object({
  type: v.string(), detail: v.string(),
  severity: v.union(v.literal("critical"), v.literal("high"), v.literal("medium"), v.literal("low")),
  action: v.union(v.literal("stripped"), v.literal("rewritten"), v.literal("flagged")),
});
export const draftReviewValidator = v.object({
  reason: v.string(), flags: v.array(reviewFlagValidator), for_message_id: v.string(), epoch: v.number(),
  context_key: v.string(), created_at: v.number(), stage: v.string(), evidence: v.optional(draftEvidenceValidator),
});
