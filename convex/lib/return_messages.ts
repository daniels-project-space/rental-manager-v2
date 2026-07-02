/**
 * Post-rental copy, per Hygglo account — PURE module (no server imports) so it
 * can be used from Convex functions, the CLI and (via query previews) the UI.
 *
 * Three texts per account, each with its own human voice so the accounts don't
 * read like the same person copy-pasting:
 *   1. discount message   — chat text with the promo code + review ask
 *   2. review-only message — chat text asking for a review, no code
 *   3. review comment      — the public 5★ review left ON the renter
 *
 * Sent (via the gated hygglo-write chokepoint) ONLY to "good" renters on a
 * smooth/fantastic return — NEVER to renters currently flagged or blacklisted
 * (the suppression gate lives in `markReturned`, convex/reservations.ts).
 *
 * WORDINGS are fixed brand copy (deliberate redeploy to change). The CODE and
 * PERCENT are operator-editable per account in the Settings drawer
 * (account_profiles.return_discount_code/_percent, resolved by
 * convex/lib/return_discounts.ts) — these defaults apply until a value is
 * saved there. Unknown account slug -> null -> no message is sent (fail-safe:
 * we never text a wrong/blank promo code).
 */

export interface ReturnDiscountConfig {
  /** Promo code the renter texts back in chat. */
  code: string;
  /** Percent off applied to the renter's next rental. */
  percent: number;
}

/** Fallback code/percent per account when nothing is saved in Settings. */
export const DEFAULT_RETURN_DISCOUNTS: Record<string, ReturnDiscountConfig> = {
  leo: { code: "LEO10OFF", percent: 10 },
  dbcinema: { code: "DB15OFF", percent: 15 },
  diogo: { code: "DIOGO10OFF", percent: 10 },
};

// ── 1. Discount + review-ask chat message (code/percent interpolated) ──────
// leo keeps the operator's original dictated voice; dbcinema reads a bit more
// "shop", diogo a bit more personal — all casual and human.

const DISCOUNT_TEMPLATES: Record<string, (code: string, percent: number) => string> = {
  leo: (code, percent) =>
    "Hey all gear is good and back thx so much for taking care of the equipment! " +
    "im still quite new here and trying to grow, so if you could leave a review that " +
    `would really help me out on here! and for the future text me code ${code} here ` +
    `in chat and i will apply ${percent}% off onto your entire rental :)`,
  dbcinema: (code, percent) =>
    "Hey! everything came back safe and in great shape, really appreciate you looking " +
    "after the kit. if you have a minute, a quick review would mean a lot to us. " +
    `and for next time — text me code ${code} in chat and ill take ${percent}% off ` +
    "your whole rental :)",
  diogo: (code, percent) =>
    "Hey, just gave the gear a once-over and its all perfect, thanks for being so " +
    "careful with it! a review would honestly make my day if you can spare a sec. " +
    `oh and keep code ${code} handy — text it to me on your next rental and ill ` +
    `knock ${percent}% off everything :)`,
};

/**
 * The discount chat message for an account with the given code/percent, or
 * null when the account has no template (nothing is sent).
 */
export function renderDiscountMessage(
  accountSlug: string | null | undefined,
  code: string,
  percent: number,
): string | null {
  if (!accountSlug || !code) return null;
  const tpl = DISCOUNT_TEMPLATES[accountSlug];
  return tpl ? tpl(code, percent) : null;
}

// ── 2. Review-only chat message (operator unticked "send discount code") ───

const REVIEW_ONLY_MESSAGES: Record<string, string> = {
  leo:
    "Hey all gear is good and back thx so much for taking care of the equipment! " +
    "im still quite new here and trying to grow, so if you could leave a review that " +
    "would really help me out on here :)",
  dbcinema:
    "Hey! everything came back safe and in great shape, really appreciate you looking " +
    "after the kit. if you have a minute, a quick review would mean a lot to us :)",
  diogo:
    "Hey, just gave the gear a once-over and its all perfect, thanks for being so " +
    "careful with it! if you can spare a sec, a review would honestly make my day :)",
};

/**
 * The no-discount review-ask body for an account, or null when the account has
 * no defined copy (unknown account -> nothing is sent, same fail-safe as above).
 */
export function reviewOnlyMessageFor(accountSlug?: string | null): string | null {
  if (!accountSlug) return null;
  return REVIEW_ONLY_MESSAGES[accountSlug] ?? null;
}

// ── 3. Public 5★ review comment left ON the renter's profile ───────────────

const REVIEW_COMMENTS: Record<string, string> = {
  leo:
    "Great renter — took good care of the gear, easy to reach, and returned everything on time. Welcome back any time!",
  dbcinema:
    "Everything came back in perfect condition. Friendly, reliable and easy to deal with — happy to rent to them again.",
  diogo:
    "Really smooth rental from start to finish, the gear came back spotless. Recommended!",
};

const REVIEW_COMMENT_FALLBACK =
  "5/5 — great renter, looked after the gear and easy to deal with. Welcome back any time!";

/** The 5★ review comment for an account (generic fallback for unknown slugs). */
export function reviewCommentFor(accountSlug?: string | null): string {
  if (!accountSlug) return REVIEW_COMMENT_FALLBACK;
  return REVIEW_COMMENTS[accountSlug] ?? REVIEW_COMMENT_FALLBACK;
}
