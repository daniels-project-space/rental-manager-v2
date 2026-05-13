/**
 * Wave 4.5 — ai_decision approval orchestrator.
 *
 * This module is the Node-side glue between:
 *   - Convex (decision rows + reservation + audit + MV refresh)
 *   - Hygglo HTTP API (the actual side effect, via `src/lib/hygglo-write.ts`)
 *
 * Why does this live in `src/mastra/data/` and NOT `convex/`?
 *   - The Convex `convex/` bundle cannot import from `src/lib/`. Splitting
 *     by responsibility:
 *       * `convex/ai_decisions.ts` owns DB rows (mutations + queries).
 *       * THIS file owns sequencing + Hygglo call + result fan-out.
 *       * `src/lib/hygglo-write.ts` is the ONLY caller of Hygglo's
 *         non-GET endpoints; everything else routes through here.
 *
 * READ_ONLY_MODE behaviour:
 *   - The write client returns `{ status: 'skipped', reason: 'READ_ONLY_MODE' }`
 *     without ever touching Hygglo.
 *   - `recordApproval` still runs (so we capture intent in the audit log)
 *     but `hygglo.attempted = false`.
 *   - The parent reservation row is NOT advanced to `confirmed` (the next
 *     poll cycle will re-evaluate when READ_ONLY_MODE is later disabled).
 */
import "server-only";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { getConvex, toError } from "./client";
import {
  acceptOrder,
  declineOrder,
  sendMessage,
  type HyggloWriteResult,
} from "../../lib/hygglo-write";

const KNOWN_ACCOUNTS = ["dbcinema", "leo"] as const;

export type DecisionId = Id<"ai_decision">;

export interface ApplyApprovalInput {
  /** Convex doc id OR short slug (last 6 chars). Resolved server-side. */
  decisionId: string;
  /** 'dashboard_chat' | 'daniel_telegram' (future). Recorded in audit. */
  actorSource: string;
  /**
   * If set, Daniel edited the AI's suggested reply. The text here is sent
   * to Hygglo (instead of the original draft) AND the action recorded as
   * 'approve_modified'. Omit to send the draft as-is.
   */
  modifyReply?: string;
  /**
   * Explicit decline. When true, we never call accept; we send the reply
   * as a polite decline message + mark the row as 'declined'. Used by
   * the chat tool when the user says "decline X".
   */
  forceDecline?: boolean;
  /** Reason string for decline. Defaults to suggestedReply. */
  declineReason?: string;
}

export interface ApplyApprovalResult {
  ok: boolean;
  decisionId: DecisionId;
  action: "approve" | "decline" | "approve_modified";
  newStatus: string;
  hygglo: HyggloWriteResult;
  reservationAdvanced: boolean;
  mvRefreshes: Array<{ mv: string; ok: boolean; error?: string }>;
  error?: string;
}

/** Resolve a (possibly short) id slug to a canonical `ai_decision` doc id. */
async function resolveDecisionId(input: string): Promise<DecisionId | null> {
  const convex = getConvex();
  // If it looks like a full Convex id (longer than the short slug), trust it.
  if (input.length > 10) return input as DecisionId;
  // Otherwise resolve.
  const resolved = await convex.query(api.ai_decisions.resolveShortId, {
    shortId: input,
  });
  return (resolved as DecisionId | null) ?? null;
}

/**
 * Fan out per-account MV refreshes after a successful approval.
 *
 * The polling workflow's refresh dispatcher (`convex/mv/refresh_dispatch.ts`)
 * is the canonical entrypoint. We invoke it for the three MVs that depend
 * on `reservations`/`ai_decision` state — daily_briefing, upcoming_returns,
 * purchase_signals — scoped to the affected account.
 */
async function refreshMVsForAccount(
  account: string,
): Promise<ApplyApprovalResult["mvRefreshes"]> {
  const MVS = ["daily_briefing", "upcoming_returns", "purchase_signals"] as const;
  const convex = getConvex();
  const out: ApplyApprovalResult["mvRefreshes"] = [];
  for (const mv of MVS) {
    try {
      const res = (await convex.action(api.mv.refresh_dispatch.refreshOne, {
        mvName: mv,
        account,
      })) as { ok: boolean; error?: string };
      out.push({ mv, ok: !!res?.ok, error: res?.error });
    } catch (err) {
      out.push({ mv, ok: false, error: toError(err) });
    }
  }
  return out;
}

/**
 * Apply one approval action end-to-end.
 *
 * Flow:
 *   1. Resolve decisionId (short slug ok).
 *   2. Fetch decision + reservation (so we have account_slug, order id, etc).
 *   3. Decide action: approve / decline / approve_modified.
 *   4. Call Hygglo write client (skipped if READ_ONLY_MODE).
 *   5. Convex `recordApproval` mutation → updates status, writes audit,
 *      conditionally advances reservation status.
 *   6. Fan-out MV refreshes (best-effort).
 */
export async function applyApproval(
  input: ApplyApprovalInput,
): Promise<ApplyApprovalResult> {
  const convex = getConvex();

  const resolvedId = await resolveDecisionId(input.decisionId);
  if (!resolvedId) {
    return {
      ok: false,
      decisionId: input.decisionId as DecisionId,
      action: "approve",
      newStatus: "pending",
      hygglo: { status: "skipped", reason: undefined as never },
      reservationAdvanced: false,
      mvRefreshes: [],
      error: `decisionId not found or ambiguous: ${input.decisionId}`,
    };
  }

  const ctx = await convex.query(api.ai_decisions.getForApproval, {
    decisionId: resolvedId,
  });
  if (!ctx || !ctx.decision) {
    return {
      ok: false,
      decisionId: resolvedId,
      action: "approve",
      newStatus: "pending",
      hygglo: { status: "skipped", reason: undefined as never },
      reservationAdvanced: false,
      mvRefreshes: [],
      error: "decision row missing",
    };
  }
  const { decision, reservation } = ctx;

  // Validate account_slug
  if (!KNOWN_ACCOUNTS.includes(decision.account_slug as (typeof KNOWN_ACCOUNTS)[number])) {
    return {
      ok: false,
      decisionId: resolvedId,
      action: "approve",
      newStatus: "pending",
      hygglo: { status: "skipped", reason: undefined as never },
      reservationAdvanced: false,
      mvRefreshes: [],
      error: `unknown account_slug: ${decision.account_slug}`,
    };
  }

  const hyggloOrderId =
    decision.hygglo_order_id ?? reservation?.hygglo_order_id ?? null;

  // Compute action label.
  const action: "approve" | "decline" | "approve_modified" = input.forceDecline
    ? "decline"
    : input.modifyReply
      ? "approve_modified"
      : "approve";

  const finalReply =
    input.modifyReply ?? decision.suggestedReply ?? undefined;

  // ── Side effect ──────────────────────────────────────────────
  let hyggloResult: HyggloWriteResult;
  if (action === "decline") {
    if (!hyggloOrderId) {
      hyggloResult = {
        status: "failed",
        error: "decline requested but reservation has no hygglo_order_id",
      };
    } else {
      hyggloResult = await declineOrder({
        accountSlug: decision.account_slug,
        hyggloOrderId,
        reason: input.declineReason ?? finalReply ?? "Declined by owner.",
      });
    }
  } else {
    // approve / approve_modified: accept the order, then (if a reply exists)
    // send the message body to the renter's thread.
    if (!hyggloOrderId) {
      hyggloResult = {
        status: "failed",
        error: "approve requested but reservation has no hygglo_order_id",
      };
    } else {
      const acceptRes = await acceptOrder({
        accountSlug: decision.account_slug,
        hyggloOrderId,
      });
      hyggloResult = acceptRes;
      // Only fire message send if accept actually succeeded (status='sent')
      // and there is a reply to send. Skip when accept was skipped/failed.
      if (acceptRes.status === "sent" && finalReply) {
        const msgRes = await sendMessage({
          accountSlug: decision.account_slug,
          conversationId: hyggloOrderId,
          text: finalReply,
        });
        // Surface message-send failure but don't undo the accept.
        if (msgRes.status === "failed") {
          hyggloResult = {
            ...acceptRes,
            error: `accepted but message send failed: ${msgRes.error ?? "<unknown>"}`,
          };
        }
      }
    }
  }

  // ── Persist audit + status atomically ────────────────────────
  const record = (await convex.mutation(api.ai_decisions.recordApproval, {
    decisionId: resolvedId,
    action,
    actorSource: input.actorSource,
    finalReply,
    hygglo: {
      attempted: hyggloResult.status !== "skipped",
      status: hyggloResult.status,
      error: hyggloResult.error,
      httpStatus: hyggloResult.httpStatus,
    },
  })) as {
    ok: boolean;
    newStatus: string;
    reservationAdvanced: boolean;
    account_slug: string;
  };

  // ── Fan out MV refreshes (only if the side effect actually fired) ──
  const mvRefreshes =
    hyggloResult.status === "sent"
      ? await refreshMVsForAccount(record.account_slug)
      : [];

  return {
    ok: true,
    decisionId: resolvedId,
    action,
    newStatus: record.newStatus,
    hygglo: hyggloResult,
    reservationAdvanced: record.reservationAdvanced,
    mvRefreshes,
  };
}

/**
 * Wave 4.5 — chat-friendly read tool backing.
 *
 * Returns up to N pending decisions with short ids so the chat agent can
 * tell the user "approve abc123".
 */
export async function getPendingDecisions(input?: {
  account?: "dbcinema" | "leo";
  limit?: number;
}) {
  const convex = getConvex();
  const rows = await convex.query(api.ai_decisions.getPendingForUI, {
    account: input?.account,
    limit: input?.limit ?? 20,
  });
  return { ok: true, count: rows.length, decisions: rows };
}
