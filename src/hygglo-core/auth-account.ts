/**
 * hygglo-core/auth-account — the per-account descriptor.
 *
 * A `HyggloAccount` is the minimal identity hygglo-core needs to authenticate
 * and route a request: the vault slug (e.g. "leo", "dbcinema") and the country
 * the account belongs to (GB for leo/dbcinema; SE for the legacy Swedish
 * account the old poller used). Credentials are NEVER stored here — they are
 * resolved on demand from the vault via `getAccountCredentials(slug)`.
 *
 * Kept in its own tiny module so `types.ts` can re-export the type without a
 * cycle through `auth.ts` (which imports nothing from here).
 */

export interface HyggloAccount {
  /** Vault slug — keys HYGGLO_<SLUG>_EMAIL / HYGGLO_<SLUG>_PASSWORD. */
  slug: string;
  /** ISO country for the OAuth token + request headers. Default GB. */
  country?: string;
}

/** Normalise an account or bare slug string into a full descriptor. */
export function toAccount(account: HyggloAccount | string): HyggloAccount {
  return typeof account === "string" ? { slug: account } : account;
}
