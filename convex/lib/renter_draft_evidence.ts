import { v, type Infer } from "convex/values";
import { recommendationRequirementValidator } from "./recommendation_qualification";
import { bookingRecordValidator } from "./booking_record";

/** Selected Native quotes retain physical identity and the criteria checked for them.
 * At approval, current catalogue reviews must satisfy these criteria again. */
export const recommendationQuoteEvidenceValidator=v.object({
  quote_key:v.string(),requirements:v.array(recommendationRequirementValidator),
  items:v.array(v.object({item_id:v.string(),name:v.string(),quantity:v.number()})),
});
export type RecommendationQuoteEvidence=Infer<typeof recommendationQuoteEvidenceValidator>;

export const stockQuoteEvidenceValidator=v.object({
  quote_key:v.string(),start_date:v.string(),end_date:v.string(),
  new_inquiry:v.optional(v.literal(true)),
  referral_code:v.optional(v.string()),offer_text:v.optional(v.string()),
  // Optional for schema compatibility; old drafts are invalidated on release.
  listing_quote:v.optional(v.object({total_gbp:v.number(),lines:v.array(v.object({product_id:v.number(),name:v.string(),quantity:v.number(),total_gbp:v.number()}))})),
  items:v.array(v.object({item_id:v.string(),name:v.string(),quantity:v.number()})),
});
export type StockQuoteEvidence=Infer<typeof stockQuoteEvidenceValidator>;

export const draftEvidenceValidator = v.object({
  booking_record:v.optional(bookingRecordValidator),
  stock_quotes:v.optional(v.array(stockQuoteEvidenceValidator)),
  model_id: v.string(),
  recommendation_quotes:v.optional(v.array(recommendationQuoteEvidenceValidator)),
  stage: v.string(),
  cost_usd: v.optional(v.number()),
  camera_comparisons: v.optional(v.array(v.object({
    models: v.array(v.string()), relation: v.literal("same_sensor"), source_url: v.string(), verified_at: v.number(),
  }))),
  /** Catalogue exclusion snapshot; not a dated stock-check receipt. */
  rental_eligibility: v.optional(v.object({
    ineligible_items: v.array(v.string()), source: v.literal("native_catalogue"),
  })),
  commercial: v.optional(v.object({stage:v.string(),threshold_gbp:v.number(),total_gbp:v.union(v.number(),v.null()),
    status:v.union(v.literal("below"),v.literal("meets"),v.literal("unknown"),v.literal("not_applicable"),v.literal("disabled")),
    basis:v.union(v.literal("current_booking"),v.literal("complete_requested_quote"),v.literal("lowest_selected_inquiry_quote"),v.literal("none")),
  })),
  prices: v.optional(v.array(v.object({
    names:v.array(v.string()),kind:v.union(v.literal("rental"),v.literal("basket"),v.literal("replacement")),
    quote_role:v.optional(v.union(v.literal("base"),v.literal("proposed_line"),v.literal("addition"),v.literal("inquiry"))),
    daily_rate_gbp:v.optional(v.number()),base_rate_gbp:v.optional(v.number()),total_gbp:v.optional(v.number()),
    days:v.optional(v.number()),quantity:v.optional(v.number()),start_date:v.optional(v.string()),end_date:v.optional(v.string()),
    items:v.optional(v.array(v.object({name:v.string(),quantity:v.number()}))),
    proposal:v.optional(v.object({base_physical_identity_key:v.optional(v.string()),base_total_gbp:v.optional(v.number()),removed_listings:v.optional(v.array(v.object({product_id:v.number(),quantity:v.number()}))),removed_items:v.optional(v.array(v.object({name:v.string(),quantity:v.number()}))),base_items:v.array(v.object({name:v.string(),quantity:v.number()})),added_items:v.array(v.object({name:v.string(),quantity:v.number()})),added_listings:v.optional(v.array(v.object({product_id:v.number(),quantity:v.number()}))),additional_cost_gbp:v.optional(v.number()),physical_identity_key:v.optional(v.string())})),
    date_proposal:v.optional(v.object({before_context_key:v.string(),from_start_date:v.string(),from_end_date:v.string(),base_total_gbp:v.number(),physical_identity_key:v.optional(v.string())})),
    required_accessory_names:v.optional(v.array(v.string())),
    call_id:v.string(),source:v.string(),
  }))),
  /** Native request identity used by the guard, retained for send-time stock checks. */
  stock_request: v.optional(v.object({
    start_date: v.optional(v.union(v.string(),v.null())), end_date: v.optional(v.union(v.string(),v.null())),
    items: v.array(v.object({name:v.string(),quantity:v.number(),aliases:v.optional(v.array(v.string())),complete:v.optional(v.boolean()),
      components:v.optional(v.array(v.object({name:v.string(),quantity:v.number()}))),
    })),
  })),
  stock: v.array(v.object({
    item: v.string(), start_date: v.string(), end_date: v.string(),
    quantity: v.number(), available: v.union(v.boolean(), v.null()),
    free_units: v.union(v.number(), v.null()),
    checked_at: v.number(), call_id: v.string(),
    kind: v.optional(v.string()),
    new_inquiry:v.optional(v.literal(true)),
    identity_names:v.optional(v.array(v.string())),
    owned:v.optional(v.boolean()),
    basket:v.optional(v.object({available:v.union(v.boolean(),v.null()),items:v.array(v.object({name:v.string(),quantity:v.number()}))})),
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
