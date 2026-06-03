/**
 * hygglo-core/client — typed fetch wrapper for the Hygglo private REST API.
 *
 * Responsibilities:
 *   - resolve credentials for an account from the vault (once) and mint a
 *     Bearer token (cached for the lifetime of the client instance);
 *   - attach the canonical auth headers (Authorization / Country / User-Client);
 *   - prefix the API base (`https://api.hygglo.com/api`);
 *   - surface HTTP errors as typed `HyggloApiError` (status + sliced body),
 *     never leaking the token.
 *
 * Reads go through `getJson`. Writes go through `patchJson` / `sendRaw` but are
 * NOT wired live in Phase 1 — the orders/catalog write functions throw before
 * ever reaching the client. The write helpers exist on the client so Phase 4
 * only has to remove the throws, not re-plumb auth.
 *
 * Pure fetch — Convex V8 / Trigger Node / Next safe.
 */

import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
  HYGGLO_DEFAULT_COUNTRY,
} from "./auth";
import { type HyggloAccount, toAccount } from "./auth-account";

/** Typed error for any non-2xx Hygglo response. Body is sliced to 500 chars. */
export class HyggloApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  constructor(args: {
    status: number;
    method: string;
    path: string;
    body: string;
  }) {
    super(
      `Hygglo ${args.method} ${args.path} → ${args.status}: ${args.body.slice(0, 500)}`,
    );
    this.name = "HyggloApiError";
    this.status = args.status;
    this.method = args.method;
    this.path = args.path;
    this.body = args.body.slice(0, 500);
  }
}

export interface HyggloClient {
  readonly account: HyggloAccount;
  /** Authenticated GET → parsed JSON. `path` is relative to the API base. */
  getJson<T>(path: string): Promise<T>;
  /** Authenticated PATCH with `{ action, data }` body → parsed JSON. */
  patchJson<T>(path: string, body: unknown): Promise<T>;
  /** Generic authenticated request escape hatch (PUT/POST/DELETE). */
  sendRaw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }>;
  /** Unauthenticated GET (public endpoints, e.g. product-listings). */
  getPublicJson<T>(path: string, country?: string): Promise<T>;
}

/**
 * Create a Hygglo REST client bound to one account. The Bearer token is minted
 * lazily on the first authenticated call and cached on the instance — callers
 * that make several reads in a row reuse one token.
 */
export function createClient(accountInput: HyggloAccount | string): HyggloClient {
  const account = toAccount(accountInput);
  const country = account.country ?? HYGGLO_DEFAULT_COUNTRY;
  let tokenPromise: Promise<string> | undefined;

  async function token(): Promise<string> {
    if (!tokenPromise) {
      tokenPromise = (async () => {
        const creds = await getAccountCredentials(account.slug);
        return getHyggloAccessToken({
          ...creds,
          accountSlug: account.slug,
          country,
        });
      })();
    }
    return tokenPromise;
  }

  function url(path: string): string {
    return path.startsWith("http")
      ? path
      : `${HYGGLO_API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  }

  async function getJson<T>(path: string): Promise<T> {
    const t = await token();
    const res = await fetch(url(path), { headers: hyggloAuthHeaders(t, country) });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new HyggloApiError({ status: res.status, method: "GET", path, body });
    }
    return (await res.json()) as T;
  }

  async function patchJson<T>(path: string, body: unknown): Promise<T> {
    const t = await token();
    const res = await fetch(url(path), {
      method: "PATCH",
      headers: {
        ...hyggloAuthHeaders(t, country),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "<unreadable>");
      throw new HyggloApiError({
        status: res.status,
        method: "PATCH",
        path,
        body: txt,
      });
    }
    return (await res.json()) as T;
  }

  async function sendRaw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const t = await token();
    const res = await fetch(url(path), {
      method,
      headers: {
        ...hyggloAuthHeaders(t, country),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new HyggloApiError({
        status: res.status,
        method,
        path,
        body: typeof json === "string" ? json : JSON.stringify(json ?? ""),
      });
    }
    return { status: res.status, json };
  }

  async function getPublicJson<T>(path: string, c?: string): Promise<T> {
    const ctry = c ?? country;
    const sep = url(path).includes("?") ? "&" : "?";
    const res = await fetch(`${url(path)}${sep}country=${ctry}`, {
      headers: {
        Accept: "application/json",
        Country: ctry,
        "User-Client": "Hygglo-web",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      throw new HyggloApiError({
        status: res.status,
        method: "GET(public)",
        path,
        body,
      });
    }
    return (await res.json()) as T;
  }

  return { account, getJson, patchJson, sendRaw, getPublicJson };
}
