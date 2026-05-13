/**
 * Wave 4.5 — Hygglo write chokepoint.
 *
 * EVERY outbound Hygglo write (accept order, decline order, send message)
 * MUST go through this module. This is the *only* file in the codebase that
 * is allowed to call Hygglo with non-GET HTTP verbs.
 *
 * Safety rails:
 *   1. `READ_ONLY_MODE` env check FIRST in every method. When true we return
 *      a `skipped` result without ever calling Hygglo — caller records the
 *      intent in `ai_decision_audit` so we can replay later.
 *   2. The internal helper `assertWriteAllowed()` is the single trip-wire.
 *      Tests can stub it; production code never calls it directly.
 *   3. All return values are typed `HyggloWriteResult` so callers must
 *      branch on `status` and cannot silently assume success.
 *
 * NB: When READ_ONLY_MODE flips off, the only thing to verify in this file
 * is the actual Hygglo endpoint shapes — auth + serialization are already
 * shared with `poll-hygglo.ts` via `hygglo-auth.ts`.
 */
// NOTE: no `import "server-only"` — this module is imported by Convex
// actions (which run in Node but reject the `server-only` poison-pill).
// The module is server-side by virtue of using `fetch` + the vault; do not
// bundle client-side.
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "./hygglo-auth";

// ── Result envelope ──────────────────────────────────────────────

export type HyggloWriteStatus = "sent" | "skipped" | "failed";

export interface HyggloWriteResult {
  status: HyggloWriteStatus;
  httpStatus?: number;
  error?: string;
  /** Set when status === 'skipped'. */
  reason?: "READ_ONLY_MODE";
}

// ── Safety rail ──────────────────────────────────────────────────

/**
 * Returns true when writes are permitted (READ_ONLY_MODE is not 'true').
 * Reads the env *each call* so tests can mutate process.env between calls.
 */
function writesAllowed(): boolean {
  return process.env.READ_ONLY_MODE !== "true";
}

function skipResult(): HyggloWriteResult {
  return { status: "skipped", reason: "READ_ONLY_MODE" };
}

// ── Methods ──────────────────────────────────────────────────────

/**
 * Accept a rental request. Maps to V1 `playwright.service.ts:acceptRental`
 * (which clicked the "Approve" button). We use the REST equivalent so the
 * write is auditable + headless.
 *
 * Endpoint shape (placeholder — confirm before flipping READ_ONLY_MODE off):
 *   POST /v4/my/orders/:id/approve
 */
export async function acceptOrder(args: {
  accountSlug: string;
  hyggloOrderId: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    const creds = await getAccountCredentials(args.accountSlug);
    const token = await getHyggloAccessToken({
      ...creds,
      accountSlug: args.accountSlug,
    });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(args.hyggloOrderId)}/approve`,
      {
        method: "POST",
        headers: { ...hyggloAuthHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      return { status: "failed", httpStatus: res.status, error: body.slice(0, 500) };
    }
    return { status: "sent", httpStatus: res.status };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Decline a rental request. Maps to V1 `playwright.service.ts:declineRental`.
 *
 * Endpoint shape (placeholder — confirm before flipping READ_ONLY_MODE off):
 *   POST /v4/my/orders/:id/decline   body: { reason }
 */
export async function declineOrder(args: {
  accountSlug: string;
  hyggloOrderId: string;
  reason: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    const creds = await getAccountCredentials(args.accountSlug);
    const token = await getHyggloAccessToken({
      ...creds,
      accountSlug: args.accountSlug,
    });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(args.hyggloOrderId)}/decline`,
      {
        method: "POST",
        headers: { ...hyggloAuthHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ reason: args.reason }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      return { status: "failed", httpStatus: res.status, error: body.slice(0, 500) };
    }
    return { status: "sent", httpStatus: res.status };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Send a chat message to a renter. Maps to V1
 * `playwright.service.ts:sendMessage`.
 *
 * Endpoint shape (placeholder — confirm before flipping READ_ONLY_MODE off):
 *   POST /v4/my/conversations/:id/messages   body: { text }
 *
 * `conversationId` here is the Hygglo thread id (e.g. order id or
 * conversation id surfaced in scraper payload).
 */
export async function sendMessage(args: {
  accountSlug: string;
  conversationId: string;
  text: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    const creds = await getAccountCredentials(args.accountSlug);
    const token = await getHyggloAccessToken({
      ...creds,
      accountSlug: args.accountSlug,
    });
    const res = await fetch(
      `${HYGGLO_API_BASE}/v4/my/conversations/${encodeURIComponent(args.conversationId)}/messages`,
      {
        method: "POST",
        headers: { ...hyggloAuthHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ text: args.text }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      return { status: "failed", httpStatus: res.status, error: body.slice(0, 500) };
    }
    return { status: "sent", httpStatus: res.status };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
