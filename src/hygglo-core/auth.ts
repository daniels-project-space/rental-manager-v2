/**
 * hygglo-core/auth — Phase 1 (additive).
 *
 * Ported VERBATIM from `src/lib/hygglo-auth.ts` with one additive change:
 * the `country` is now a per-account PARAMETER (default "GB") rather than a
 * module-level constant, so this single auth path can serve GB accounts
 * (leo / dbcinema) and the legacy SE poller alike.
 *
 * Behaviour is otherwise byte-for-byte identical to the shared auth helper:
 *   - getVaultSecrets (keyName + aliases indexed)
 *   - getHyggloAccessToken (OAuth2 password-grant → Bearer)
 *   - hyggloAuthHeaders
 *   - getAccountCredentials (combined `hygglo` → per-account `hygglo-<slug>` →
 *     client_secret fallback)
 *
 * Pure fetch only — runs in Convex V8, Trigger Node, and Next. No node:fs,
 * no Playwright, no Go.
 *
 * SECURITY: never logs the access_token or any secret value. Errors surface
 * HTTP status + body only.
 */

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
export const HYGGLO_API_BASE = "https://api.hygglo.com/api";
export const HYGGLO_CLIENT_ID = "ngHyggloApp";
/** Default country for accounts that don't specify one (GB = leo / dbcinema). */
export const HYGGLO_DEFAULT_COUNTRY = "GB";

interface VaultSecret {
  keyName: string;
  value: string;
}

/**
 * Fetch all secrets for a vault service (e.g. `hygglo`, `hygglo-dbcinema`,
 * `hygglo-leo`). Indexes both `keyName` AND any `aliases` so callers can
 * look up by either canonical key or alias.
 *
 * Throws on non-200. Returns a key→value map (NOT logged).
 */
export async function getVaultSecrets(
  service: string,
): Promise<Record<string, string>> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!res.ok) {
    throw new Error(`Vault fetch failed for ${service}: ${res.status}`);
  }
  const data = (await res.json()) as {
    value: Array<VaultSecret & { aliases?: string[] }>;
  };
  const out: Record<string, string> = {};
  for (const s of data.value ?? []) {
    out[s.keyName] = s.value;
    for (const a of s.aliases ?? []) out[a] = s.value;
  }
  return out;
}

/**
 * Exchange username/password+client_secret for a bearer token via Hygglo's
 * OAuth2 password-grant endpoint. Matches the auth flow already in
 * `src/lib/hygglo-auth.ts` / `src/trigger/poll-hygglo.ts:scrapeAccount`.
 *
 * `country` is additive — defaults to GB to preserve the shared helper's
 * behaviour; pass "SE" for the legacy Swedish account.
 */
export async function getHyggloAccessToken(args: {
  email: string;
  password: string;
  clientSecret: string;
  accountSlug: string; // for error messages only
  country?: string;
}): Promise<string> {
  const country = args.country ?? HYGGLO_DEFAULT_COUNTRY;
  const params = new URLSearchParams({
    grant_type: "password",
    username: args.email,
    password: args.password,
    client_id: HYGGLO_CLIENT_ID,
    client_secret: args.clientSecret,
  });

  const res = await fetch(`${HYGGLO_API_BASE}/token?country=${country}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Client": "Hygglo-web",
      Origin: "https://www.hygglo.com",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `Hygglo auth failed for ${args.accountSlug}: ${res.status} ${body}`,
    );
  }

  const { access_token } = (await res.json()) as { access_token: string };
  if (!access_token) {
    throw new Error(
      `Hygglo auth returned no access_token for ${args.accountSlug}`,
    );
  }
  return access_token;
}

/**
 * Build the standard authenticated-request headers used across the Hygglo
 * REST API. `country` is additive (default GB) — must match the country used
 * to mint the token.
 */
export function hyggloAuthHeaders(
  token: string,
  country: string = HYGGLO_DEFAULT_COUNTRY,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Country: country,
    "User-Client": "Hygglo-web",
  };
}

// Fallback for HYGGLO_CLIENT_SECRET when vault has no entry — matches the
// constant baked into src/lib/hygglo-auth.ts, src/trigger/poll-hygglo.ts and
// scripts/audit/ground-truth.mjs (Hygglo's published ngHyggloApp client
// secret). Not a real credential leak: it is the public web-app client secret.
const HYGGLO_CLIENT_SECRET_FALLBACK =
  "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";

/**
 * Convenience: resolve the (email, password, clientSecret) for an account
 * from the vault.
 *
 * Lookup order (matches src/lib/hygglo-auth.ts which already works):
 *   1. service `hygglo` (combined), keys HYGGLO_<SLUG>_EMAIL / HYGGLO_<SLUG>_PASSWORD
 *   2. service `hygglo-<slug>` (per-account), keys HYGGLO_EMAIL / HYGGLO_PASSWORD
 *      and aliases HYGGLO_<SLUG>_EMAIL / HYGGLO_<SLUG>_PASSWORD
 *   3. clientSecret: vault key HYGGLO_CLIENT_SECRET from either service,
 *      else falls back to the hardcoded Hygglo-web constant.
 */
export async function getAccountCredentials(accountSlug: string): Promise<{
  email: string;
  password: string;
  clientSecret: string;
}> {
  const SLUG = accountSlug.toUpperCase();
  let email: string | undefined;
  let password: string | undefined;
  let clientSecret: string | undefined;

  // Step 1: combined `hygglo` service.
  try {
    const combined = await getVaultSecrets("hygglo");
    email = combined[`HYGGLO_${SLUG}_EMAIL`];
    password =
      combined[`HYGGLO_${SLUG}_PASSWORD`] ?? combined[`HYGGLO_${SLUG}_PASS`];
    clientSecret = combined["HYGGLO_CLIENT_SECRET"];
  } catch {
    // ignore — fall through to per-account service
  }

  // Step 2: per-account `hygglo-<slug>` service (with USER/PASS aliases).
  if (!email || !password) {
    try {
      const perAccount = await getVaultSecrets(`hygglo-${accountSlug}`);
      email =
        email ??
        perAccount.HYGGLO_EMAIL ??
        perAccount[`HYGGLO_${SLUG}_EMAIL`] ??
        perAccount.HYGGLO_USER ??
        perAccount[`HYGGLO_${SLUG}_USER`];
      password =
        password ??
        perAccount.HYGGLO_PASSWORD ??
        perAccount[`HYGGLO_${SLUG}_PASSWORD`] ??
        perAccount.HYGGLO_PASS ??
        perAccount[`HYGGLO_${SLUG}_PASS`];
      clientSecret = clientSecret ?? perAccount.HYGGLO_CLIENT_SECRET;
    } catch {
      // ignore — final check below
    }
  }

  clientSecret = clientSecret ?? HYGGLO_CLIENT_SECRET_FALLBACK;

  if (!email || !password) {
    throw new Error(
      `Missing Hygglo credentials in vault for ${accountSlug} ` +
        `(checked service "hygglo" keys HYGGLO_${SLUG}_EMAIL/PASSWORD and ` +
        `service "hygglo-${accountSlug}" keys HYGGLO_EMAIL/PASSWORD).`,
    );
  }
  return { email, password, clientSecret };
}
