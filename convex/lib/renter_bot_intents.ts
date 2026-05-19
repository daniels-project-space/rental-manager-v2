/**
 * V1 intent contracts — 14 message intents the renter-bot classifies on.
 *
 * Pure TypeScript. No Convex runtime types. Imported from:
 *   - convex/lib/renter_bot_filters.ts (`OUT_OF_SCOPE_INTENTS` gate)
 *   - convex/renter_bot_drafts.ts      (validation on writeDraft)
 *   - src/mastra/agents/renter_bot.ts  (system prompt + Zod enum)
 *
 * READ-ONLY enforcement: `OUT_OF_SCOPE_INTENTS` are auto-escalated; the
 * agent must emit `needs_human=true` and write zero `draft_text` for these.
 */

export const RENTER_BOT_INTENTS = [
  "PRICING_INQUIRY",
  "AVAILABILITY_CHECK",
  "LOGISTICS",
  "EQUIPMENT_QUESTION",
  "BOOKING_ACTION",
  "GREETING",
  "NEGOTIATION",
  "ACKNOWLEDGMENT",
  "COMPLAINT",
  "CANCELLATION",
  "DAMAGE_REPORT",
  "RETURN_CONFIRMATION",
  "GOODBYE",
  "GENERAL",
] as const;

export type RenterBotIntent = (typeof RENTER_BOT_INTENTS)[number];

/** Decision A-12: bot refuses to draft these; pings "human needed" instead. */
export const OUT_OF_SCOPE_INTENTS: ReadonlySet<RenterBotIntent> = new Set([
  "COMPLAINT",
  "DAMAGE_REPORT",
  "CANCELLATION",
]);

export function isOutOfScopeIntent(intent: string): boolean {
  return OUT_OF_SCOPE_INTENTS.has(intent as RenterBotIntent);
}

export function isValidIntent(intent: string): intent is RenterBotIntent {
  return (RENTER_BOT_INTENTS as readonly string[]).includes(intent);
}

/** 7 conversation stages — gate which prompts/actions fire downstream. */
export const CONVERSATION_STAGES = [
  "INQUIRY",
  "INTERESTED",
  "READY_TO_BOOK",
  "BOOKED",
  "CONFIRMED",
  "COMPLETED",
  "DEAD",
] as const;

export type ConversationStage = (typeof CONVERSATION_STAGES)[number];

export function isValidStage(stage: string): stage is ConversationStage {
  return (CONVERSATION_STAGES as readonly string[]).includes(stage);
}

/**
 * Infer initial conversation_stage from reservation.status. Used by the
 * Phase 1 backfill to populate `conversations.conversation_stage` for
 * existing rows where the bot didn't classify the renter explicitly.
 */
export function stageFromReservationStatus(
  status: string | null | undefined,
  orderStep: string | null | undefined,
): ConversationStage {
  if (status === "cancelled") return "DEAD";
  if (status === "completed") return "COMPLETED";
  if (status === "confirmed") {
    if (orderStep === "DELIVERED" || orderStep === "BOOKED_AFTER_VERIFIED") return "CONFIRMED";
    return "BOOKED";
  }
  if (status === "pending_review") {
    if (orderStep === "FUNDS_RESERVED") return "READY_TO_BOOK";
    return "INTERESTED";
  }
  return "INQUIRY";
}
