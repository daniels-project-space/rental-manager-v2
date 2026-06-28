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
import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { getActionLlmModel } from "./item_resolver";
import { gatedGenerateText } from "./lib/gatedGenerate";
import { guardDraft, type DraftFlag } from "./lib/draft_guard";
import { dnaSummary } from "./lib/renter_dna";
import { computeNegotiationStance } from "./lib/renter_bot_negotiation";
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
  ): Promise<{
    status: "ok" | "skipped";
    draft?: string;
    confidence?: number;
    flags?: DraftFlag[];
  }> => {
    // Make sure we know the inquiry's listing before drafting — pulls the order
    // detail's items onto conv.inquiry_items (no-op if cached or a reservation
    // already carries the items). This is what stops "I don't know which item."
    try {
      await ctx.runAction(api.inquiry_context.resolveForThread, { thread_id });
    } catch {
      /* best-effort grounding */
    }

    const c = await ctx.runQuery(internal.replyInbox.getThreadContext, {
      thread_id,
    });

    // Renter messages (oldest→newest) for negotiation + routing reads.
    const renterMsgs = c.messages
      .filter((m) => m.role === "renter")
      .map((m) => m.content);
    const lastRenter = renterMsgs[renterMsgs.length - 1] ?? "";

    // Phase 4 negotiation ladder (harvested from the dormant renter_bot stack):
    // objection count → HOLD_FIRM / OFFER_ALTERNATIVES / SOFT_YIELD framing.
    const negotiation = computeNegotiationStance({
      latestMessage: lastRenter,
      priorRenterMessages: renterMsgs.slice(0, -1),
      lastPriceOfferedGbp: c.gross_paid_gbp ?? null,
      isHighValue: (c.prior_rentals ?? 0) >= 3,
    });

    // Phase 4 model routing: high-stakes turns go to the stronger model.
    const lr = lastRenter.toLowerCase();
    const rentalShipped =
      ["VERIFIED", "BOOKED_AFTER_VERIFIED", "DELIVERED"].includes(
        c.order_step ?? "",
      ) ||
      c.status === "ongoing" ||
      c.status === "confirmed";
    const highStakes =
      /\b(refund|compensat|money back|my money|reimburse|chargeback)\b/.test(lr) ||
      (rentalShipped &&
        /\b(scratched|broke|broken|damaged|dropped|not working|won'?t turn on|cracked|smashed|shattered|malfunction|faulty)\b/.test(
          lr,
        )) ||
      /\b(lawyer|sue|legal action|court|trading standards|small.?claims|ombudsman|paypal dispute)\b/.test(
        lr,
      ) ||
      /🙄|😒|😤|\b(oh (?:great|wonderful|fantastic|perfect|brilliant)|really professional|wow.*service)\b/.test(
        lr,
      ) ||
      (negotiation.objectionCount >= 1 && (c.gross_paid_gbp ?? 0) >= 200);

    // Stage-specific objective for the draft (sales funnel awareness).
    const STAGE_OBJECTIVE: Record<string, string> = {
      INQUIRY:
        "They're just asking — answer clearly and nudge them to send a booking request.",
      INTERESTED:
        "They're warming up — build confidence, answer their questions, move toward a request.",
      READY_TO_BOOK:
        "They're close — remove the last bit of friction and get the request in.",
      BOOKED:
        "Request placed but NOT yet confirmed/paid — guide them through payment/verification; do NOT say it's confirmed.",
      CONFIRMED:
        "Booked and paid — handle logistics (pickup, times) precisely; this is locked in.",
      COMPLETED: "Rental's done — wrap up warmly, no upsell.",
      DEAD: "Likely lost — a light, no-pressure door-open only.",
    };
    const stageLine = c.conversation_stage
      ? `Stage goal: ${STAGE_OBJECTIVE[c.conversation_stage] ?? c.conversation_stage}`
      : null;
    const negotiationLine =
      negotiation.stance !== "NONE"
        ? `Negotiation (internal, ${negotiation.stance}): ${negotiation.suggestedFraming}`
        : null;

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
      "Grounding: state as fact ONLY what's in the FACTS list and booking context " +
      "below. Do NOT invent prices, availability, specs, dates, policies, or suggest " +
      "gear we don't own. If you need something that isn't listed, say I'll check " +
      "rather than guessing. CRITICAL: never tell a renter we DON'T have an item, or " +
      "that we have 'no other'/'no alternative' options — you don't see the full " +
      "inventory, so 'we don't have it' is usually wrong. Only say an item isn't ours " +
      "if it's explicitly listed as NOT IN OUR INVENTORY in the FACTS; for anything " +
      "else say I'll check. If they haven't placed a booking request yet (inquiry), " +
      "nudge them to send one. If the booking stage says PENDING REQUEST, I have " +
      "NOT approved it yet — do NOT say it's approved/confirmed or tell them to pay; " +
      "acknowledge, confirm availability if known, and say I'll get it approved/" +
      "sorted shortly. Only say it's approved + they can pay when the stage clearly " +
      "says APPROVED/awaiting payment (not pending).\n\n" +
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

    // Phase 2 Knowledge Fence: a numbered list of the ONLY facts the AI may
    // state — real availability + price + specs (resolved from inventory,
    // confirmed bookings only) + pickup windows + the owned-camera guard.
    const facts: string[] = [];
    if (c.availability && c.availability.items.length)
      for (const it of c.availability.items)
        facts.push(
          it.available
            ? `${it.name}: AVAILABLE for these dates (${it.free} of ${it.total_units} free)`
            : `${it.name}: NOT available for these dates (booked out) — do not confirm it; offer an alternative or say I'll check`,
        );
    if (c.fact_pack?.pricing?.itemPrices?.length)
      for (const p of c.fact_pack.pricing.itemPrices)
        facts.push(
          `${p.name}: daily price £${p.min}${p.max !== p.min ? `–${p.max}` : ""}`,
        );
    if (c.fact_pack?.specs?.length)
      for (const s of c.fact_pack.specs) facts.push(`${s.name} — ${s.text}`);
    if (c.pickup_windows?.length)
      facts.push(
        `Pickup/return windows (Europe/London): ${c.pickup_windows.map((w) => `${w.start}–${w.end}`).join(", ")}`,
      );
    // Full owned inventory by category — lets the draft offer the closest real
    // alternative when we don't have exactly what the renter asked for.
    const KIND_LABEL: Record<string, string> = {
      camera: "Cameras",
      lens: "Lenses",
      audio: "Audio/mics",
      lighting: "Lighting",
      monitor: "Monitors",
      gimbal: "Gimbals",
      stabilizer: "Stabilizers",
      drone: "Drones",
      dj_audio: "DJ/PA",
      power: "Power",
      grip: "Grip",
      support: "Tripods/support",
      motion: "Sliders/motion",
      video: "Video",
      effects: "FX",
      transmission: "Wireless video",
      accessory: "Accessories",
      storage_card: "Cards",
      smoke_fx: "Smoke/FX",
    };
    const inv = c.owned_inventory ?? {};
    const invParts = Object.keys(KIND_LABEL)
      .filter((k) => (inv[k] ?? []).length)
      .map((k) => `${KIND_LABEL[k]}: ${inv[k].join(", ")}`);
    if (invParts.length)
      facts.push(
        `Gear I own (ONLY ever offer items from this list; if I don't have exactly what they asked, suggest the closest of these in the SAME category instead of just saying no) — ${invParts.join("; ")}`,
      );
    if (c.unfulfillable?.length)
      facts.push(
        `NOT IN OUR INVENTORY — ${c.unfulfillable.join(", ")}. We don't stock this exact item. Do NOT confirm it, say it's approved, or quote a price for it. Tell the renter warmly that we can't provide that specific item and offer a real owned alternative (or say I'll sort it). Do NOT explain why the listing exists or call it a test/error.`,
      );
    const factsBlock = facts.length
      ? "FACTS — the ONLY information you may state as fact. If something you need isn't listed, say I'll check; never guess prices, specs, availability, dates, policies, or gear we don't have:\n" +
        facts.map((f, i) => `[F${i + 1}] ${f}`).join("\n")
      : null;

    // Do we have ANY item-level grounding? If not (a bare inquiry with no
    // resolved item/availability/pricing), the draft must ASK, not assert.
    const hasItemGrounding = !!(
      c.availability?.items?.length ||
      c.fact_pack?.specs?.length ||
      c.fact_pack?.pricing?.itemPrices?.length
    );
    const noGroundingLine = hasItemGrounding
      ? null
      : "I do NOT have this item's availability, stock count, price, or specs in front of me. Do NOT say it's available/free/in stock, do NOT state a quantity, do NOT quote a price, and do NOT state any spec or dimension (screen size, resolution, weight, aperture, etc.). Ask which exact item or listing they mean and tell them to send a booking request so I can check and confirm.";

    // Renter trust line — feed the AI who it's talking to (it must NOT repeat
    // this to the renter; it just informs tone + caution).
    const rt: string[] = [];
    if (c.renter_rating != null) rt.push(`${c.renter_rating}★${c.renter_review_count != null ? ` from ${c.renter_review_count} reviews` : ""}`);
    const pastRentals = c.prior_rentals || c.renter_total_rentals || 0;
    if (pastRentals) rt.push(`${pastRentals} past rentals with me`);
    if (c.renter_blacklisted) rt.push("BLACKLISTED");
    else if (c.renter_flagged) rt.push("FLAGGED for manual review");
    const lowRated = c.renter_rating != null && c.renter_rating < 4;
    const lowRevText =
      c.low_reviews && c.low_reviews.length
        ? ` Past low reviews: ${c.low_reviews.map((r) => `${r.rating}★ "${r.text.slice(0, 80)}"`).join("; ")}.`
        : "";
    const renterLine = rt.length
      ? `Renter trust (internal, do NOT mention): ${rt.join(", ")}.${lowRated ? " Low rating — be helpful but don't over-commit; I'll vet them." : ""}${lowRevText}`
      : null;

    // RenterDNA tone read + returning-renter awareness (internal, adapt tone).
    const dnaText = dnaSummary(c.renter_dna);
    const dnaLine = dnaText
      ? `Renter style (internal, adapt my tone to match, never mention): ${dnaText}.`
      : null;
    const welcomeLine = c.prior_rentals
      ? `Returning renter — this is rental #${c.prior_rentals + 1} with me; they've rented before, so a warm, familiar tone fits (no need to over-explain the basics).`
      : null;

    // Phase 5: house rules (rules table), money-saving bundle, hard truths.
    const rulesBlock = c.house_rules?.length
      ? `House rules (internal, follow but NEVER quote verbatim or mention to the renter):\n${c.house_rules.map((r) => `- ${r}`).join("\n")}`
      : c.business_rules
        ? `House rules (internal, follow but never quote): ${JSON.stringify(c.business_rules)}`
        : null;
    const bundleLine = c.bundle_suggestion
      ? `Optional money-saving bundle (mention only if it genuinely fits their shoot — never pushy): ${c.bundle_suggestion.name}${c.bundle_suggestion.price ? ` (${c.bundle_suggestion.price})` : ""}${c.bundle_suggestion.note ? ` — ${c.bundle_suggestion.note}` : ""}`
      : null;
    const hardTruthsBlock = c.hard_truths
      ? `HARD TRUTHS (read these last, they override anything above):\n${c.hard_truths}`
      : null;

    const prompt = [
      `Renter: ${c.renter_name}`,
      renterLine,
      dnaLine,
      welcomeLine,
      stageLine,
      negotiationLine,
      c.account_slug ? `Account: ${c.account_slug}` : null,
      c.items.length ? `Items requested: ${c.items.join(", ")}` : null,
      c.start_date ? `Rental period: ${c.start_date} → ${c.end_date ?? "?"}` : null,
      c.return_date ? `Return: ${c.return_date}` : null,
      c.pickup_method ? `Pickup method: ${c.pickup_method}` : null,
      c.gross_paid_gbp != null
        ? `Price: ${c.currency} ${c.gross_paid_gbp}${c.delivery_fee_gbp ? ` (incl. ${c.delivery_fee_gbp} delivery)` : ""}`
        : null,
      requestLine,
      factsBlock,
      noGroundingLine,
      c.business_hours
        ? c.business_hours
        : "Business hours: not specified — do NOT confirm early/late pickup times (e.g. 8am); say I'll confirm the time.",
      c.delivery_policy ? `Delivery policy: ${JSON.stringify(c.delivery_policy)}` : null,
      rulesBlock,
      bundleLine,
      c.discount_codes
        ? `Discount codes available: ${JSON.stringify(c.discount_codes)}`
        : null,
      "",
      "Conversation so far:",
      transcript || "(no prior messages)",
      "",
      hardTruthsBlock,
      "Draft my reply to the renter's most recent message:",
    ]
      .filter((l) => l !== null)
      .join("\n");

    const gen = await gatedGenerateText({
      model: await getActionLlmModel({ strong: highStakes }),
      system,
      prompt,
      bypass: true,
      context: { source: "replyInbox.generateDraft", tag: "reply_draft" },
    });
    if (gen.skipped) return { status: "skipped" };

    const draft = (gen.result.text ?? "").trim();
    if (!draft) return { status: "ok", draft };

    // ── Output policing (Phase 1 guard) ──────────────────────────
    // Port of the V1 FILTER + CONTRACT layers: auto-clean unambiguous garbage
    // (internal leaks, leaked reasoning, "Hygglo", timestamps, markdown, Leo/
    // diogo we→I) and FLAG judgement calls for my review (price/availability
    // claims, premature confirmation, false action claims, out-of-hours times…).
    const guardStage =
      c.order_step === "RETURNED" ||
      c.order_step === "REVIEWED" ||
      c.status === "completed"
        ? "completed"
        : c.order_step === "BOOKED_AFTER_VERIFIED" ||
            c.order_step === "DELIVERED" ||
            c.status === "confirmed" ||
            c.status === "ongoing"
          ? "confirmed"
          : c.order_step === "VERIFIED"
            ? "booked"
            : undefined;
    const guard = guardDraft(draft, {
      history: c.messages as { role: "owner" | "renter"; content: string }[],
      lastRenterMessage: lastRenter,
      account: c.account_slug ?? undefined,
      stage: guardStage,
      pickupWindows: c.pickup_windows ?? undefined,
      firstPerson: c.account_slug === "leo" || c.account_slug === "diogo",
      // Genuinely approved ONLY when it's no longer awaiting my approve/decline.
      // (order_step=APPROVED + awaiting_owner_action=true is still a PENDING
      // request, not an approval.)
      ownerApproved:
        !c.awaiting_owner_action &&
        ([
          "APPROVED",
          "FUNDS_RESERVED",
          "VERIFIED",
          "BOOKED_AFTER_VERIFIED",
          "DELIVERED",
          "RETURNED",
          "REVIEWED",
        ].includes(c.order_step ?? "") ||
          ["confirmed", "ongoing", "completed"].includes(c.status ?? "")),
      unfulfillableItems: c.unfulfillable ?? undefined,
      hasItemGrounding,
      factPack: c.fact_pack
        ? {
            pricing: c.fact_pack.pricing,
            verifiedListingItem: c.fact_pack.verifiedListingItem,
            marketingItems: c.fact_pack.marketingItems,
          }
        : undefined,
      availability: c.availability
        ? {
            items: c.availability.items.map((it) => ({
              name: it.name,
              available: it.available,
            })),
          }
        : undefined,
    });
    const finalDraft = guard.text.trim() || draft;

    await ctx.runMutation(internal.replyInbox.setDraft, {
      thread_id,
      draft_text: finalDraft,
      message_id: c.last_message_id ?? undefined,
      conversation_stage: c.conversation_stage ?? undefined,
      confidence: guard.confidence,
      flags: guard.flags,
    });

    // Persist the RenterDNA + rental counts so the trust read carries across
    // threads (best-effort — never block the draft on it).
    if (c.renter_id) {
      await ctx.runMutation(internal.replyInbox.persistRenterStats, {
        renter_id: c.renter_id,
        renter_dna: c.renter_dna ?? undefined,
        total_rentals_count: c.prior_rentals,
        last_rental_at: c.last_rental_at ?? undefined,
      });
    }
    return {
      status: "ok",
      draft: finalDraft,
      confidence: guard.confidence,
      flags: guard.flags,
    };
  },
});

// ── Draft pre-gen backfill (cron) ─────────────────────────────────

/**
 * Pre-generate AI drafts for awaiting-reply threads that don't have one yet, so
 * the draft is ready before the box is opened. On-message pre-gen only fires for
 * NEW messages; this backfills existing threads. Capped per run.
 */
export const pregenerateActiveDrafts = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ made: number; checked: number }> => {
    const threads = await ctx.runQuery(internal.replyInbox.threadsNeedingDraft, {
      limit: limit ?? 20,
    });
    let made = 0;
    for (const t of threads) {
      try {
        const r = await ctx.runAction(api.replyInbox_actions.generateDraft, {
          thread_id: t,
        });
        if (r.status === "ok" && r.draft) made++;
      } catch {
        /* best-effort */
      }
    }
    return { made, checked: threads.length };
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
