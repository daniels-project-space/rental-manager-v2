"use node";
/**
 * Auto-close drain (Phase 8, 2026-06-17). Drains `pendingPlatformClose`: for
 * every rental marked returned in our system but not yet closed on Hygglo, runs
 * the verified full close flow through the SINGLE gated write chokepoint
 * (`src/lib/hygglo-write.ts`) — exactly the sequence proven by
 * `scripts/return-finalize.ts`:
 *
 *   1. CLOSE on Hygglo            — returnOrder(): action:"return" (irreversible)
 *   2. re-GET the order           — confirm `actions.review` unlocked
 *   3. 5★ REVIEW of the renter    — reviewRenter(): action:"review"  (eligible only)
 *   4. discount-code chat message — sendOrderMessage(): action:"chat" (eligible only)
 *   5. STAMP platform_closed_at   — markPlatformClosed mutation (final stamp)
 *
 * ── DOUBLE GATE (read twice) ──────────────────────────────────────────────
 * The drain performs NO Hygglo write unless BOTH gates are open:
 *   • writesAllowed()  — `READ_ONLY_MODE !== "true"` (the chokepoint's own gate).
 *     PERMISSIVE-BY-DEFAULT: unset => writes ALLOWED. So READ_ONLY_MODE must be
 *     explicitly set to "true" on the deployment.
 *   • AUTO_CLOSE_ENABLED === "true" — a SECOND explicit gate owned by this drain.
 *     Default OFF, so even a mis-set READ_ONLY_MODE cannot fire the cron.
 * If either gate is closed (or dryRun is requested) the drain computes + returns
 * the planned actions and calls NO Hygglo verb and writes NO stamp ("GATED").
 *
 * The cron (convex/crons.ts, every 5 min) calls this with dryRun:false. It is
 * safe because of the two gates: until a human flips BOTH, the cron is a no-op.
 *
 * Idempotency: per-step stamps (platform_returned_at / review_done_at /
 * msg_done_at) plus the final platform_closed_at make a partial-failure re-run
 * safe — a completed step is never repeated (never re-close / re-rate / re-spam).
 *
 * Open-Case exception: a reservation with `case_open` true (a disputed / damage
 * return) is NEVER auto-closed — it is skipped and left pending.
 */
import { internalAction, action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { v } from "convex/values";
import { returnOrder, reviewRenter, sendOrderMessage } from "../src/lib/hygglo-write";
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
function autoCloseEnabled(): boolean {
  return process.env.AUTO_CLOSE_ENABLED === "true";
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
  // planned actions for this order:
  willClose: boolean;
  willReview: boolean;
  willMessage: boolean;
  // already-done (idempotency) flags:
  alreadyReturned: boolean;
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
  autoCloseEnabled: boolean;
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
    const gatesOpen = writesAllowed() && autoCloseEnabled();
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
        : `GATED (READ_ONLY_MODE!=="true": ${writesAllowed()}, AUTO_CLOSE_ENABLED: ${autoCloseEnabled()})`
      : "LIVE";

    const planned: PlannedOrder[] = [];

    for (const r of rows) {
      const reservationId = String(r.reservationId);
      const accountSlug = r.account_slug ?? null;
      const hyggloOrderId = r.hygglo_order_id ?? null;

      // ── Open-Case exception: never auto-close a disputed rental ──
      if (r.case_open) {
        planned.push({
          reservationId,
          account_slug: accountSlug,
          hygglo_order_id: hyggloOrderId,
          renter_outcome: r.return_outcome,
          willClose: false,
          willReview: false,
          willMessage: false,
          alreadyReturned: r.platform_returned_at != null,
          alreadyReviewed: r.review_done_at != null,
          alreadyMessaged: r.msg_done_at != null,
          reason: "SKIP: case_open (disputed/damage return — never auto-closed)",
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

      const alreadyReturned = r.platform_returned_at != null;
      const alreadyReviewed = r.review_done_at != null;
      const alreadyMessaged = r.msg_done_at != null;

      const willClose = !alreadyReturned; // close is the irreversible first step
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
        willClose,
        willReview,
        willMessage,
        alreadyReturned,
        alreadyReviewed,
        alreadyMessaged,
        reason: reasonBits.join(", "),
      };

      if (planOnly) {
        plan.result = mode === "DRY_RUN" ? "dry-run (no writes)" : "GATED (no writes)";
        planned.push(plan);
        continue;
      }

      // ── LIVE execution (both gates open, dryRun !== true) ──
      if (!accountSlug || !hyggloOrderId) {
        plan.result = "SKIP: missing account_slug or hygglo_order_id";
        await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
          reservationId: r.reservationId,
          error: "missing account_slug or hygglo_order_id",
        });
        planned.push(plan);
        continue;
      }
      const base = { accountSlug, hyggloOrderId };
      const steps: string[] = [];

      // 1. CLOSE (skip if already returned per stamp) ──
      if (!alreadyReturned) {
        const c = await returnOrder(base);
        steps.push(`close=${c.status}${c.httpStatus ? "/" + c.httpStatus : ""}`);
        if (c.status !== "sent") {
          plan.result = steps.join(" ") + " -> STOP (close not sent), row stays pending";
          await ctx.runMutation(internal.reservations.recordAutoCloseFailure, {
            reservationId: r.reservationId,
            error: `close ${c.status} ${c.httpStatus ?? ""} ${c.error ?? ""}`.trim(),
          });
          planned.push(plan);
          continue;
        }
        await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
          reservationId: r.reservationId,
          platform_returned_at: Date.now(),
        });
      } else {
        steps.push("close=skip(already)");
      }

      // 2. re-GET to confirm review unlocked ──
      let reviewUnlocked = false;
      try {
        const order = await getOrder(accountSlug, hyggloOrderId);
        reviewUnlocked = !!(order && order.actions && order.actions.review === true);
        steps.push(`review_unlocked=${reviewUnlocked}`);
      } catch (e) {
        steps.push(`reget_failed=${(e as Error).message.slice(0, 80)}`);
      }

      // 3. 5★ REVIEW (eligible + unlocked + not already) — confirmed shape {rating,comment} ──
      if (willReview && reviewUnlocked) {
        const rev = await reviewRenter({ ...base, rating: 5, comment: REVIEW_COMMENT });
        steps.push(`review=${rev.status}${rev.httpStatus ? "/" + rev.httpStatus : ""}`);
        if (rev.status === "sent") {
          await ctx.runMutation(internal.reservations.stampAutoCloseStep, {
            reservationId: r.reservationId,
            review_done_at: Date.now(),
          });
        } else {
          // Close already advanced; defer rating + message + final stamp to a
          // later pass (close stamp persists so re-run won't re-close).
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
      } else if (alreadyReviewed) {
        steps.push("review=skip(already)");
      } else {
        steps.push("review=skip(locked)");
      }

      // 4. discount chat message (eligible + not already) — defer ONLY the message during quiet hours ──
      if (willMessage) {
        if (isWithinUkQuietHours()) {
          steps.push("msg=defer(quiet_hours)");
          // leave msg_done_at unset so a later (non-quiet) pass sends it; close +
          // rating already fired, so the row stays pending until the message + final stamp land.
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
      autoCloseEnabled: autoCloseEnabled(),
      pendingCount: rows.length,
      planned,
    };
  },
});

/**
 * Public admin trigger for the drain — used for manual dry-runs (and, later, a
 * supervised manual enable). Auth: requires AUTO_CLOSE_ADMIN_TOKEN to match
 * (skip the check entirely if the env var is unset, so a dry-run is runnable
 * from the Convex dashboard during this gated phase). This wrapper NEVER relaxes
 * the two write gates — it only forwards to `drain`, which enforces them.
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
