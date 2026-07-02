/**
 * Resolve the EFFECTIVE return-discount code/percent for an account:
 * operator-saved values (Settings drawer -> account_profiles
 * .return_discount_code/_percent) win, DEFAULT_RETURN_DISCOUNTS fill the gaps.
 * Used by markReturned (renders the outbound text) and the Settings drawer
 * query, so the dashboard always shows exactly what would be sent.
 */
import type { DatabaseReader } from "../_generated/server";
import {
  DEFAULT_RETURN_DISCOUNTS,
  type ReturnDiscountConfig,
} from "./return_messages";

/**
 * Effective config for an account slug, or null when the account has neither
 * a saved code nor a default (unknown accounts send nothing — fail-safe).
 */
export async function resolveReturnDiscount(
  db: DatabaseReader,
  accountSlug?: string | null,
): Promise<ReturnDiscountConfig | null> {
  if (!accountSlug) return null;
  const fallback = DEFAULT_RETURN_DISCOUNTS[accountSlug] ?? null;

  const account = await db
    .query("accounts")
    .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
    .first();
  const profile = account
    ? await db
        .query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", account._id))
        .first()
    : null;

  const savedCode = profile?.return_discount_code?.trim();
  const savedPercent = profile?.return_discount_percent;

  const code = savedCode || fallback?.code;
  if (!code) return null;
  const percent =
    typeof savedPercent === "number" && savedPercent > 0
      ? savedPercent
      : fallback?.percent ?? 10;
  return { code, percent };
}
