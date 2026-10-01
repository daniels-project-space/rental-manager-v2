import type { DraftEvidence } from "./renter_draft_evidence";

export type ReviewFlag = {
  type: string; detail: string; severity: "critical" | "high" | "medium" | "low";
  action: "stripped" | "rewritten" | "flagged";
};
export type DraftReview = {
  reason: string; flags: ReviewFlag[]; for_message_id: string; epoch: number;
  context_key: string; created_at: number; stage: string; evidence?: DraftEvidence;
};

/** Order facts, not polling timestamps. Reordered item arrays are equivalent. */
export function draftContextKey(booking: unknown, inquiryItems: unknown = [], labOrder: unknown = null) {
  const b = booking && typeof booking === "object" ? booking as Record<string, unknown> : {};
  const lab = labOrder && typeof labOrder === "object" ? labOrder as Record<string, unknown> : {};
  const items = lab.items ?? b.items ?? inquiryItems;
  return JSON.stringify({
    start: lab.start_date ?? b.start_date ?? null, end: lab.end_date ?? b.end_date ?? null, returned: b.return_date ?? null,
    status: b.status ?? null, booking_status: b.booking_status ?? null, step: b.order_step ?? null,
    pending: b.awaiting_owner_action ?? false, pickup: b.pickup_method ?? null,
    gross: b.gross_paid_gbp ?? null,
    items: (Array.isArray(items) ? items : []).map(item => {
      if (!item || typeof item !== "object") return String(item);
      const i = item as Record<string, unknown>;
      return JSON.stringify({ name: i.item_name ?? i.name ?? i.title ?? null, qty: i.qty ?? i.quantity ?? 1,
        product: i.product_id ?? i.productId ?? null, id: i.item_id ?? i.id ?? null,
        slug: i.slug ?? null, type: i.type ?? null });
    }).sort(),
  });
}

export function currentDraftReview(review: DraftReview | undefined | null, scope: {
  message_id: string | null | undefined; epoch: number; context_key: string;
}): DraftReview | null {
  return review && scope.message_id && review.for_message_id === scope.message_id
    && review.epoch === scope.epoch && review.context_key === scope.context_key ? review : null;
}

export function draftReviewSummary(review: Pick<DraftReview, "reason" | "flags">) {
  const labels: Record<string, string> = {
    KIT_HALLUCINATION: "Kit contents need verification", CAMERA_MODE_HALLUCINATION: "Camera recording mode needs verification",
    SPEC_HALLUCINATION: "Item specifications need verification", PRICE_HALLUCINATION: "Price needs verification",
    UNGROUNDED_UNAVAILABILITY: "Availability was not verified", AVAILABILITY_CONTRADICTION: "Stock or quantity conflicts with the reply",
  };
  const reasons = [...new Set(review.flags.map(f => labels[f.type] ?? "Reply needs verification"))];
  if (reasons.length) return reasons.join(". ") + ".";
  const why = review.reason.replace(/^needs_human:/, "");
  return why === "premature_confirmation" ? "The booking is not confirmed yet."
    : why === "unparseable_model_output" ? "The generated reply could not be read safely."
    : "The assistant needs your judgement before replying.";
}
