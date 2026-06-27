"use node";
/**
 * Reply Inbox — Node-runtime actions (LLM draft + gated live Hygglo send).
 *
 * Split from convex/replyInbox.ts because both the `ai` package (draft) and the
 * Hygglo write chokepoint live behind the "use node" runtime, while Convex
 * queries/mutations must NOT. See replyInbox.ts for the queue + bookkeeping.
 *
 * SEND GATE (Daniel, 2026-06-22): the live send is enabled but isolated.
 * `sendManualRenterMessage` is behind its OWN env gate ALLOW_MANUAL_RENTER_SEND
 * (decoupled from READ_ONLY_MODE) so Daniel's hand-typed dashboard replies go
 * out for real while automation writes stay blocked by READ_ONLY_MODE. ONLY a
 * deliberate Send click reaches this action — no cron/scheduler calls it.
 */
import { action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getActionLlmModel } from "./item_resolver";
import { gatedGenerateText } from "./lib/gatedGenerate";
import {
  sendManualRenterMessage,
  manualApproveOrder,
  manualDeclineOrder,
} from "../src/lib/hygglo-write";

// ── AI draft ──────────────────────────────────────────────────────

/**
 * Generate (and cache) a suggested owner reply for a thread, grounded in the
 * account persona + booking context + recent messages. User-driven, so it
 * bypasses the UK quiet-hours LLM gate. Returns the draft text.
 */
export const generateDraft = action({
  args: { thread_id: v.string() },
  handler: async (
    ctx,
    { thread_id },
  ): Promise<{ status: "ok" | "skipped"; draft?: string }> => {
    const c = await ctx.runQuery(internal.replyInbox.getThreadContext, {
      thread_id,
    });

    const system =
      (c.persona_prompt ??
        "You are the equipment owner replying to a renter on the Hygglo rental marketplace.") +
      "\n\nWrite my next reply to the renter as a real person texting on a rental " +
      "marketplace. Answer their latest message specifically, using the booking " +
      "context below.\n\n" +
      "Sound human, the way I'd actually text someone:\n" +
      "- Short and to the point, usually 1-3 sentences. This is a chat, not an email.\n" +
      "- Use contractions (I'll, you're, it's, that's) and a warm, easy tone.\n" +
      "- NO corporate filler or clichés. Never write 'I hope this finds you well', " +
      "'Thank you for reaching out', 'Please don't hesitate', 'at your earliest " +
      "convenience', 'kindly', 'rest assured'.\n" +
      "- NO em-dashes. Use commas, full stops, or separate sentences.\n" +
      "- No greeting unless it genuinely fits, and no formal sign-off or name placeholder.\n" +
      "- Don't over-explain or hedge. Say the useful thing plainly.\n\n" +
      "Grounding: use ONLY the facts in the booking context. Do NOT invent prices, " +
      "availability, dates, or policies you weren't given. If they haven't placed a " +
      "booking request yet (inquiry), nudge them to send one; if a request is pending " +
      "my approval, confirm availability and the next step.\n\n" +
      "TIMES, HOURS & RULES (important):\n" +
      "- Do NOT rubber-stamp a specific pickup/return time or say a time 'is fine' on " +
      "your own. Only agree to a time if it clearly falls within the business hours " +
      "below; if hours aren't given or the time looks early/late (e.g. 8am, late night), " +
      "say I'll confirm the exact time rather than committing to it.\n" +
      "- Respect the delivery policy and business rules below; don't promise delivery " +
      "outside the stated area or invent terms.\n" +
      "- NEVER mention internal policy, flags, ratings, or blacklisting to the renter.\n" +
      (c.response_style
        ? `\nMatch this house voice exactly: ${JSON.stringify(c.response_style)}.\n`
        : "") +
      "\nOutput ONLY the message body. No preamble, no surrounding quotes, no sign-off.";

    const transcript = c.messages
      .map((m) => `${m.role === "owner" ? "Me (owner)" : "Renter"}: ${m.content}`)
      .join("\n");

    const STAGE: Record<string, string> = {
      REQUEST: "PENDING REQUEST — awaiting my approve/decline",
      APPROVED: "APPROVED — awaiting the renter's payment",
      FUNDS_RESERVED: "APPROVED — awaiting the renter's payment",
      VERIFIED: "VERIFYING the renter's ID",
      BOOKED_AFTER_VERIFIED: "CONFIRMED — booking is locked in",
      DELIVERED: "OUT — gear is currently with the renter",
      RETURNED: "RETURNED — gear back, wrapping up",
      REVIEWED: "COMPLETE",
      CANCELED: "CANCELLED",
    };
    const requestLine = !c.has_reservation
      ? "Booking stage: INQUIRY — renter has NOT placed a booking request yet"
      : c.is_request
        ? "Booking stage: PENDING REQUEST — awaiting my approve/decline"
        : `Booking stage: ${(c.order_step && STAGE[c.order_step]) ?? c.status ?? "active"}`;

    // Renter trust line — feed the AI who it's talking to (it must NOT repeat
    // this to the renter; it just informs tone + caution).
    const rt: string[] = [];
    if (c.renter_rating != null) rt.push(`${c.renter_rating}★${c.renter_review_count != null ? ` from ${c.renter_review_count} reviews` : ""}`);
    if (c.renter_total_rentals) rt.push(`${c.renter_total_rentals} past rentals`);
    if (c.renter_blacklisted) rt.push("BLACKLISTED");
    else if (c.renter_flagged) rt.push("FLAGGED for manual review");
    const lowRated = c.renter_rating != null && c.renter_rating < 4;
    const renterLine = rt.length
      ? `Renter trust (internal, do NOT mention): ${rt.join(", ")}.${lowRated ? " Low rating — be helpful but don't over-commit; I'll vet them." : ""}`
      : null;

    const prompt = [
      `Renter: ${c.renter_name}`,
      renterLine,
      c.account_slug ? `Account: ${c.account_slug}` : null,
      c.items.length ? `Items requested: ${c.items.join(", ")}` : null,
      c.start_date ? `Rental period: ${c.start_date} → ${c.end_date ?? "?"}` : null,
      c.return_date ? `Return: ${c.return_date}` : null,
      c.pickup_method ? `Pickup method: ${c.pickup_method}` : null,
      c.gross_paid_gbp != null
        ? `Price: ${c.currency} ${c.gross_paid_gbp}${c.delivery_fee_gbp ? ` (incl. ${c.delivery_fee_gbp} delivery)` : ""}`
        : null,
      requestLine,
      c.business_hours
        ? `Business hours: ${JSON.stringify(c.business_hours)}`
        : "Business hours: not specified — do NOT confirm early/late pickup times (e.g. 8am); say I'll confirm the time.",
      c.delivery_policy ? `Delivery policy: ${JSON.stringify(c.delivery_policy)}` : null,
      c.business_rules ? `House rules (internal, follow but never quote verbatim or mention blacklisting): ${JSON.stringify(c.business_rules)}` : null,
      c.discount_codes
        ? `Discount codes available: ${JSON.stringify(c.discount_codes)}`
        : null,
      "",
      "Conversation so far:",
      transcript || "(no prior messages)",
      "",
      "Draft my reply to the renter's most recent message:",
    ]
      .filter((l) => l !== null)
      .join("\n");

    const gen = await gatedGenerateText({
      model: await getActionLlmModel(),
      system,
      prompt,
      bypass: true,
      context: { source: "replyInbox.generateDraft", tag: "reply_draft" },
    });
    if (gen.skipped) return { status: "skipped" };

    const draft = (gen.result.text ?? "").trim();
    if (draft) {
      await ctx.runMutation(internal.replyInbox.setDraft, {
        thread_id,
        draft_text: draft,
        message_id: c.last_message_id ?? undefined,
      });
    }
    return { status: "ok", draft };
  },
});

// ── Live send (gated) ─────────────────────────────────────────────

/**
 * Send the operator's reply to the renter on Hygglo. Returns the write result
 * verbatim so the UI can branch:
 *   sent    → tile leaves the queue (recordSentReply flipped last_sender)
 *   skipped → ALLOW_MANUAL_RENTER_SEND is off; show "sending disabled"
 *   failed  → show the error (httpStatus/error)
 */
export const sendRenterReply = action({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    text: v.string(),
    // TEST MODE: simulate the whole flow without sending anything to Hygglo or
    // touching the thread state. Lets the operator exercise the UI safely.
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { thread_id, account_slug, text, dryRun },
  ): Promise<{
    status: "sent" | "skipped" | "failed";
    reason?: string;
    httpStatus?: number;
    error?: string;
  }> => {
    const body = text.trim();
    if (!body) return { status: "failed", error: "Empty message" };
    if (dryRun) return { status: "sent", reason: "DRY_RUN" };

    const res = await sendManualRenterMessage({
      accountSlug: account_slug,
      hyggloOrderId: thread_id,
      text: body,
    });

    if (res.status === "sent") {
      await ctx.runMutation(internal.replyInbox.recordSentReply, {
        thread_id,
        account_slug,
      });
    }
    return {
      status: res.status,
      reason: res.reason,
      httpStatus: res.httpStatus,
      error: res.error,
    };
  },
});

// ── Approve / Decline a rental request (gated) ────────────────────

type OrderActionResult = {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  httpStatus?: number;
  error?: string;
};

/**
 * Approve a pending rental REQUEST from the dashboard. Live but isolated behind
 * ALLOW_MANUAL_ORDER_ACTIONS (deliberate clicks only). The poller syncs the new
 * order_step on its next run; the UI hides the card optimistically meanwhile.
 */
export const approveOrder = action({
  args: { thread_id: v.string(), account_slug: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { thread_id, account_slug, dryRun }): Promise<OrderActionResult> => {
    if (!account_slug) return { status: "failed", error: "No account for this thread" };
    if (dryRun) return { status: "sent", reason: "DRY_RUN" };
    const res = await manualApproveOrder({
      accountSlug: account_slug,
      hyggloOrderId: thread_id,
    });
    // Approved → accept no longer available, but I can still decline (cancel)
    // until the renter pays. Persist so the widget shows only Decline + the
    // "approved before" marker, instantly and across reloads.
    if (res.status === "sent") {
      await ctx.runMutation(internal.replyInbox.setOwnerActionState, {
        thread_id,
        can_accept: false,
        can_deny: true,
      });
    }
    return {
      status: res.status,
      reason: res.reason,
      httpStatus: res.httpStatus,
      error: res.error,
    };
  },
});

/** Decline a pending rental REQUEST. Same gate + behaviour as approveOrder. */
export const declineOrder = action({
  args: { thread_id: v.string(), account_slug: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { thread_id, account_slug, dryRun }): Promise<OrderActionResult> => {
    if (!account_slug) return { status: "failed", error: "No account for this thread" };
    if (dryRun) return { status: "sent", reason: "DRY_RUN" };
    const res = await manualDeclineOrder({
      accountSlug: account_slug,
      hyggloOrderId: thread_id,
    });
    // Declined → no owner actions remain.
    if (res.status === "sent") {
      await ctx.runMutation(internal.replyInbox.setOwnerActionState, {
        thread_id,
        can_accept: false,
        can_deny: false,
      });
    }
    return {
      status: res.status,
      reason: res.reason,
      httpStatus: res.httpStatus,
      error: res.error,
    };
  },
});
