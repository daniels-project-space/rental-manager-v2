/**
 * Post-rental discount + review-request copy, per Hygglo account.
 *
 * Sent (via the gated hygglo-write chokepoint) ONLY to "good" renters on a
 * smooth/fantastic return — NEVER to renters currently flagged or blacklisted
 * (the suppression gate lives in `markReturned`, convex/reservations.ts).
 *
 * Hardcoded on purpose (operator decision 2026-06-15): the wording + codes are
 * fixed brand copy, so editing them is a deliberate redeploy rather than a
 * silently-editable DB row. Unknown account slug -> null -> no message is sent
 * (fail-safe: we never send a wrong/blank promo code).
 *
 * NB: minor typo fixes vs. the operator's literal dictation were applied
 * ("oyu"->"you", "texst em"->"text me") so the message reads cleanly to a real
 * renter; the casual lowercase voice is intentional and preserved verbatim.
 */
export interface ReturnDiscount {
  /** Promo code the renter texts back in chat. */
  code: string;
  /** Percent off applied to the renter's next rental. */
  percent: number;
  /** Full chat message body sent to the renter. */
  message: string;
}

const LEO_MESSAGE =
  "Hey all gear is good and back thx so much for taking care of the equipment! " +
  "im still quite new here and trying to grow, so if you could leave a review that " +
  "would really help me out on here! and for the future text me code LEO10OFF here " +
  "in chat and i will apply 10% off onto your entire rental :)";

const DBCINEMA_MESSAGE =
  "Hey all gear is good and back thx so much for taking care of the equipment! " +
  "im still quite new here and trying to grow, so if you could leave a review that " +
  "would really help me out on here! and for the future text me code DB15OFF here " +
  "in chat and i will apply 15% off onto your entire rental :)";

/**
 * account_slug -> discount copy. Keys MUST match `reservations.account_slug`
 * values ("leo" | "dbcinema").
 */
export const RETURN_DISCOUNT_BY_ACCOUNT: Record<string, ReturnDiscount> = {
  leo: { code: "LEO10OFF", percent: 10, message: LEO_MESSAGE },
  dbcinema: { code: "DB15OFF", percent: 15, message: DBCINEMA_MESSAGE },
};

/** The discount copy block for an account, or null if the account is unknown. */
export function discountForAccount(accountSlug?: string | null): ReturnDiscount | null {
  if (!accountSlug) return null;
  return RETURN_DISCOUNT_BY_ACCOUNT[accountSlug] ?? null;
}

/**
 * The chat message body to send a good renter on close, or null when the
 * account has no defined copy (in which case NO message is sent).
 */
export function discountMessageFor(accountSlug?: string | null): string | null {
  return discountForAccount(accountSlug)?.message ?? null;
}
