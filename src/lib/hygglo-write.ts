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
  reason?: "READ_ONLY_MODE" | "RETURN_WRITES_DISABLED" | "MANUAL_SEND_DISABLED";
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

/**
 * SECOND, INDEPENDENT gate that ONLY governs the irreversible Hygglo close
 * (`returnOrder`, action:"return"). Policy (Daniel, 2026-06-17): the system must
 * NEVER auto-close a rental — Daniel closes each one MANUALLY on Hygglo. The
 * close verb is therefore HARD-BLOCKED by default and is decoupled from
 * READ_ONLY_MODE: even with READ_ONLY_MODE=false (writes on for rating + chat),
 * `returnOrder` still refuses unless someone explicitly sets
 * ALLOW_RETURN_WRITES="true". No code path sets that, so the close can never fire
 * from automation. reviewRenter / sendOrderMessage remain gated by READ_ONLY_MODE
 * only.
 */
function returnWritesAllowed(): boolean {
  return process.env.ALLOW_RETURN_WRITES === "true";
}

/**
 * THIRD, INDEPENDENT gate — governs ONLY the operator's hand-typed renter
 * replies from the Reply Inbox dashboard widget (`sendManualRenterMessage`).
 *
 * Why a dedicated gate (Daniel, 2026-06-22): we want Daniel's manual,
 * per-message dashboard replies to go out LIVE while keeping READ_ONLY_MODE
 * ON so automation writes (auto-accept / decline / bot chat) stay blocked.
 * Flipping READ_ONLY_MODE off to enable chat would also unlock those. So this
 * verb is decoupled — it sends iff ALLOW_MANUAL_RENTER_SEND === "true",
 * regardless of READ_ONLY_MODE. ONLY convex/replyInbox_actions.sendRenterReply
 * (a public action invoked by a deliberate Send click) calls it; no cron or
 * scheduler ever does. Default ON in prod env; set to anything but "true" to
 * hard-disable manual sends without touching the rest of the system.
 */
function manualRenterSendAllowed(): boolean {
  return process.env.ALLOW_MANUAL_RENTER_SEND === "true";
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
 * Change a rental's dates. The order-detail `actions` map exposes this
 * capability under the key **`changeDates`**, but the REST dispatcher's
 * accepted action verb is **`selectDates`** (verified from the 422 zod-union
 * probe: `/home/ubuntu/hygglo-probe/out/disp_real_*.json` →
 * `Expected 'selectDates' | 'createNewRequest'`). There is NO `changeDates`
 * literal on the wire. Data fields confirmed required:
 *   { rentalStartDate: string, rentalEndDate: string }   (both ISO date strings)
 *
 * Endpoint (action-dispatcher pattern):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "selectDates", data: { rentalStartDate, rentalEndDate } }
 */
export async function changeOrderDates(args: {
  accountSlug: string;
  hyggloOrderId: string;
  rentalStartDate: string;
  rentalEndDate: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "selectDates",
      data: {
        rentalStartDate: args.rentalStartDate,
        rentalEndDate: args.rentalEndDate,
      },
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Change an order's price. Dispatcher action verb is the literal `changePrice`
 * (verified: `Invalid literal value, expected "changePrice"`). Data field:
 *   { price: number }   (number required)
 *
 * Endpoint (action-dispatcher pattern):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "changePrice", data: { price } }
 */
export async function changeOrderPrice(args: {
  accountSlug: string;
  hyggloOrderId: string;
  price: number;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "changePrice",
      data: { price: args.price },
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Remove an item from an order. Dispatcher action verb is the literal
 * `removeItem` (verified: `Invalid literal value, expected "removeItem"`).
 * Data field:
 *   { itemId: number }   (NUMBER required — probe sending a string itemId got
 *                         `Expected number, received string`. `productId`
 *                         belongs to the SEPARATE `addProduct` action, NOT to
 *                         `removeItem`, so it is intentionally omitted here.)
 *
 * Endpoint (action-dispatcher pattern):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "removeItem", data: { itemId } }
 */
export async function removeOrderItem(args: {
  accountSlug: string;
  hyggloOrderId: string;
  itemId: number;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "removeItem",
      data: { itemId: args.itemId },
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

/**
 * Operator-initiated renter reply from the Reply Inbox widget.
 *
 * Identical wire shape to sendMessage (PATCH /v4/my/orders/:id, action:"chat")
 * but behind its OWN gate (`manualRenterSendAllowed`, env
 * ALLOW_MANUAL_RENTER_SEND) and DECOUPLED from READ_ONLY_MODE — see the gate
 * doc above. Returns {status:"skipped", reason:"MANUAL_SEND_DISABLED"} when the
 * gate is off so the dashboard can surface "sending disabled" instead of
 * silently dropping the message. The Hygglo order id IS the chat thread id.
 */
export async function sendManualRenterMessage(args: {
  accountSlug: string;
  hyggloOrderId: string;
  text: string;
}): Promise<HyggloWriteResult> {
  if (!manualRenterSendAllowed())
    return { status: "skipped", reason: "MANUAL_SEND_DISABLED" };
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "chat",
      data: { message: args.text },
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Mark a rental returned / complete on the platform (the IRREVERSIBLE Hygglo
 * close, action:"return").
 *
 * POLICY (Daniel, 2026-06-17): the system must NEVER auto-close a rental. Daniel
 * closes each rental MANUALLY on Hygglo himself; our automation only fires the
 * 5★ rating + the discount text AFTER he has done so. This verb is therefore
 * HARD-BLOCKED behind its OWN gate (`ALLOW_RETURN_WRITES === "true"`), which is
 * INDEPENDENT of READ_ONLY_MODE: even with READ_ONLY_MODE=false it stays off
 * unless someone explicitly sets ALLOW_RETURN_WRITES. No code path sets it, and
 * the auto drain never calls this function — so the close can never fire from
 * automation. Kept only so a future supervised, opt-in tool could use it.
 */
export async function returnOrder(args: {
  accountSlug: string;
  hyggloOrderId: string;
}): Promise<HyggloWriteResult> {
  // Structural "never auto-close": dedicated gate, decoupled from READ_ONLY_MODE.
  if (!returnWritesAllowed())
    return { status: "skipped", reason: "RETURN_WRITES_DISABLED" };
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({ ...args, action: "return", data: {} });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Send a chat message to the renter (e.g. the post-rental thank-you + review
 * request). v1's sendMessage used the dispatcher verb `chat`. Gated like every
 * other write — skipped while READ_ONLY_MODE is on.
 */
export async function sendOrderMessage(args: {
  accountSlug: string;
  hyggloOrderId: string;
  text: string;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "chat",
      data: { message: args.text },
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

/**
 * Leave the OWNER's review/rating OF the renter (the post-return star rating
 * that unlocks only AFTER `return` advances the order — `actions.review` flips
 * `false -> true` once the order moves RETURNED -> REVIEWED).
 *
 * Dispatcher verb is the literal **`review`** (Phase-1 discovery: PATCH against
 * a fake id with `{action:"review"}` returns 404 NOT_FOUND, not the 422
 * invalid_union that bogus verbs get — so `review` IS a member of the action
 * union; `/tmp/hygglo_verb_discovery.md` §c).
 *
 * The `data` SHAPE is **CONFIRMED** (live probe 2026-06-16, order 3952944 after
 * close): the leaf of the deeply-nested dispatcher union requires
 * `data.rating: number` (1-5); `data.comment: string` is accepted (empty string
 * is allowed). `{ rating: 5, comment: "" }` returned HTTP 200 and submitted the
 * review; `{ rating: "x" }` (wrong type) stayed 422 with no mutation.
 *
 * The orchestrator (scripts/return-finalize.ts) STILL runs a SAFE empty-body
 * 422-probe first and parses the `["data","<field>"]` path out of the (pretty-
 * printed, multi-level invalid_union) error before submitting, so a future
 * field-shape change is caught rather than silently mis-sent. A 422 does NOT
 * mutate, so probing the real order is safe.
 *
 * Endpoint (action-dispatcher pattern):
 *   PATCH /v4/my/orders/:id?timezone=Europe/London
 *   body: { action: "review", data: <discovered shape, default {rating, comment}> }
 *
 * @param rating  star rating 1-5 (default 5 — owner is rating the renter).
 * @param comment optional free-text review left on the renter.
 * @param dataOverride when set, sent verbatim as the `data` payload instead of
 *        the default `{rating[, comment]}` — used by the orchestrator's
 *        discover-then-submit flow once the real field names are known, and to
 *        send the deliberate empty-body 422 probe (`{}`).
 */
export async function reviewRenter(args: {
  accountSlug: string;
  hyggloOrderId: string;
  rating?: number;
  comment?: string;
  dataOverride?: Record<string, unknown>;
}): Promise<HyggloWriteResult> {
  if (!writesAllowed()) return skipResult();
  const data: Record<string, unknown> =
    args.dataOverride ??
    (args.comment !== undefined
      ? { rating: args.rating ?? 5, comment: args.comment }
      : { rating: args.rating ?? 5 });
  try {
    return await patchOrderAction({
      accountSlug: args.accountSlug,
      hyggloOrderId: args.hyggloOrderId,
      action: "review",
      data,
    });
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
