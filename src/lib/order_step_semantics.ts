/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Hygglo order_step semantics — single source of truth (FRONTEND).
 *  Mirror: convex/order_step_semantics.ts (keep in sync).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Hygglo's API returns a steps[] funnel per order, each step having both:
 *   { key, active: boolean, completed: boolean, failure?: boolean }
 *
 * `active=true` is the **NEXT-TO-DO** step (the renter's current required
 * action) — NOT the step the renter has reached. `completed=true` is what's
 * actually done.
 *
 * Our `order_step` column stores the active step. Therefore:
 *
 *   active step             ↔  Renter state
 *   ───────────────────────────────────────────────────────────────────────
 *   REQUEST                    Renter sent request; owner hasn't accepted
 *   APPROVED                   Owner accepted; renter hasn't paid yet
 *   FUNDS_RESERVED             Renter still needs to pay (escrow not funded)
 *   VERIFIED                   Renter paid ✓; currently doing ID/doc verification
 *   BOOKED_AFTER_VERIFIED      Verified ✓; awaiting handover
 *   DELIVERED                  Verified ✓; pickup happening / gear out
 *   RETURNED                   Gear with renter; awaiting return
 *   REVIEWED                   Rental complete; awaiting review
 *   (null)                     Funnel finished or row not yet polled
 *
 *   CANCELED / VERIFICATION_FAILED    Terminal failure states
 *
 * RULE OF THUMB: when reading `order_step`, ask "what does the renter need to
 * do NEXT?" — that's the value stored. To check "have they passed step X?",
 * use the helpers below (e.g. `isPaid`, `isVerified`).
 */

export const ORDER_STEPS = [
  "REQUEST",
  "APPROVED",
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
  "CANCELED",
  "VERIFICATION_FAILED",
] as const;
export type OrderStep = typeof ORDER_STEPS[number];

/** Step priority (higher = more advanced). Used by isStepRegression. */
export const STEP_PRIORITY: Record<OrderStep, number> = {
  REVIEWED: 8,
  RETURNED: 7,
  DELIVERED: 6,
  BOOKED_AFTER_VERIFIED: 5,
  VERIFIED: 4,
  FUNDS_RESERVED: 3,
  APPROVED: 2,
  REQUEST: 1,
  CANCELED: 0,
  VERIFICATION_FAILED: 0,
};

/**
 * Steps where the renter has paid (escrow funded).
 * Implication: order_step value `s` implies renter passed FUNDS_RESERVED only
 * when `s` is VERIFIED or later. If active step IS FUNDS_RESERVED, the renter
 * still needs to fund the escrow.
 */
export const PAID_ORDER_STEPS = [
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
] as const;
export type PaidOrderStep = typeof PAID_ORDER_STEPS[number];

/** Steps where renter has finished verification (so funnel is post-verify). */
export const VERIFIED_ORDER_STEPS = [
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
] as const;

/** Active step indicating gear is currently with the renter. */
export const OUT_ORDER_STEPS = ["RETURNED", "REVIEWED"] as const;

/** Terminal failure / cancellation. */
export const DEAD_ORDER_STEPS = ["CANCELED", "VERIFICATION_FAILED"] as const;

const PAID_SET = new Set<string>(PAID_ORDER_STEPS);
const VERIFIED_SET = new Set<string>(VERIFIED_ORDER_STEPS);
const OUT_SET = new Set<string>(OUT_ORDER_STEPS);
const DEAD_SET = new Set<string>(DEAD_ORDER_STEPS);

/** True if the renter has paid (escrow funded). */
export function isPaid(step: string | null | undefined): boolean {
  return step != null && PAID_SET.has(step);
}

/** True if the renter has completed verification. */
export function isVerified(step: string | null | undefined): boolean {
  return step != null && VERIFIED_SET.has(step);
}

/** True if gear is currently with the renter (rental in progress). */
export function isGearOut(step: string | null | undefined): boolean {
  return step != null && OUT_SET.has(step);
}

/** True if order is cancelled or failed verification. */
export function isDead(step: string | null | undefined): boolean {
  return step != null && DEAD_SET.has(step);
}

/** True if active step is VERIFIED — paid AND currently in verification. */
export function isInVerification(step: string | null | undefined): boolean {
  return step === "VERIFIED";
}

/**
 * Human-readable labels for UI display. Phrased from the OWNER's perspective:
 * "what is happening with this booking right now?"
 */
export const ORDER_STEP_LABEL: Record<OrderStep, string> = {
  REQUEST: "Request — awaiting your approval",
  APPROVED: "Awaiting renter payment",
  FUNDS_RESERVED: "Awaiting renter payment",
  VERIFIED: "Verifying renter",
  BOOKED_AFTER_VERIFIED: "Confirmed — awaiting handover",
  DELIVERED: "Out with renter",
  RETURNED: "Awaiting return",
  REVIEWED: "Complete",
  CANCELED: "Cancelled",
  VERIFICATION_FAILED: "Verification failed",
};

/** Short single-word label for compact UI chips (calendar blocks, drawers). */
export const ORDER_STEP_LABEL_SHORT: Record<OrderStep, string> = {
  REQUEST: "Request",
  APPROVED: "Awaiting",
  FUNDS_RESERVED: "Awaiting",
  VERIFIED: "Verifying",
  BOOKED_AFTER_VERIFIED: "Confirmed",
  DELIVERED: "Out",
  RETURNED: "Returning",
  REVIEWED: "Done",
  CANCELED: "Cancelled",
  VERIFICATION_FAILED: "Failed",
};
