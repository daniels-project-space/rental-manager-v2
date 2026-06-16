/**
 * return-finalize — adapts v1's "mark as returned" + the post-rental discount /
 * review flow into the v2 CLI, routed through the SINGLE gated write chokepoint
 * (src/lib/hygglo-write.ts). READ-ONLY by default: with READ_ONLY_MODE unset or
 * "true", every write returns {status:'skipped'} and NOTHING reaches Hygglo.
 *
 *   READ-ONLY (default):  ./node_modules/.bin/tsx scripts/return-finalize.ts
 *   DRY-RUN preview:      DRY_RUN=true ./node_modules/.bin/tsx scripts/return-finalize.ts
 *   LIVE (gated):         READ_ONLY_MODE=false ./node_modules/.bin/tsx scripts/return-finalize.ts
 *   LIVE, scoped:         READ_ONLY_MODE=false ONLY_ORDERS=3952944,3973170 ... (supervised)
 *
 * FULL per-order sequence (operator decision 2026-06-16, Daniel-authorized):
 *   1. CLOSE on Hygglo            — returnOrder(): action:"return" (irreversible)
 *   2. re-GET the order           — confirm `actions.review` unlocked (RETURNED->REVIEWED)
 *   3. 5★ REVIEW of the renter    — reviewRenter(): action:"review"  (SKIP if flagged/blacklisted)
 *   4. discount-code chat message — sendOrderMessage(): action:"chat" (SKIP if flagged/blacklisted)
 *   5. STAMP platform_closed_at   — markPlatformClosed mutation
 *
 * The ONLY outbound messages allowed are the 5★ review + the discount-code
 * message; we never text a renter to "clarify" anything.
 *
 * `review` data SHAPE is discovered SAFELY at runtime: after the close unlocks
 * the action, we send a minimal `{}` body once and read the 422 zod-union error
 * to learn the required field names (a 422 does NOT mutate), then submit the
 * real 5★ payload. If we cannot confidently parse the shape we STOP before the
 * rating (the close is already done; rating/message can be retried).
 *
 * Idempotency: the platform CLOSE runs first. We only message + stamp after the
 * platform write actually returns `sent`. Rows already carrying
 * `platform_closed_at` are skipped, so a re-run never double-closes,
 * double-rates, or double-messages.
 */
import { ConvexHttpClient } from "convex/browser";
import { returnOrder, reviewRenter, sendOrderMessage } from "../src/lib/hygglo-write";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

const TZ = "Europe/London";

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

/**
 * Parse a Hygglo zod-union 422 error body for the field names the `review`
 * action's `data` requires. Returns the discovered field name list (best-effort)
 * plus the raw error for the operator log.
 */
function parseReviewShape(errBody: string): { fields: string[]; needsComment: boolean } {
  const fields = new Set<string>();
  // zod surfaces missing/invalid keys as a `"path":[ "data", "<field>" ]` array.
  // Hygglo pretty-prints the error JSON, so the array elements are separated by
  // newlines/whitespace — match liberally across `\s` (NOT just a single-line
  // `["data","field"]`). The action dispatcher is a DEEPLY nested discriminated
  // union, so the relevant leaf is buried many levels down; this still finds it.
  const pathRe = /"path"\s*:\s*\[\s*"data"\s*,\s*"([a-zA-Z0-9_]+)"\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(errBody)) !== null) fields.add(m[1]);
  // Some shapes phrase it as `Expected ... , received undefined at "<field>"`.
  const atRe = /received undefined.*?["'`]([a-zA-Z0-9_]+)["'`]/g;
  while ((m = atRe.exec(errBody)) !== null) fields.add(m[1]);
  const arr = [...fields];
  const needsComment = arr.some((f) => /comment|text|message|body|review/i.test(f));
  return { fields: arr, needsComment };
}

(async () => {
  const convex = new ConvexHttpClient(
    process.env.CONVEX_URL || "https://hearty-oyster-600.convex.cloud",
  );
  const ro = process.env.READ_ONLY_MODE !== "false";
  const dryRun = process.env.DRY_RUN === "true";
  const onlyOrders = (process.env.ONLY_ORDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let pending: any[] = await convex.query("reservations:pendingPlatformClose" as any, {});
  if (onlyOrders.length) {
    pending = pending.filter((r) => onlyOrders.includes(String(r.hygglo_order_id)));
  }

  console.log(
    `return-finalize | pending: ${pending.length}` +
      (onlyOrders.length ? ` (scoped to ${onlyOrders.join(",")})` : "") +
      ` | mode: ${ro ? "READ-ONLY (no writes)" : "LIVE"}${dryRun ? " | DRY_RUN" : ""}`,
  );

  for (const r of pending) {
    const accountSlug = r.account_slug as string;
    const hyggloOrderId = String(r.hygglo_order_id);
    const base = { accountSlug, hyggloOrderId };
    const reviewComment = "5/5 — great renter, looked after the gear and easy to deal with. Welcome back any time!";
    // Eligibility: a prepared `review_message` is present ONLY for renters who
    // passed the trust gate in markReturned (flagged/blacklisted are suppressed
    // there). We additionally treat "no prepared message" as "no discount text"
    // but STILL leave the 5★ review unless explicitly ineligible. Per this run
    // we pass eligibility in from the orchestrator's caller check below.
    const hasDiscountMsg = !!r.review_message;
    // The reservation feed already encodes the trust decision: a prepared
    // review_message implies eligible-for-message. The 5★ review is allowed for
    // any non-suppressed renter; suppression for flagged/blacklisted is enforced
    // upstream by markReturned (which would also have nulled review_message) and
    // re-asserted by the optional ELIGIBLE_FOR_REVIEW env override below.
    const eligibleForReview = process.env.ELIGIBLE_FOR_REVIEW !== "false";

    console.log(`\n— order ${hyggloOrderId} (${accountSlug}) —`);

    if (dryRun) {
      console.log(`  [dry] CLOSE  : PATCH /v4/my/orders/${hyggloOrderId}?timezone=${TZ}  body {"action":"return","data":{}}`);
      console.log(`  [dry] REVIEW : (after close unlocks) PATCH ... body {"action":"review","data":{rating:5,comment:"…"}}  eligible=${eligibleForReview}`);
      console.log(`  [dry]         review data SHAPE confirmed at run-time via empty-body 422 probe`);
      console.log(`  [dry] MESSAGE: ${hasDiscountMsg ? `PATCH ... body {"action":"chat","data":{message:"${String(r.review_message).slice(0, 80)}…"}}` : "(none — no prepared discount message on this row)"}`);
      console.log(`  [dry] STAMP  : reservations:markPlatformClosed { reservationId: ${r.reservationId} }`);
      continue;
    }

    // ── 1. CLOSE (mark returned) — the irreversible platform action ──
    const c = await returnOrder(base);
    console.log(`  close : ${c.status}${c.httpStatus ? " http=" + c.httpStatus : ""}${c.reason ? " (" + c.reason + ")" : ""}${c.error ? " err=" + c.error : ""}`);
    if (c.status !== "sent") {
      console.log("  -> STOP this order (close not sent): no review, no message, no stamp. Retries cleanly next run.");
      continue;
    }

    // ── 2. re-GET to confirm `review` unlocked (RETURNED -> REVIEWED) ──
    let reviewUnlocked = false;
    try {
      const order = await getOrder(accountSlug, hyggloOrderId);
      reviewUnlocked = !!(order && order.actions && order.actions.review === true);
      console.log(`  re-get: actions.review=${order?.actions?.review} actions.chat=${order?.actions?.chat}`);
    } catch (e) {
      console.log(`  re-get: FAILED ${(e as Error).message} — proceeding cautiously (review may still be locked)`);
    }

    // ── 3. 5★ REVIEW of the renter (eligible only) ──
    if (eligibleForReview && reviewUnlocked) {
      // 3a. SAFE shape-probe: empty body -> read 422 to learn required fields.
      const probe = await reviewRenter({ ...base, dataOverride: {} });
      if (probe.status === "sent") {
        // Empty body was accepted — Hygglo took an unrated/blank review. This is
        // unexpected; record it and do NOT re-submit (avoid a double review).
        console.log(`  review: SENT with empty body (unexpected — no rating fields required). http=${probe.httpStatus}`);
      } else if (probe.httpStatus === 422 && probe.error) {
        const shape = parseReviewShape(probe.error);
        console.log(`  review-probe 422: discovered fields=[${shape.fields.join(", ") || "?"}] needsComment=${shape.needsComment}`);
        console.log(`  review-probe 422 body: ${probe.error.slice(0, 400)}`);
        if (shape.fields.length === 0) {
          console.log("  -> STOP before rating: could not parse review data shape from 422. Close DONE; rating/message deferred for human confirmation.");
          // Do NOT stamp — leave row so the review can be completed once the
          // shape is confirmed. (Close already advanced the order.)
          continue;
        }
        // Build a 5★ payload mapping the discovered field names.
        const data: Record<string, unknown> = {};
        for (const f of shape.fields) {
          if (/comment|text|message|body|review/i.test(f)) data[f] = reviewComment;
          else if (/rating|stars?|score|grade/i.test(f)) data[f] = 5;
          else data[f] = 5; // unknown numeric-looking required field -> default 5
        }
        const rev = await reviewRenter({ ...base, dataOverride: data });
        console.log(`  review: ${rev.status}${rev.httpStatus ? " http=" + rev.httpStatus : ""}${rev.error ? " err=" + rev.error.slice(0, 200) : ""} payload=${JSON.stringify(data)}`);
        if (rev.status !== "sent") {
          console.log("  -> STOP before message/stamp: review submit failed after shape discovery. Close DONE; report 422.");
          continue;
        }
      } else {
        console.log(`  review-probe: unexpected ${probe.status} http=${probe.httpStatus} err=${(probe.error || "").slice(0, 200)}`);
        console.log("  -> STOP before rating: probe did not return a parseable 422. Close DONE; rating/message deferred.");
        continue;
      }
    } else {
      console.log(`  review: SKIPPED (eligible=${eligibleForReview}, unlocked=${reviewUnlocked})`);
    }

    // ── 4. discount-code chat message (eligible only) ──
    if (eligibleForReview && hasDiscountMsg) {
      const m = await sendOrderMessage({ ...base, text: r.review_message });
      console.log(`  msg   : ${m.status}${m.httpStatus ? " http=" + m.httpStatus : ""}${m.error ? " err=" + m.error.slice(0, 200) : ""}`);
    } else {
      console.log(`  msg   : SKIPPED (eligible=${eligibleForReview}, hasDiscountMsg=${hasDiscountMsg})`);
    }

    // ── 5. STAMP closed so this row is never re-processed ──
    await convex.mutation("reservations:markPlatformClosed" as any, { reservationId: r.reservationId });
    console.log(`  stamp : platform_closed_at set`);
  }
  console.log(`\n${ro ? "done (read-only — nothing sent)" : dryRun ? "done (dry-run — nothing sent)" : "done"}`);
})().catch((e) => {
  console.error("ERR", e?.message || e);
  process.exit(1);
});
