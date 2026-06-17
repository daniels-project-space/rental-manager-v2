"use node";
/**
 * Rating+text drain (Phase 9, 2026-06-17 — POLICY REWORK).
 *
 * POLICY (Daniel, 2026-06-17): "ONLY THE RATING + TEXTS ARE ALLOWED, AND ONLY IF
 * I CLOSE THE RENTAL MANUALLY." The system must NEVER call the Hygglo close
 * (action:"return"). Daniel closes each rental MANUALLY on Hygglo himself. The
 * ONLY automated outbound is the 5★ rating (action:"review") + the follow-up
 * discount text (action:"chat"), and they fire ONLY AFTER Daniel has manually
 * closed the rental — detected from live Hygglo state, never by us closing it.
 *
 * This drain therefore NEVER imports or calls `returnOrder`. For every
 * `pendingPlatformClose` row it GETs the live Hygglo order and:
 *
 *   • NOT yet closed by Daniel (order's `actions.review` not available / still
 *     RETURNED:pending) ⇒ SKIP ("awaiting manual close"), leave the row pending,
 *     touch NOTHING. The forward step is still `return` (Daniel's job), so we wait.
 *   • Daniel HAS closed it (`actions.review === true` / step REVIEWED) ⇒ run the
 *     courtesy flow:
 *       1. 5★ REVIEW of the renter — reviewRenter(): action:"review"  (eligible only)
 *       2. discount-code chat text — sendOrderMessage(): action:"chat" (eligible only)
 *       3. STAMP review_done_at / msg_done_at / platform_closed_at — drops the row.
 *
 * ── DOUBLE GATE (read twice) ──────────────────────────────────────────────
 * The drain performs NO Hygglo write unless BOTH gates are open:
 *   • writesAllowed()  — `READ_ONLY_MODE !== "true"` (the chokepoint's own gate).
 *     PERMISSIVE-BY-DEFAULT: unset => writes ALLOWED.
 *   • AUTO_RATE_TEXT_ENABLED === "true" — a SECOND explicit gate owned by this
 *     drain. Default OFF, so even a mis-set READ_ONLY_MODE cannot fire the cron.
 * If either gate is closed (or dryRun is requested) the drain computes + returns
 * the planned actions and calls NO Hygglo verb and writes NO stamp ("GATED").
 *
 * The close verb is additionally HARD-BLOCKED at the chokepoint
 * (`ALLOW_RETURN_WRITES`, see src/lib/hygglo-write.ts), so even a future code
 * change here could not auto-close.
 *
 * Idempotency: per-step stamps (review_done_at / msg_done_at) plus the final
 * platform_closed_at make a partial-failure re-run safe — a completed step is
 * never repeated (never re-rate / re-spam).
 *
 * Open-Case exception: a reservation with `case_open` true (a disputed / damage
 * return) is NEVER touched — it is skipped and left pending.
 */
import { internalAction, action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
// NB: `returnOrder` is intentionally NOT imported — this drain must NEVER close.
import { reviewRenter, sendOrderMessage } from "../src/lib/hygglo-write";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";
import { isWithinUkQuietHours } from "./lib/quiet_hours";

const TZ = "Europe/London";
const REVIEW_COMMENT =
  "5/5 — great renter, looked after the gear and easy to deal with. Welcome back any time!";

/** Mirror of hygglo-write's gate so the drain can pre-check without a write. */
function writesAllowed(): boolean {
  return process.env.READ_ONLY_MODE !== "true";
}
/** Second explicit gate owned by this drain. Default OFF. Renamed from
 *  AUTO_CLOSE_ENABLED (Phase 9): the drain no longer closes — it only fires the
 *  rating + text after Daniel's manual close. */
function autoRateTextEnabled(): boolean {
  return process.env.AUTO_RATE_TEXT_ENABLED === "true";
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

type PlannedOrder = {
  reservationId: string;
  account_slug: string | null;
  hygglo_order_id: string | null;
  renter_outcome: string | null;
  // whether Daniel has manually closed the order on Hygglo (review unlocked):
  manuallyClosed: boolean | null; // null = not yet probed (plan-only)
  // planned actions for this order (only after manual close):
  willReview: boolean;
  willMessage: boolean;
  // already-done (idempotency) flags:
  alreadyReviewed: boolean;
  alreadyMessaged: boolean;
  // eligibility reasoning:
  reason: string;
  // execution result (non-dry, gates open only):
  result?: string;
};

/** Explicit return type — breaks the self/cross-reference type-inference cycle
 *  (drain -> ctx.runQuery(internal...) and adminDrainPendingClose -> drain). */
type DrainResult = {
  mode: string;
  gatesOpen: boolean;
  writesAllowed: boolean;
  autoRateTextEnabled: boolean;
  pendingCount: number;
  planned: PlannedOrder[];
};

/**
 * Core drain. internalAction so it can be a cron target and call internal
 * queries/mutations + the gated Hygglo chokepoint.
 *
 * @param dryRun       when true (or either gate closed) ⇒ plan only, no writes.
 * @param onlyOrders   restrict to these Hygglo order ids (supervised runs).
 * @param limit        cap the number of rows processed this pass.
 */
export const drain = internalAction({
  args: {
    dryRun: v.optional(v.boolean()),
    onlyOrders: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { dryRun, onlyOrders, limit }): Promise<DrainResult> => {
    const gatesOpen = writesAllowed() && autoRateTextEnabled();
    // GATED ⇒ behave exactly like dryRun (compute plan, touch nothing).
    const planOnly = dryRun === true || !gatesOpen;

    let rows = await ctx.runQuery(internal.reservations.pendingPlatformCloseInternal, {});
    if (onlyOrders && onlyOrders.length) {
      const want = new Set(onlyOrders.map(String));
      rows = rows.filter((r) => r.hygglo_order_id && want.has(String(r.hygglo_order_id)));
    }
    if (typeof limit === "number") rows = rows.slice(0, Math.max(0, limit));

    const mode = planOnly
      ? dryRun === true
        ? "DRY_RUN"
        : `GATED (READ_ONLY_MODE!=="true": ${writesAllowed()}, AUTO_RATE_TEXT_ENABLED: ${autoRateTextEnabled()})`
      : "LIVE";

    const planned: PlannedOrder[] = [];

    for (const r of rows) {
      const reservationId = String(r.reservationId);
      const accountSlug = r.account_slug ?? null;
      const hyggloOrderId = r.hygglo_order_id ?? null;

      // ── Open-Case exception: never touch a disputed rental ──
      if (r.case_open) {
        planned.push({
          reservationId,
          account_slug: accountSlug,
          hygglo_order_id: hyggloOrderId,
          renter_outcome: r.return_outcome,
          manuallyClosed: null,
          willReview: false,
          willMessage: false,
          alreadyReviewed: r.review_done_at != null,
          alreadyMessaged: r.msg_done_at != null,
          reason: "SKIP: case_open (disputed/damage return — never auto-rated)",
        });
        continue;
      }

      // ── Eligibility (mirrors markReturned's suppression rules) ──
      // 5★ review: NOT blacklisted/flagged AND outcome !== "issues".
      const reviewEligible =
        !r.blacklisted && !r.flagged && r.return_outcome !== "issues";
      // discount message: a prepared review_message exists (markReturned nulls it
      // for bad actors / non-good outcomes, so its presence IS the eligibility).
      const messageEligible = !!r.review_message;

      const alreadyReviewed = r.review_done_at != null;
      const alreadyMessaged = r.msg_done_at != null;

      const willReview = reviewEligible && !alreadyReviewed;
      const willMessage = messageEligible && !alreadyMessaged;

      const reasonBits = [
        `outcome=${r.return_outcome ?? "?"}`,
        `blacklisted=${r.blacklisted}`,
        `flagged=${r.flagged}`,
        `reviewEligible=${reviewEligible}${alreadyReviewed ? " (already)" : ""}`,
        `messageEligible=${messageEligible}${alreadyMessaged ? " (already)" : ""}`,
      ];

      const plan: PlannedOrder = {
        reservationId,
        account_slug: accountSlug,
        hygglo_order_id: hyggloOrderId,
        renter_outcome: r.return_outcome,
        manuallyClosed: null,
        willReview,
        willMessage,
        alreadyReviewed,
        alreadyMessaged,
        reason: reasonBits.join(", "),
      };

      // ── Probe live Hygglo state: has Daniel manually closed this order? ──
      // The trigger for the courtesy flow is "review action available" — that
      // only unlocks once the owner advances RETURNED -> (REVIEWED) by closing.
      // We do this even in plan-only / dry-run mode (it's a read-only GET) so the
      // plan honestly reports awaiting-manual-close vs would-fire. We NEVER close.
      if (!accountSlug || !hyggloOrderId) {
        plan.reason = "SKIP: missing account_slug or hygglo_order_id";
        plan.result = planOnly ? `${mode} (no writes)` : "SKIP: missing ids";
        if (!planOnly) {
          await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
            reservationId: r.reservationId,
            error: "missing account_slug or hygglo_order_id",
          });
        }
        planned.push(plan);
        continue;
      }
      const base = { accountSlug, hyggloOrderId };

      let reviewUnlocked = false;
      let probeError: string | null = null;
      try {
        const order = await getOrder(accountSlug, hyggloOrderId);
        reviewUnlocked = !!(order && order.actions && order.actions.review === true);
      } catch (e) {
        probeError = (e as Error).message.slice(0, 120);
      }
      plan.manuallyClosed = probeError ? null : reviewUnlocked;

      // NOT yet manually closed by Daniel ⇒ SKIP, leave row pending, touch nothing.
      if (probeError) {
        plan.reason = `SKIP: probe failed (${probeError}) — leave pending`;
        plan.result = "awaiting manual close (probe failed)";
        planned.push(plan);
        continue;
      }
      if (!reviewUnlocked) {
        plan.reason =
          "SKIP: awaiting manual close (Daniel has not closed on Hygglo — review action not yet available)";
        plan.result = "awaiting manual close — SKIP";
        planned.push(plan);
        continue;
      }

      // Daniel HAS closed it (review unlocked). In plan-only mode, report the
      // would-fire plan but write nothing.
      if (planOnly) {
        plan.result =
          (mode === "DRY_RUN" ? "dry-run" : "GATED") +
          ` (manual close detected; would: review=${willReview} msg=${willMessage}) — no writes`;
        planned.push(plan);
        continue;
      }

      // ── LIVE courtesy flow (both gates open, dryRun !== true, manual close confirmed) ──
      const steps: string[] = ["manual_close=confirmed"];

      // 1. 5★ REVIEW (eligible + not already) — confirmed shape {rating,comment} ──
      if (willReview) {
        const rev = await reviewRenter({ ...base, rating: 5, comment: REVIEW_COMMENT });
        steps.push(`review=${rev.status}${rev.httpStatus ? "/" + rev.httpStatus : ""}`);
        if (rev.status === "sent") {
          await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
            reservationId: r.reservationId,
            review_done_at: Date.now(),
          });
        } else {
          // Review failed; defer rating + message + final stamp to a later pass.
          // (We never closed — Daniel did; nothing to roll back.)
          plan.result = steps.join(" ") + " -> STOP (review failed), deferred";
          await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
            reservationId: r.reservationId,
            error: `review ${rev.status} ${rev.httpStatus ?? ""} ${rev.error ?? ""}`.trim(),
          });
          planned.push(plan);
          continue;
        }
      } else if (!reviewEligible) {
        steps.push("review=skip(ineligible)");
        // mark review step "done" so it isn't retried — ineligible is terminal.
        if (!alreadyReviewed) {
          await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
            reservationId: r.reservationId,
            review_done_at: Date.now(),
          });
        }
      } else {
        // alreadyReviewed (the only remaining case — manual close is confirmed,
        // so the review action is unlocked; "locked" is unreachable here).
        steps.push("review=skip(already)");
      }

      // 4. discount chat message (eligible + not already) — defer ONLY the message during quiet hours ──
      if (willMessage) {
        if (isWithinUkQuietHours()) {
          steps.push("msg=defer(quiet_hours)");
          // leave msg_done_at unset so a later (non-quiet) pass sends it; the
          // rating already fired, so the row stays pending until the message +
          // final stamp land. (We never closed — Daniel did that manually.)
          plan.result = steps.join(" ") + " -> message deferred to next non-quiet pass";
          planned.push(plan);
          continue;
        }
        const m = await sendOrderMessage({ ...base, text: r.review_message! });
        steps.push(`msg=${m.status}${m.httpStatus ? "/" + m.httpStatus : ""}`);
        if (m.status === "sent") {
          await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
            reservationId: r.reservationId,
            msg_done_at: Date.now(),
          });
        } else {
          plan.result = steps.join(" ") + " -> STOP (message failed), deferred";
          await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
            reservationId: r.reservationId,
            error: `msg ${m.status} ${m.httpStatus ?? ""} ${m.error ?? ""}`.trim(),
          });
          planned.push(plan);
          continue;
        }
      } else if (!messageEligible) {
        steps.push("msg=skip(ineligible)");
        if (!alreadyMessaged) {
          await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
            reservationId: r.reservationId,
            msg_done_at: Date.now(),
          });
        }
      } else {
        steps.push("msg=skip(already)");
      }

      // 5. FINAL STAMP — drops the row from pendingPlatformClose ──
      // markPlatformClosed is a PUBLIC mutation (the return-finalize CLI calls it
      // by name via the HTTP client), so it lives under `api`, not `internal`.
      await ctx.runMutation(api.reservations.markPlatformClosed, {
        reservationId: r.reservationId,
      });
      steps.push("closed_stamp=set");
      plan.result = steps.join(" ");
      planned.push(plan);
    }

    return {
      mode,
      gatesOpen,
      writesAllowed: writesAllowed(),
      autoRateTextEnabled: autoRateTextEnabled(),
      pendingCount: rows.length,
      planned,
    };
  },
});

/**
 * Public admin trigger for the rating+text drain — used for manual dry-runs and
 * supervised manual runs. It fires the 5★ rating + discount text ONLY for orders
 * Daniel has already manually closed on Hygglo; it NEVER closes. Auth: requires
 * AUTO_CLOSE_ADMIN_TOKEN to match (skip the check entirely if the env var is
 * unset, so a dry-run is runnable from the Convex dashboard). This wrapper NEVER
 * relaxes the two write gates (READ_ONLY_MODE + AUTO_RATE_TEXT_ENABLED) — it only
 * forwards to `drain`, which enforces them.
 */
export const adminDrainPendingClose = action({
  args: {
    dryRun: v.optional(v.boolean()),
    onlyOrders: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, { dryRun, onlyOrders, limit, token }): Promise<DrainResult> => {
    const expected = process.env.AUTO_CLOSE_ADMIN_TOKEN;
    if (expected && token !== expected) {
      throw new Error("unauthorized: AUTO_CLOSE_ADMIN_TOKEN mismatch");
    }
    return await ctx.runAction(internal.returns_autoclose.drain, {
      dryRun,
      onlyOrders,
      limit,
    });
  },
});
