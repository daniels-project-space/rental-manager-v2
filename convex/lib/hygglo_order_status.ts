export type ReservationImportStatus = "confirmed" | "pending_review" | "completed" | "cancelled";
export type HyggloObsoleteReason = "owner_denied" | "renter_cancelled" | "verification_failed" | "other";
const TERMINAL_ORDER_STEPS = new Set(["CANCELED", "VERIFICATION_FAILED", "REVIEWED"]);

export function shouldRetainTerminalOrderStep(
  storedStep: string | null | undefined,
  incomingStep: string | null | undefined,
): boolean {
  return TERMINAL_ORDER_STEPS.has(storedStep ?? "") &&
    incomingStep != null && !TERMINAL_ORDER_STEPS.has(incomingStep);
}

/** Derive reservation state from a provider step, with terminal steps taking
 * precedence over filter buckets that can contain stale/misfiled rows. */
export function deriveStatusFromStep(
  step: string | null | undefined,
  sourceFilter: string | null | undefined,
): ReservationImportStatus {
  if (step === "CANCELED" || step === "VERIFICATION_FAILED") return "cancelled";
  if (sourceFilter === "obsolete") return "cancelled";
  if (step === "REVIEWED") return "completed";
  if (sourceFilter === "pending") return "pending_review";
  if (sourceFilter === "current") return "confirmed";
  if (sourceFilter === "future") return "confirmed";

  switch (step) {
    case "REQUEST":
    case "APPROVED":
    case "FUNDS_RESERVED":
      return "pending_review";
    case "VERIFIED":
    case "BOOKED_AFTER_VERIFIED":
    case "DELIVERED":
    case "RETURNED":
      return "confirmed";
    default:
      return "pending_review";
  }
}

/** Persist the first observed terminal event so monthly verification-loss
 * reporting has an event date and a durable reason, even if the provider
 * returned the failed order in its `pending` bucket. */
export function obsoleteReasonForOrder(
  step: string | null | undefined,
  sourceFilter: string | null | undefined,
): HyggloObsoleteReason | null {
  if (step === "VERIFICATION_FAILED") return "verification_failed";
  if (step === "CANCELED") return "renter_cancelled";
  if (sourceFilter !== "obsolete") return null;
  if (step === "REQUEST") return "owner_denied";
  if (step === "VERIFIED" || step === "FUNDS_RESERVED") return "verification_failed";
  return "other";
}
