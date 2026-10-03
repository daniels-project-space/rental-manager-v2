import type { DraftEvidence } from "./renter_draft_evidence";
import { rentalStage } from "./rental_stage";
import { londonToday } from "./effectiveDates";

export type ReviewFlag = {
  type: string; detail: string; severity: "critical" | "high" | "medium" | "low";
  action: "stripped" | "rewritten" | "flagged";
};
export type DraftReview = {
  reason: string; flags: ReviewFlag[]; for_message_id: string; epoch: number;
  context_key: string; created_at: number; stage: string; evidence?: DraftEvidence;
};

export type DraftContextTransition = {
  source: "native_lab_amendment"; thread_id: string;
  before_context_key: string; after_context_key: string;
  before_revision: number; after_revision: number;
};

/** Follow only the native writes made in this generation, never a fresh key alone. */
export function amendedDraftContext(initial: string, threadId: string, transitions: DraftContextTransition[]): string | null {
  if (!threadId.startsWith("__probe__") || !Array.isArray(transitions) || !transitions.length
    || transitions.some(t => !t || typeof t !== "object")) return null;
  const ordered = [...transitions].sort((a, b) => a.before_revision - b.before_revision);
  let key = initial;
  let revision: number | undefined;
  for (const t of ordered) {
    if (t.source !== "native_lab_amendment" || t.thread_id !== threadId
      || typeof t.before_context_key !== "string" || typeof t.after_context_key !== "string"
      || !Number.isInteger(t.before_revision) || t.before_revision < 0
      || t.after_revision !== t.before_revision + 1
      || (revision !== undefined && t.before_revision !== revision)
      || t.before_context_key !== key) return null;
    key = t.after_context_key;
    revision = t.after_revision;
  }
  return key;
}

/** Order facts, not polling timestamps. Reordered item arrays are equivalent. */
export function draftContextKey(booking: unknown, inquiryItems: unknown = [], labOrder: unknown = null, today = londonToday()) {
  const b = booking && typeof booking === "object" ? booking as Record<string, unknown> : {};
  const lab = labOrder && typeof labOrder === "object" ? labOrder as Record<string, unknown> : {};
  const items = lab.items ?? b.items ?? inquiryItems;
  return JSON.stringify({
    stage: rentalStage(booking ? {...b, start_date: lab.start_date ?? b.start_date,
      end_date: lab.end_date ?? b.end_date} as Parameters<typeof rentalStage>[0] : null, today).stage,
    obsolete: b.is_obsolete ?? false, collection: b.pickup_date ?? null,
    start: lab.start_date ?? b.start_date ?? null, end: lab.end_date ?? b.end_date ?? null, returned: b.return_date ?? null,
    status: b.status ?? null, booking_status: b.booking_status ?? null, step: b.order_step ?? null,
    pending: b.awaiting_owner_action ?? false, pickup: b.pickup_method ?? null,
    gross: b.gross_paid_gbp ?? null,
    lab_prices: Array.isArray(lab.items) ? lab.items.map(item => {
      const i = item as Record<string, unknown>;
      return JSON.stringify({ name: i.name ?? null, id: i.item_id ?? null,
        daily: i.daily_price_gbp ?? null, tiers: i.price_tiers ?? null });
    }).sort() : null,
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
    MINIMUM_POLICY_DISCLOSURE: "Internal commercial policy was disclosed",
    KIT_HALLUCINATION: "Kit contents need verification", CAMERA_FEATURE_HALLUCINATION: "Camera feature was not verified", CAMERA_MODE_HALLUCINATION: "Camera recording mode needs verification",
    SPEC_HALLUCINATION: "Item specifications need verification", PRICE_HALLUCINATION: "Price needs verification",
    UNGROUNDED_UNAVAILABILITY: "Availability was not verified", UNGROUNDED_CATALOGUE_READINESS: "Catalogue readiness was not verified", INVALID_MODEL_OUTPUT: "The model response needs review", AVAILABILITY_CONTRADICTION: "Stock or quantity conflicts with the reply",
  };
  const reasons = [...new Set(review.flags.map(f => labels[f.type] ?? "Reply needs verification"))];
  if (reasons.length) return reasons.join(". ") + ".";
  const why = review.reason.replace(/^needs_human:/, "");
  return why === "premature_confirmation" ? "The booking is not confirmed yet."
    : why === "unparseable_model_output" ? "The generated reply could not be read safely."
    : "The assistant needs your judgement before replying.";
}

/** The accepted preview the owner copied, not a fresh token at send time. */
export type DraftApproval = {
  message_id: string;
  context_key: string;
  epoch: number;
  generated_at: number;
};
export function sameDraftApproval(a: DraftApproval | null | undefined, b: DraftApproval | null | undefined) {
  return !!a && !!b && a.message_id === b.message_id && a.context_key === b.context_key &&
    a.epoch === b.epoch && a.generated_at === b.generated_at;
}
export function currentDraftApproval(
  source: {
    ai_draft_text?: string;
    ai_draft_for_message_id?: string;
    ai_draft_context_key?: string;
    ai_draft_epoch?: number;
    ai_draft_generated_at?: number;
    ai_draft_review?: DraftReview;
  } | null | undefined,
  scope: { message_id: string | null | undefined; context_key: string; epoch: number },
): DraftApproval | null {
  if (!source?.ai_draft_text?.trim() || !scope.message_id ||
    source.ai_draft_for_message_id !== scope.message_id || source.ai_draft_context_key !== scope.context_key ||
    (source.ai_draft_epoch ?? 0) !== scope.epoch || typeof source.ai_draft_generated_at !== "number" ||
    !Number.isFinite(source.ai_draft_generated_at) || source.ai_draft_generated_at <= 0 ||
    currentDraftReview(source.ai_draft_review, scope)) return null;
  return { message_id: scope.message_id, context_key: scope.context_key, epoch: scope.epoch,
    generated_at: source.ai_draft_generated_at };
}
