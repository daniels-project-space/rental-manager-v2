/**
 * Account-slug validation. Every rental/revenue/funnel query that already
 * takes an `account` filter must continue to use this type so future
 * consumers (polling agent in Wave 4, renter-bot in Wave 5) cannot drift.
 *
 * V1 audit: /tmp/claude_scratchpad/v1_feature_inventory.md §6 line 244
 */
import { ACCOUNTS, type AccountSlug } from "./constants";

export type { AccountSlug } from "./constants";
export { ACCOUNTS } from "./constants";

/**
 * Returns the slug if valid, or null if the caller passed null/undefined
 * (meaning "no filter — both accounts"). Throws on a non-matching slug.
 */
export function validateAccount(
  slug: string | null | undefined,
): AccountSlug | null {
  if (slug == null) return null;
  if ((ACCOUNTS as readonly string[]).includes(slug)) {
    return slug as AccountSlug;
  }
  throw new Error(
    `Invalid account slug: ${slug}. Expected one of: ${ACCOUNTS.join(", ")}`,
  );
}
