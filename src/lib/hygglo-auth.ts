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
 * Fetch all secrets for a Hygglo account service (e.g. `hygglo-dbcinema`,
 * `hygglo-leo`) from the project-hub vault.
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
  const data = (await res.json()) as { value: VaultSecret[] };
  const out: Record<string, string> = {};
  for (const s of data.value ?? []) out[s.keyName] = s.value;
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

/**
 * Convenience: resolve the (email, password, clientSecret) for an account
 * from the vault. The vault stores them under service `hygglo-<slug>`
 * with keys HYGGLO_EMAIL / HYGGLO_PASSWORD / HYGGLO_CLIENT_SECRET.
 */
export async function getAccountCredentials(accountSlug: string): Promise<{
  email: string;
  password: string;
  clientSecret: string;
}> {
  const secrets = await getVaultSecrets(`hygglo-${accountSlug}`);
  const email = secrets.HYGGLO_EMAIL;
  const password = secrets.HYGGLO_PASSWORD;
  const clientSecret = secrets.HYGGLO_CLIENT_SECRET;
  if (!email || !password || !clientSecret) {
    throw new Error(
      `Missing Hygglo credentials in vault for ${accountSlug} ` +
        `(needs HYGGLO_EMAIL, HYGGLO_PASSWORD, HYGGLO_CLIENT_SECRET).`,
    );
  }
  return { email, password, clientSecret };
}
