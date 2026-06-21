"use node";
/**
 * Operator-triggered per-reservation Hygglo close (Phase 6 / T1 backend rework,
 * 2026-06-21).
 *
 * ── POLICY (Daniel, 2026-06-21) ───────────────────────────────────────────
 * NO cron, NO background auto-anything. The Return Hub rating tap is the SINGLE
 * trigger: tapping 🟢 Smooth / 🏆 Fantastic / 🔴 Issues marks the rental returned
 * AND closes it on Hygglo in ONE operator action.
 *
 *   • 🟢 Smooth / 🏆 Fantastic (green) ⇒ close + 5★ review + discount text.
 *   • 🔴 Issues (not green)            ⇒ close ONLY (no 5★, no discount text).
 *
 * The dashboard calls the single public action `finalizeReturn` (args identical
 * to `reservations.markReturned`). It runs `markReturned`, reads the resulting
 * `return_outcome` + `review_message` back off the reservation, computes
 * `green`, then runs the shared `finalizeReservationClose` helper.
 *
 * ── GATES (unchanged, enforced at the chokepoint in src/lib/hygglo-write.ts) ──
 * The irreversible close verb `returnOrder` stays HARD-GATED behind
 *   READ_ONLY_MODE !== "true"  AND  ALLOW_RETURN_WRITES === "true".
 * With ALLOW_RETURN_WRITES unset (the safe deploy state) `returnOrder` returns
 * {status:"skipped"}, so `finalizeReturn` marks the rental returned then no-ops
 * the platform close — INERT until go-live flips the flag. reviewRenter /
 * sendOrderMessage stay behind READ_ONLY_MODE (permissive-by-default).
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────
 * `finalizeReservationClose` is safe to re-run. Already-closed detection is
 * robust to EVERY terminal state of the Hygglo action-machine
 * (RENTED → RETURNED → REVIEWED), guarding against the `actions` map being null:
 *   • local platform_returned_at / platform_closed_at already stamped, OR
 *   • live order's `return` action no longer available, which splits into:
 *       – `actions.review === true` (MIDDLE state: closed but not yet reviewed)
 *         ⇒ close SKIPPED, but a green order still fires the 5★ + discount, OR
 *       – neither return nor review available (TERMINAL: already REVIEWED, e.g.
 *         `actions` is null) ⇒ skip the close AND the courtesy flow; stamp it
 *         closed LOCALLY only — NO Hygglo write (a `returnOrder` here would 500
 *         with ACTION_NOT_ALLOWED).
 *   • Per-step stamps (platform_returned_at, review_done_at, msg_done_at) plus the
 *     final platform_closed_at mean a partial-failure re-run never repeats a
 *     completed step (never re-close / re-rate / re-spam).
 *
 * ── OPEN-CASE / BAD-ACTOR ─────────────────────────────────────────────────
 * A disputed/damage return (`case_open`) is never rated/texted. Review fires only
 * for green + eligible (not blacklisted/flagged). The discount text fires only
 * when `review_message` was staged by markReturned (its presence IS eligibility —
 * markReturned nulls it for bad actors / non-good outcomes) AND green.
 *
 * `adminBackfillClose` is a MANUAL (non-scheduled, token-guarded) batch that runs
 * the same shared helper over every currently-pending row — a one-time backfill
 * for rentals already marked returned before this rework (e.g. James 3991399). It
 * is referenced by NO cron.
 */
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
// `returnOrder` is the irreversible Hygglo close (action:"return"). It is
// HARD-GATED at the chokepoint behind ALLOW_RETURN_WRITES (decoupled from
// READ_ONLY_MODE). With the flag OFF it returns {status:"skipped"} — finalizeReturn
// marks the rental returned then no-ops the close, fully inert until go-live.
import { reviewRenter, sendOrderMessage, returnOrder } from "../src/lib/hygglo-write";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

const TZ = "Europe/London";
const REVIEW_COMMENT =
  "5/5 — great renter, looked after the gear and easy to deal with. Welcome back any time!";

/** Mirror of hygglo-write's READ_ONLY_MODE gate so the helper can pre-check
 *  without a write. PERMISSIVE-BY-DEFAULT: unset => writes ALLOWED. */
function writesAllowed(): boolean {
  return process.env.READ_ONLY_MODE !== "true";
}
/** Mirror of hygglo-write's PRIVATE returnWritesAllowed(). Dedicated,
 *  decoupled-from-READ_ONLY_MODE gate for the irreversible close (action:"return").
 *  Default OFF (unset => false). returnOrder() enforces the same gate at the
 *  chokepoint, so this mirror is a legibility/short-circuit pre-check only — it can
 *  never RELAX the real gate, only avoid a no-op call when off. */
function returnWritesAllowed(): boolean {
  return process.env.ALLOW_RETURN_WRITES === "true";
}

/** Read-only GET of a single Hygglo order (to confirm the review unlock). */
async function getOrder(accountSlug: string, hyggloOrderId: string): Promise<any> {
  const creds = await getAccountCredentials(accountSlug);
  const token = await getHyggloAccessToken({ ...creds, accountSlug });
  const res = await fetch(
    `${HYGGLO_API_BASE}/v4/my/orders/${encodeURIComponent(hyggloOrderId)}?timezone=${encodeURIComponent(TZ)}`,
    { headers: hyggloAuthHeaders(token) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`GET order ${hyggloOrderId} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Per-step outcome of finalizeReservationClose. */
type CloseStepResult = {
  closed: "sent" | "skipped" | "failed";
  reviewed: "sent" | "skipped" | "n/a";
  messaged: "sent" | "skipped" | "n/a";
  error?: string;
};

/** A pending-close row as resolved by pendingPlatformCloseInternal. */
type PendingRow = {
  reservationId: string;
  account_slug?: string | null;
  hygglo_order_id?: string | null;
  review_message?: string | null;
  return_outcome?: string | null;
  case_open?: boolean;
  blacklisted?: boolean;
  flagged?: boolean;
  platform_returned_at?: number | null;
  review_done_at?: number | null;
  msg_done_at?: number | null;
};

/**
 * SHARED HELPER — the single source of truth for closing ONE reservation on
 * Hygglo and (when green) running the courtesy flow. IDEMPOTENT.
 *
 * Looks the row up via pendingPlatformCloseInternal (same resolution as the old
 * drain) so account_slug / hygglo_order_id / review_message / outcome / bad-actor
 * flags / per-step stamps all come from one place. If the row is no longer pending
 * (already fully closed) it is a no-op (closed:"skipped").
 *
 *   green=true  ⇒ close + (eligible) 5★ review + (eligible) discount text.
 *   green=false ⇒ close ONLY (no review, no message).
 *
 * Returns per-step status. Stamps via the existing internal mutations.
 */
async function finalizeReservationClose(
  ctx: any,
  { reservationId, green }: { reservationId: string; green: boolean },
): Promise<CloseStepResult> {
  const rows: PendingRow[] = await ctx.runQuery(
    internal.reservations.pendingPlatformCloseInternal,
    {},
  );
  const r = rows.find((x) => String(x.reservationId) === String(reservationId));

  // Not in the pending feed ⇒ already fully closed (platform_closed_at set) or
  // never eligible. Idempotent no-op.
  if (!r) {
    return { closed: "skipped", reviewed: "n/a", messaged: "n/a" };
  }

  // Open-case: disputed/damage return — never close/rate/text here.
  if (r.case_open) {
    return {
      closed: "skipped",
      reviewed: "n/a",
      messaged: "n/a",
      error: "case_open (disputed/damage return — left pending)",
    };
  }

  const accountSlug = r.account_slug ?? null;
  const hyggloOrderId = r.hygglo_order_id ?? null;
  if (!accountSlug || !hyggloOrderId) {
    await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
      reservationId,
      error: "missing account_slug or hygglo_order_id",
    });
    return {
      closed: "skipped",
      reviewed: "n/a",
      messaged: "n/a",
      error: "missing account_slug or hygglo_order_id",
    };
  }
  const base = { accountSlug, hyggloOrderId };

  // ── 1. CLOSE (idempotent) ───────────────────────────────────────────────
  // Already-closed detection avoids a double close — robust to ALL terminal
  // states of the Hygglo order action-machine (RENTED → RETURNED → REVIEWED).
  //
  // The live order exposes an `actions` map that walks the machine forward
  // (hygglo-write.ts: "actions.review flips false→true once the order moves
  // RETURNED→REVIEWED"). `actions` can be NULL (no action available — happens in
  // the fully-resolved REVIEWED state), so EVERY access must be null-guarded:
  //   • actions.return === true  ⇒ NOT closed yet (return action available).
  //   • actions.review === true  ⇒ closed-but-NOT-reviewed (return consumed,
  //                                 review unlocked) — the MIDDLE state: a green
  //                                 order should still fire the 5★ + discount.
  //   • neither available (actions null / both falsy) AFTER a successful probe
  //     ⇒ FULLY RESOLVED (already returned AND already reviewed) — skip the
  //       close, the review AND the message; just stamp it closed locally so it
  //       drops from the pending feed. (James 3991399: already closed+reviewed
  //       on Hygglo ⇒ a `returnOrder` here 500s with ACTION_NOT_ALLOWED.)
  //
  // Detection sources, in order of trust:
  //   • local platform_returned_at already stamped (a prior run sent the close), OR
  //   • the live order says return is no longer available (reviewUnlocked OR
  //     fullyResolved) ⇒ the close already happened on Hygglo.
  let reviewUnlocked = false; // closed but review still pending (MIDDLE state)
  let fullyResolved = false; // closed AND reviewed already (TERMINAL state)
  let closeStatus: CloseStepResult["closed"];

  let alreadyClosed = r.platform_returned_at != null;
  if (!alreadyClosed) {
    try {
      const order = await getOrder(accountSlug, hyggloOrderId);
      const actions = order?.actions ?? null; // NB: may be null when REVIEWED
      const returnAvailable = actions?.return === true; // close not yet done
      reviewUnlocked = actions?.review === true; // closed, review pending
      // Fully resolved = a successful probe showed NEITHER return NOR review
      // available ⇒ the order has already advanced past REVIEWED. (Only trust
      // this from a probe that actually returned an order object.)
      fullyResolved = !!order && !returnAvailable && !reviewUnlocked;
      // Any non-`returnAvailable` terminal state means the close already
      // happened — never re-issue `returnOrder`.
      alreadyClosed = reviewUnlocked || fullyResolved;
    } catch (e) {
      // probe failed and not previously stamped — attempt the close below.
      reviewUnlocked = false;
      fullyResolved = false;
    }
  }

  // FULLY RESOLVED (already closed AND reviewed on Hygglo): no Hygglo write of
  // any kind. Stamp every step + the final close LOCALLY so the row drops from
  // pendingPlatformClose, and report it skipped-because-already-reviewed.
  if (fullyResolved) {
    await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
      reservationId,
      platform_returned_at: r.platform_returned_at ?? Date.now(),
      review_done_at: r.review_done_at ?? Date.now(),
      msg_done_at: r.msg_done_at ?? Date.now(),
    });
    await ctx.runMutation(api.reservations.markPlatformClosed, { reservationId });
    return {
      closed: "skipped",
      reviewed: "skipped",
      messaged: "skipped",
      error: "already-closed-reviewed",
    };
  }

  if (alreadyClosed) {
    closeStatus = "skipped"; // no double close (closed, review still pending)
  } else {
    const cl = await returnOrder({ ...base });
    if (cl.status === "sent") {
      // CLOSE-FIRST → STAMP: stamp platform_returned_at immediately so a crash
      // before the courtesy flow can never re-fire the irreversible close.
      await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
        reservationId,
        platform_returned_at: Date.now(),
      });
      closeStatus = "sent";
    } else {
      // skipped (gate off) or failed ⇒ do NOT stamp closed, do NOT proceed to
      // review/text. With ALLOW_RETURN_WRITES unset this is the safe inert path.
      if (cl.status === "failed") {
        await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
          reservationId,
          error: `close failed ${cl.httpStatus ?? ""} ${cl.error ?? ""}`.trim(),
        });
      }
      return {
        closed: cl.status === "failed" ? "failed" : "skipped",
        reviewed: "n/a",
        messaged: "n/a",
        error:
          cl.status === "skipped"
            ? (cl.reason ?? "RETURN_WRITES_DISABLED")
            : (cl.error ?? "close failed"),
      };
    }
  }

  // ── Re-probe so actions.review is unlocked for the courtesy flow ──────────
  // Only needed when we just sent the close (already-closed path saw it unlocked,
  // or we'll best-effort confirm). On re-probe failure we still proceed for green
  // since the close is confirmed; review may simply fail and be retried.
  if (closeStatus === "sent" || (alreadyClosed && !reviewUnlocked)) {
    try {
      const order2 = await getOrder(accountSlug, hyggloOrderId);
      reviewUnlocked = order2?.actions?.review === true;
    } catch {
      // leave reviewUnlocked as-is; review step will report its own status.
    }
  }

  // ── NOT green (🔴 Issues): close ONLY. No review, no message. ─────────────
  if (!green) {
    // Mark the courtesy steps done so a later backfill never rates/texts an
    // issues return, then drop the row.
    await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
      reservationId,
      review_done_at: r.review_done_at ?? Date.now(),
      msg_done_at: r.msg_done_at ?? Date.now(),
    });
    await ctx.runMutation(api.reservations.markPlatformClosed, { reservationId });
    return { closed: closeStatus, reviewed: "n/a", messaged: "n/a" };
  }

  // ── 2. COURTESY FLOW (green only) ─────────────────────────────────────────
  // Eligibility mirrors the old drain: review for not-blacklisted/flagged +
  // outcome !== "issues"; message when a review_message was staged by markReturned.
  const reviewEligible =
    !r.blacklisted && !r.flagged && r.return_outcome !== "issues";
  const messageEligible = !!r.review_message;
  const alreadyReviewed = r.review_done_at != null;
  const alreadyMessaged = r.msg_done_at != null;

  let reviewed: CloseStepResult["reviewed"] = "n/a";
  let messaged: CloseStepResult["messaged"] = "n/a";
  let stepError: string | undefined;

  // 2a. 5★ review.
  if (reviewEligible && !alreadyReviewed) {
    if (reviewUnlocked) {
      const rev = await reviewRenter({ ...base, rating: 5, comment: REVIEW_COMMENT });
      if (rev.status === "sent") {
        await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
          reservationId,
          review_done_at: Date.now(),
        });
        reviewed = "sent";
      } else {
        reviewed = "skipped";
        stepError = `review ${rev.status} ${rev.httpStatus ?? ""} ${rev.error ?? ""}`.trim();
        if (rev.status === "failed") {
          await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
            reservationId,
            error: stepError,
          });
        }
      }
    } else {
      // close confirmed but review action not yet unlocked (re-probe lag) —
      // leave review_done_at unset so a backfill retries; do NOT drop the row.
      reviewed = "skipped";
      stepError = "review action not yet unlocked";
    }
  } else if (!reviewEligible) {
    // terminal-ineligible: stamp done so it isn't retried.
    if (!alreadyReviewed) {
      await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
        reservationId,
        review_done_at: Date.now(),
      });
    }
    reviewed = "skipped";
  } else {
    reviewed = "skipped"; // alreadyReviewed
  }

  // 2b. discount text.
  if (messageEligible && !alreadyMessaged) {
    const m = await sendOrderMessage({ ...base, text: r.review_message! });
    if (m.status === "sent") {
      await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
        reservationId,
        msg_done_at: Date.now(),
      });
      messaged = "sent";
    } else {
      messaged = "skipped";
      const me = `msg ${m.status} ${m.httpStatus ?? ""} ${m.error ?? ""}`.trim();
      stepError = stepError ? `${stepError}; ${me}` : me;
      if (m.status === "failed") {
        await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
          reservationId,
          error: me,
        });
      }
    }
  } else if (!messageEligible) {
    if (!alreadyMessaged) {
      await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
        reservationId,
        msg_done_at: Date.now(),
      });
    }
    messaged = "skipped";
  } else {
    messaged = "skipped"; // alreadyMessaged
  }

  // ── 3. FINAL STAMP — drop the row from pendingPlatformClose ────────────────
  // Only drop when no live step FAILED (a failed send leaves the row pending so a
  // backfill can retry that one step). A "skipped" (ineligible / already / unlock-
  // lag) is terminal-or-retriable-without-row-drop-needed; but to be conservative
  // we drop only when neither review nor message is in an actionable-failed state.
  const reviewFailedRetriable =
    reviewEligible && !alreadyReviewed && reviewed !== "sent";
  const msgFailedRetriable =
    messageEligible && !alreadyMessaged && messaged !== "sent";
  if (!reviewFailedRetriable && !msgFailedRetriable) {
    await ctx.runMutation(api.reservations.markPlatformClosed, { reservationId });
  }

  return {
    closed: closeStatus,
    reviewed,
    messaged,
    ...(stepError ? { error: stepError } : {}),
  };
}

/**
 * PUBLIC ACTION `finalizeReturn` — the SINGLE entry the Return Hub dashboard
 * calls when an operator taps a rating chip. Args are IDENTICAL to
 * `reservations.markReturned` (mirrored below).
 *
 * Flow: markReturned(args) → read back return_outcome + review_message →
 * green = outcome ∈ {smooth, fantastic} → finalizeReservationClose({reservationId, green}).
 *
 * ── FRONTEND CONTRACT ─────────────────────────────────────────────────────
 *   path:    api.returns_autoclose.finalizeReturn
 *   args:    EXACTLY reservations.markReturned's args (reservationId required;
 *            condition required; the rest optional — see validator below).
 *   returns: { ok: boolean, closed: "sent"|"skipped"|"failed",
 *              reviewed: "sent"|"skipped"|"n/a", messaged: "sent"|"skipped"|"n/a",
 *              error?: string }
 *
 * Inert while ALLOW_RETURN_WRITES is unset: markReturned runs, then the close is
 * skipped (returnOrder → {status:"skipped"}) so closed:"skipped" and no courtesy
 * write fires. Go-live flips the flag (separate supervised step).
 */
export const finalizeReturn = action({
  // Mirror of reservations.markReturned's validator.
  args: {
    reservationId: v.id("reservations"),
    condition: v.string(),
    notes: v.optional(v.string()),
    issueDetails: v.optional(v.string()),
    blacklistRenter: v.optional(v.boolean()),
    blacklistReason: v.optional(v.string()),
    flagOnRequest: v.optional(v.boolean()),
    whitelist: v.optional(v.boolean()),
    whitelistReason: v.optional(v.string()),
    outcome: v.optional(v.string()),
    sendReview: v.optional(v.boolean()),
    goodTags: v.optional(v.array(v.string())),
    badTags: v.optional(v.array(v.string())),
    memberIds: v.optional(v.array(v.id("reservations"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean } & CloseStepResult> => {
    const reservationId = args.reservationId;

    // 1. Mark returned (CRM saves, status=completed, stage review_message, etc.).
    await ctx.runMutation(api.reservations.markReturned, args);

    // 2. Read back the resulting outcome + staged message off the pending feed
    //    (the same resolution the close helper uses, so green is consistent).
    const rows: PendingRow[] = await ctx.runQuery(
      internal.reservations.pendingPlatformCloseInternal,
      {},
    );
    const row = rows.find((x) => String(x.reservationId) === String(reservationId));
    const outcome = row?.return_outcome ?? args.outcome ?? null;
    const green = outcome === "smooth" || outcome === "fantastic";

    // 3. Close (+ courtesy flow if green) through the shared helper.
    const result = await finalizeReservationClose(ctx, { reservationId, green });

    return { ok: result.closed !== "failed", ...result };
  },
});

/**
 * MANUAL backfill batch (NOT scheduled — referenced by no cron). One-time close
 * of rentals already marked returned before the 2026-06-21 rework (e.g. James
 * 3991399). Iterates the pending feed and runs the shared helper per row, with
 * green computed from each row's return_outcome.
 *
 * Auth: requires AUTO_CLOSE_ADMIN_TOKEN to match (skipped if the env var is unset,
 * so a dry inspection is runnable from the Convex dashboard). Never relaxes the
 * write gates — the shared helper enforces them via the chokepoint.
 *
 *   onlyOrders — optional Hygglo-order-id allowlist to scope a supervised run.
 *   limit      — optional cap on rows processed this pass.
 */
export const adminBackfillClose = action({
  args: {
    onlyOrders: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    token: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { onlyOrders, limit, token },
  ): Promise<{
    processed: number;
    results: Array<{ reservationId: string; green: boolean } & CloseStepResult>;
  }> => {
    const expected = process.env.AUTO_CLOSE_ADMIN_TOKEN;
    if (expected && token !== expected) {
      throw new Error("unauthorized: AUTO_CLOSE_ADMIN_TOKEN mismatch");
    }

    let rows: PendingRow[] = await ctx.runQuery(
      internal.reservations.pendingPlatformCloseInternal,
      {},
    );
    if (onlyOrders && onlyOrders.length) {
      const want = new Set(onlyOrders.map(String));
      rows = rows.filter((r) => r.hygglo_order_id && want.has(String(r.hygglo_order_id)));
    }
    if (typeof limit === "number") rows = rows.slice(0, Math.max(0, limit));

    const results: Array<{ reservationId: string; green: boolean } & CloseStepResult> = [];
    for (const r of rows) {
      const reservationId = String(r.reservationId);
      const green =
        r.return_outcome === "smooth" || r.return_outcome === "fantastic";
      const res = await finalizeReservationClose(ctx, { reservationId, green });
      results.push({ reservationId, green, ...res });
    }
    return { processed: rows.length, results };
  },
});
