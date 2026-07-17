/**
 * Wave 4.5 — Shared Hygglo OAuth2 token + secrets helper.
 *
 * Extracted from `src/trigger/poll-hygglo.ts` so the polling task and the
 * Wave 4.5 write client (`src/lib/hygglo-write.ts`) share a single auth path.
 * The poll task still owns its inline auth for now (low blast-radius); new
 * write code MUST go through this module.
 *
 * SECURITY: never logs the access_token. Errors surface HTTP status + body.
 */

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
export const HYGGLO_API_BASE = "https://api.hygglo.com/api";
export const HYGGLO_CLIENT_ID = "ngHyggloApp";
export const HYGGLO_COUNTRY = "GB";

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
  const vaultToken = process.env.VAULT_ACCESS_TOKEN;
  if (!vaultToken) throw new Error("VAULT_ACCESS_TOKEN is not configured");
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service, vaultToken },
      format: "json",
    }),
  });
  if (!res.ok) {
    throw new Error(`Vault fetch failed for ${service}: ${res.status}`);
  }
  const data = (await res.json()) as { value: Array<VaultSecret & { aliases?: string[] }> };
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
 * `src/trigger/poll-hygglo.ts:scrapeAccount`.
 */
export async function getHyggloAccessToken(args: {
  email: string;
  password: string;
  clientSecret: string;
  accountSlug: string; // for error messages only
}): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "password",
    username: args.email,
    password: args.password,
    client_id: HYGGLO_CLIENT_ID,
    client_secret: args.clientSecret,
  });

  const res = await fetch(
    `${HYGGLO_API_BASE}/token?country=${HYGGLO_COUNTRY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Client": "Hygglo-web",
        Origin: "https://www.hygglo.com",
      },
      body: params.toString(),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `Hygglo auth failed for ${args.accountSlug}: ${res.status} ${body}`,
    );
  }

  const { access_token } = (await res.json()) as { access_token: string };
  if (!access_token) {
    throw new Error(`Hygglo auth returned no access_token for ${args.accountSlug}`);
  }
  return access_token;
}

/**
 * Build the standard authenticated-request headers used across the Hygglo
 * REST API.
 */
export function hyggloAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Country: HYGGLO_COUNTRY,
    "User-Client": "Hygglo-web",
  };
}

// Fallback for HYGGLO_CLIENT_SECRET when vault has no entry — matches
// the constant baked into src/trigger/poll-hygglo.ts and scripts/audit
// /ground-truth.mjs (Hygglo's published ngHyggloApp client secret).
const HYGGLO_CLIENT_SECRET_FALLBACK =
  "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";

/**
 * Convenience: resolve the (email, password, clientSecret) for an account
 * from the vault.
 *
 * Lookup order (matches src/trigger/poll-hygglo.ts which already works):
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
