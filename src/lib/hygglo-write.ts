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
 * Hygglo's REST write API uses an *action-dispatcher* pattern: every write
 * targets the same `PATCH /v4/my/orders/{id}?timezone=...` endpoint with a
 * body of shape `{ action: <verb>, data: <payload> }`. This is confirmed by
 * V1's `src/hygglo/hygglo.service.ts:1267` (sendMessage uses `action: 'chat'`)
 * and is the only REST write path V1 ever shipped — V1's accept/decline run
 * through Playwright button-click in `src/playwright/playwright.service.ts`,
 * so the REST `action` strings for approve/decline are not 1:1 verifiable
 * from V1. We use the conventional names (`approve`, `decline`); if
 * Hygglo rejects them the captured response body (sliced to 500 chars in
 * `httpStatus`/`error`) will tell us the right verb on the first live call.
 */
const HYGGLO_WRITE_TZ = "Europe/London";

async function patchOrderAction(args: {
  accountSlug: string;
  hyggloOrderId: string;
  action: string;
  data: Record<string, unknown>;
}): Promise<HyggloWriteResult> {
  const creds = await getAccountCredentials(args.accountSlug);
  const token = await getHyggloAccessToken({
    ...creds,
    accountSlug: args.accountSlug,
  });
  const res = await fetch(
    `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(args.hyggloOrderId)}?timezone=${encodeURIComponent(HYGGLO_WRITE_TZ)}`,
    {
      method: "PATCH",
      headers: { ...hyggloAuthHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ action: args.action, data: args.data }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    return { status: "failed", httpStatus: res.status, error: body.slice(0, 500) };
  }
  return { status: "sent", httpStatus: res.status };
}

/**
 * Accept a rental request. Maps to V1 `playwright.service.ts:acceptRental`
 * (which clicked the "Approve" button). REST equivalent so the write is
 * auditable + headless.
 *
 * Endpoint (action-dispatcher pattern, see module header):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "approve", data: {} }
 */
export async function acceptOrder(args: {
  accountSlug: string;
  hyggloOrderId: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({ ...args, action: "approve", data: {} });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Decline a rental request. Maps to V1 `playwright.service.ts:declineRental`.
 *
 * Endpoint (action-dispatcher pattern):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "decline", data: { reason } }
 */
export async function declineOrder(args: {
  accountSlug: string;
  hyggloOrderId: string;
  reason: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "decline",
      data: { reason: args.reason },
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Send a chat message to a renter. Maps 1:1 to V1
 * `src/hygglo/hygglo.service.ts:1267 (sendMessage)`.
 *
 * Endpoint (verified against V1 production):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "chat", data: { message } }
 *
 * NB: `conversationId` IS the Hygglo order id — Hygglo conflates rentals
 * and their chat threads on the same `/v4/my/orders/{id}` resource. The
 * argument name is kept for the existing caller surface; rename later if
 * confusing.
 */
export async function sendMessage(args: {
  accountSlug: string;
  conversationId: string;
  text: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.conversationId,
      action: "chat",
      data: { message: args.text },
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
