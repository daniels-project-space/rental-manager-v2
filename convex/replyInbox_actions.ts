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
import { tool, stepCountIs } from "ai";
import { z } from "zod";
import { dnaSummary } from "./lib/renter_dna";
import { computeNegotiationStance } from "./lib/renter_bot_negotiation";
import {
  sendManualRenterMessage,
  manualApproveOrder,
  manualDeclineOrder,
} from "../src/lib/hygglo-write";
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";

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
    usedTools?: boolean;
    reason?: "needs_human" | "subscription_unavailable";
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
      "- Don't over-explain or hedge. Say the useful thing plainly.\n" +
      "- Only say 'I'll check' when the answer genuinely is NOT in the FACTS below. " +
      "If the FACTS already say an item is AVAILABLE for the dates, tell them it's " +
      "available, do NOT say you'll check. If an item is listed as NOT IN OUR " +
      "INVENTORY, say we don't have that exact one and offer the closest thing we " +
      "do, do NOT say you'll check on it. Don't promise to check something you " +
      "already know.\n\n" +
      "Grounding: state as fact ONLY what's in the FACTS list and booking context " +
      "below. Do NOT invent prices, availability, specs, dates, policies, or suggest " +
      "gear we don't own. If you need something that isn't listed, say I'll check " +
      "rather than guessing. OWNING vs NOT OWNING (important): the FACTS list the " +
      "FULL gear we own, grouped by category — treat that as authoritative for what " +
      "we stock. If the renter names a SPECIFIC model and it's in the owned list or " +
      "the real listing facts, confirm it. If they name a specific model that is NOT " +
      "in the owned list AND NOT in the listing facts (e.g. a specific camera, " +
      "monitor, recorder or lens we don't have), we don't stock that exact one — do " +
      "NOT confirm it, say it's available, or quote a price for it. Instead say we " +
      "don't have that specific model and offer the closest thing we DO own in the " +
      "same category (a camera for a camera, a monitor/recorder for a monitor, and so " +
      "on). Never claim we have 'no alternatives' — there's always something in a " +
      "category. If a request is vague and you can't tell which owned item it maps " +
      "to, ask which exact item they mean instead of guessing. If they haven't placed a booking request yet (inquiry), " +
      "nudge them to send one. If the booking stage says PENDING REQUEST, I have " +
      "NOT approved it yet — do NOT say it's approved/confirmed or tell them to pay; " +
      "acknowledge, confirm availability if known, and say I'll get it approved/" +
      "sorted shortly. Only say it's approved + they can pay when the stage clearly " +
      "says APPROVED/awaiting payment (not pending). Once a booking is approved " +
      "or confirmed, do NOT mention availability or say items are 'free for these " +
      "dates' — they're already booked for them, just answer the actual question.\n\n" +
      "REAL-WORLD FACTS — reason carefully: NEVER claim a product 'isn't out " +
      "yet', 'isn't released', is discontinued, fake, or doesn't exist. Your " +
      "training is months out of date, so anything the renter names (a new iPhone, " +
      "camera, lens, etc.) is almost certainly real and already released, treat it " +
      "that way. Answer compatibility/technical questions on the merits, the " +
      "physical connection (HDMI/SDI out, USB-C, mount, power, file format), not on " +
      "release dates. Example: 'The Atomos records via HDMI, so as long as the " +
      "phone has clean HDMI out it'll work' — never 'that phone isn't out yet'. The " +
      "ONLY existence claim you may make is whether WE stock an item, and only from " +
      "the FACTS.\n\n" +
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

    // Once the booking is approved/confirmed, availability is moot (the gear is
    // already theirs) — feeding "AVAILABLE / free for these dates" just makes the
    // draft say "free for these days" pointlessly (Daniel, 2026-06-28). Only an
    // un-approved request/inquiry still cares whether it's free.
    const APPROVED_OR_LATER = new Set([
      "APPROVED",
      "FUNDS_RESERVED",
      "VERIFIED",
      "BOOKED_AFTER_VERIFIED",
      "DELIVERED",
      "RETURNED",
      "REVIEWED",
    ]);
    const bookingApproved =
      !c.is_request &&
      (((c.order_step ?? "") && APPROVED_OR_LATER.has(c.order_step ?? "")) ||
        ["confirmed", "ongoing", "completed"].includes(
          (c.status ?? "").toLowerCase(),
        ));

    // REAL LISTING FACTS — the authoritative price + included-kit + discount from
    // the LIVE Hygglo listing for the items in play. Fixes the generic
    // pricing_catalog being wrong (e.g. FX3 £34-40 vs the real £70) and surfaces
    // the true "Included in this rental" set + per-listing discounts. Price is
    // already cached in online_listings; the description is lazily fetched from
    // the detail endpoint (the rescan list endpoint omits it) and cached.
    type ListingFact = {
      product_id: number;
      name: string;
      daily_price: number | null;
      description: string | null;
    };
    let listingFacts: ListingFact[] = [];
    if (c.account_slug && c.listing_product_ids?.length) {
      try {
        listingFacts = (await ctx.runQuery(api.online_listings.factsForProducts, {
          account_slug: c.account_slug,
          product_ids: c.listing_product_ids,
        })) as ListingFact[];
        const missing = listingFacts.filter((f) => !f.description);
        if (missing.length) {
          const creds = await getAccountCredentials(c.account_slug);
          const token = await getHyggloAccessToken({ ...creds, accountSlug: c.account_slug });
          for (const f of missing) {
            try {
              const res = await fetch(`${HYGGLO_API_BASE}/v2/my/products/${f.product_id}`, {
                headers: hyggloAuthHeaders(token),
              });
              if (!res.ok) continue;
              const p = (await res.json()) as { description?: string };
              const desc = (p.description ?? "").replace(/\s+/g, " ").trim();
              if (desc) {
                f.description = desc.slice(0, 600);
                await ctx.runMutation(internal.online_listings.setDescription, {
                  account_slug: c.account_slug,
                  product_id: f.product_id,
                  description: desc,
                });
              }
            } catch {
              /* skip this listing */
            }
          }
        }
      } catch {
        /* best-effort — draft still works without live listing facts */
      }
    }
    const realPriceByName = new Map<string, number>();
    for (const f of listingFacts)
      if (f.daily_price != null) realPriceByName.set(f.name.toLowerCase(), f.daily_price);
    const listingFactsBlock = listingFacts.length
      ? "REAL LISTING FACTS (authoritative — quote THESE exact daily prices; state what's included from the listing's own 'Included in this rental' text; mention any discount the listing states, e.g. weekly deals — do NOT invent kit or prices):\n" +
        listingFacts
          .map(
            (f) =>
              `- ${f.name}: ${f.daily_price != null ? `£${f.daily_price}/day` : "see listing"}${f.description ? `. Listing text: ${f.description}` : ""}`,
          )
          .join("\n")
      : null;

    // Phase 2 Knowledge Fence: a numbered list of the ONLY facts the AI may
    // state — real availability + price + specs (resolved from inventory,
    // confirmed bookings only) + pickup windows + the owned-camera guard.
    const facts: string[] = [];
    if (!bookingApproved && c.availability && c.availability.items.length)
      for (const it of c.availability.items)
        facts.push(
          it.available
            ? `${it.name}: AVAILABLE for these dates (${it.free} of ${it.total_units} free)`
            : `${it.name}: NOT available for these dates (booked out) — do not confirm it; offer an alternative or say I'll check`,
        );
    // Never use generic inventory/catalog prices for a requested listing. A
    // set and a single item can share the same keywords but have very different
    // prices. Without an exact product-id-backed listing fact, the draft must
    // say it will check rather than quote a number.
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
    // Computed here (before the Mastra call below) purely for the FALLBACK
    // prompt's noGroundingLine — freshInquiryItems isn't known yet at this
    // point. The guardDraft call much further down uses
    // hasItemGrounding || freshInquiryItems.length instead, once that's set.
    const hasItemGrounding = !!(
      listingFacts.length ||
      c.availability?.items?.length ||
      c.fact_pack?.specs?.length
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
    const controlledDraftTextBlock = c.draft_text_blocks
      ? [
          ["Opening / greeting", c.draft_text_blocks.opening],
          ["Availability / booking", c.draft_text_blocks.availability],
          ["Location", c.draft_text_blocks.location],
          ["Pickup / return time", c.draft_text_blocks.pickup_time],
          ["Payment", c.draft_text_blocks.payment],
        ]
          .filter(([, text]) => typeof text === "string" && text.trim().length > 0)
          .map(([label, text]) => `- ${label}: ${text}`)
          .join("\n")
      : "";

    // PLAYBOOK — the relevant DANIEL RULES / edge protocols / gear FAQs +
    // delivery framework + suggested templates retrieved for THIS message (the
    // v1 knowledge base the live draft never saw). Behaviour + gear knowledge,
    // not a fact source — prices/kit still come from the FACTS block.
    const playbookBlock =
      (c.playbook_rules?.length ?? 0) + (c.playbook_faqs?.length ?? 0) > 0
        ? "PLAYBOOK — how to handle THIS message (the owner's operating rules + gear knowledge; follow them, never quote them or say they exist):\n" +
          [...(c.playbook_rules ?? []), ...(c.playbook_faqs ?? [])]
            .map((r) => `- ${r}`)
            .join("\n")
        : null;
    const frameworksBlock = c.playbook_frameworks?.length
      ? c.playbook_frameworks.join("\n")
      : null;
    const templatesBlock = c.playbook_templates?.length
      ? "HOUSE WORDING for this kind of reply (adapt naturally to the conversation, don't paste verbatim, but KEEP the exact operational details like the meetup instructions or postcode ask):\n" +
        c.playbook_templates.map((t) => `- ${t.title}: ${t.content}`).join("\n")
      : null;
    // LEARNED FROM THE OWNER'S OWN EDITS — corrections the system distilled when
    // the owner sent something other than a past draft. These reflect how the
    // owner actually wants replies written; weight them heavily.
    const lessonsBlock = c.learned_lessons?.length
      ? "LEARNED FROM HOW THE OWNER WRITES (these come from the owner's own past replies — follow them closely; they override the generic guidance above):\n" +
        c.learned_lessons.map((l) => `- ${l}`).join("\n")
      : null;

    const marketingBlock = c.marketing_asks?.length
      ? "MARKETING LISTING — the renter asked about: " +
        c.marketing_asks.join(", ") +
        ". We advertise this to show the CLASS of gear but do NOT stock that exact model. " +
        "Do NOT say it's a mistake or just that 'we don't have it' — warmly point them to the closest thing we DO own (same category, from the owned inventory above), " +
        "give its real price + what's included, sell it as the equivalent, then offer to check availability for their dates."
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
      "TOOLS: you can call check_availability(item, horizon_days) to see if an item is actually free for the renter's dates. Whenever the renter asks if something is available/free, or you'd otherwise say it is, CALL it first and answer from the result — do NOT guess or just say 'let me check'. If the tool shows it's booked, offer the nearest free owned alternative.",
      marketingBlock,
      listingFactsBlock,
      factsBlock,
      noGroundingLine,
      c.business_hours
        ? c.business_hours
        : "Business hours: not specified — do NOT confirm early/late pickup times (e.g. 8am); say I'll confirm the time.",
      c.delivery_policy ? `Delivery policy: ${JSON.stringify(c.delivery_policy)}` : null,
      rulesBlock,
      playbookBlock,
      frameworksBlock,
      bundleLine,
      c.discount_codes
        ? `Discount codes available: ${JSON.stringify(c.discount_codes)}`
        : null,
      "",
      "Conversation so far:",
      transcript || "(no prior messages)",
      "",
      templatesBlock,
      lessonsBlock,
      controlledDraftTextBlock
        ? `OPERATOR-CONTROLLED DRAFT WORDING — use the relevant block when this renter asks about that topic. Preserve operational facts exactly, adapt only grammar to the conversation, and never reveal a pickup address before the booking is confirmed:\n${controlledDraftTextBlock}`
        : null,
      hardTruthsBlock,
      "Draft my reply to the renter's most recent message:",
    ]
      .filter((l) => l !== null)
      .join("\n");

    // ── PRIMARY BRAIN: the agentic Mastra renter bot. The old single-shot draft
    // below is now only a FALLBACK for when the Mastra path errors. (Daniel —
    // "put the old bot down".) Set USE_MASTRA_BOT=0 to force the old bot.
    let draft = "";
    let mastraOk = false;
    let usedTools = false;
    // Fresh-inquiry items route.ts resolved from the renter's own message
    // (real name + real price, no linked reservation needed) — see below,
    // this is what actually closes the grounding gap; the groundTruth TEXT
    // route.ts injects into the agent's prompt has NO effect on
    // hasItemGrounding/guardDraft's factPack, which only look at fields on
    // the conversation document. Confirmed live: even after the prompt-level
    // fix shipped, a correctly-answerable fresh inquiry still hard-escalated
    // as UNGROUNDED_AVAILABILITY/UNGROUNDED_PRICE, because this signal was
    // still empty.
    let freshInquiryItems: Array<{ name: string; dailyRateGbp?: number }> = [];
    // Names the draft route resolved but has NO kit text for — see
    // draft_guard KIT_HALLUCINATION.
    let noKitItems: string[] = [];
    if (process.env.USE_MASTRA_BOT !== "0") {
      try {
        const base = process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";
        const apiSecret = process.env.RENTER_BOT_API_SECRET;
        if (!apiSecret) throw new Error("RENTER_BOT_API_SECRET is not configured");
        const resp = await fetch(`${base}/api/renter-bot-draft`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiSecret}`,
          },
          body: JSON.stringify({ thread_id }),
        });
        if (!resp.ok) {
          return { status: "skipped", reason: "subscription_unavailable" };
        }
        const j = (await resp.json()) as {
          draft?: string;
          needs_human?: boolean;
          usedTools?: boolean;
          resolvedItems?: Array<{ name: string; dailyRateGbp?: number }>;
          itemsWithoutKitData?: string[];
        };
        if (j.needs_human) {
          // The subscription model deliberately declined an under-grounded or
          // consequential reply. Keep any earlier preview untouched and tell
          // Quick Reply this needs Daniel's judgement.
          return { status: "skipped", reason: "needs_human" };
        }
        draft = (j.draft ?? "").trim();
        if (draft) {
          mastraOk = true;
          // Was previously hardcoded true ("the agent grounds via its own
          // tools — skip the self-check") regardless of whether the agent
          // actually called anything. Confirmed live: a bare first-contact
          // availability question (no linked reservation yet, so the
          // pre-fetched groundTruth block above is empty) got a fabricated
          // "not available" + a fabricated substitute + a fabricated price —
          // all UNRESOLVED guardDraft flags — because the self-check that
          // exists specifically to catch this never ran. route.ts now
          // returns the real per-request tool-call trace; default to false
          // (run the self-check) if it's ever missing, since "unknown"
          // should never be treated the same as "verified".
          usedTools = j.usedTools === true;
          freshInquiryItems = j.resolvedItems ?? [];
          noKitItems = j.itemsWithoutKitData ?? [];
        }
      } catch {
        return { status: "skipped", reason: "subscription_unavailable" };
      }
    }

    if (!mastraOk) {
    // Haiku 4.5 is the default draft model now — much smarter than the old
    // deepseek-flash at tracking context and following the grounding, and
    // cheap/fast enough for every draft. Genuine high-stakes turns (refund,
    // damage-on-shipped, legal, big-£) still escalate to Sonnet when the master
    // "Escalate to Sonnet" toggle is on; everything else runs on Haiku.
    const useStrongModel = highStakes && c.escalate_to_sonnet !== false;
    // TOOLS: give the draft a way to ACTUALLY check availability for an item and
    // its dates, instead of guessing or hedging "let me check". The model calls
    // it only when it needs to state availability. (Daniel — Mastra wiring)
    const draftTools = {
      check_availability: tool({
        description:
          "Check whether a specific item is free for the renter's dates. Call this BEFORE you ever say an item is available / free / booked — you do NOT otherwise know availability. Returns each matching unit's free days + upcoming confirmed bookings over the horizon.",
        inputSchema: z.object({
          item: z.string().describe("Item to check, e.g. 'DJI Mini 4 Pro' or 'Sony FX3'"),
          horizon_days: z.number().optional().describe("Days ahead to check (default 21)"),
        }),
        execute: async ({ item, horizon_days }: { item: string; horizon_days?: number }) => {
          try {
            const r = await ctx.runQuery(api.calendar.getItemAvailabilityForChat, {
              query: item,
              horizonDays: horizon_days ?? 21,
              accountSlug: c.account_slug ?? null,
            });
            return JSON.stringify(r);
          } catch (e) {
            return `availability check failed: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),
    };
    const gen = await gatedGenerateText({
      model: await getActionLlmModel(useStrongModel ? { strong: true } : { haiku: true }),
      system,
      prompt,
      tools: draftTools,
      stopWhen: stepCountIs(4),
      bypass: true,
      context: { source: "replyInbox.generateDraft", tag: "reply_draft" },
    });
      if (gen.skipped) return { status: "skipped" };
      draft = (gen.result.text ?? "").trim();
      usedTools = ((gen.result as { steps?: Array<{ toolCalls?: unknown[] }> }).steps ?? [])
        .some((st) => (st.toolCalls?.length ?? 0) > 0);
    }
    if (!draft) return { status: "ok", draft };

    // ── Grounded self-check (lever 3) ────────────────────────────
    // Run one cheap Haiku pass that hedges any UNSUPPORTED factual claim before
    // the operator sees it. Runs when the thread is ungrounded (no listing facts)
    // OR is not a confirmed booking — because those threads have NO live
    // availability, yet the model loves to say "it's available this weekend".
    const isBookedThread =
      c.status === "confirmed" ||
      c.status === "completed" ||
      c.status === "ongoing";
    // usedTools is set above (true for a Mastra draft, or when the fallback
    // called a tool) — so the self-check never hedges a tool-verified answer.
    let checkedDraft = draft;
    if (!usedTools && (listingFacts.length === 0 || !isBookedThread)) {
      try {
        const groundingForCheck = [listingFactsBlock, factsBlock]
          .filter(Boolean)
          .join("\n\n");
        const chk = await gatedGenerateText({
          model: await getActionLlmModel({ haiku: true }),
          system:
            "You fact-check an equipment-rental owner's reply drafts. You get the GROUNDING (the only true facts) and a DRAFT. " +
            "Find any sentence that states a specific PRICE, a SPEC, what's INCLUDED, or that we OWN / have a specific item IN STOCK, which the grounding does NOT support. " +
            "CRITICAL — AVAILABILITY: there is NO live availability here, so the draft must NEVER say an item is 'available', 'free', or bookable for the renter's dates. ALWAYS rewrite any such claim to offer to check (e.g. 'let me check availability for those dates and confirm'). " +
            "Rewrite ONLY the unsupported parts to hedge; keep the tone and everything else word-for-word identical. If nothing needs changing, return the draft unchanged. Output ONLY the reply text.",
          prompt:
            "GROUNDING (the only facts you may treat as true):\n" +
            (groundingForCheck ||
              "(no item-level facts were available — so ANY specific price / spec / what's-included / availability / 'we have it in stock' claim is UNSUPPORTED and must be hedged)") +
            "\n\nDRAFT:\n" +
            draft +
            "\n\nReturn the corrected reply text only.",
          bypass: true,
          context: { source: "replyInbox.selfCheck", tag: "draft_selfcheck" },
        });
        if (!chk.skipped) {
          const revised = (chk.result.text ?? "").trim();
          // Keep the revision only if it's sane (non-empty, not runaway-long).
          if (revised && revised.length <= Math.floor(draft.length * 1.6))
            checkedDraft = revised;
        }
      } catch {
        /* self-check is best-effort — fall back to the raw draft */
      }
    }

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
    const guard = guardDraft(checkedDraft, {
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
      // Folds in freshInquiryItems (route.ts-resolved real facts for a
      // renter's first message, before any order exists) alongside the
      // order-linked signals above — see freshInquiryItems' own comment for
      // why this can't just be done at hasItemGrounding's declaration.
      hasItemGrounding: hasItemGrounding || freshInquiryItems.length > 0,
      factPack: c.fact_pack || listingFacts.some((f) => f.daily_price != null) || freshInquiryItems.length || noKitItems.length
        ? {
            // Merge the REAL listing prices in so the guard treats a correct £70
            // quote as valid (the generic catalog would flag it vs its £40 range).
            pricing: listingFacts.some((f) => f.daily_price != null) || freshInquiryItems.length
              ? {
                  itemPrices: [
                    ...listingFacts
                      .filter((f) => f.daily_price != null)
                      .map((f) => ({ name: f.name, min: f.daily_price as number, max: f.daily_price as number })),
                    ...freshInquiryItems
                      .filter((f) => f.dailyRateGbp != null)
                      .map((f) => ({ name: f.name, min: f.dailyRateGbp as number, max: f.dailyRateGbp as number })),
                  ],
                }
              : undefined,
            verifiedListingItem: c.fact_pack?.verifiedListingItem,
            marketingItems: c.fact_pack?.marketingItems,
            // Items we hold NO "what's included" text for. The agent is told
            // not to invent kit for these; this makes it enforceable rather
            // than advisory (see draft_guard KIT_HALLUCINATION).
            itemsWithoutKitData: [
              ...noKitItems,
              ...listingFacts.filter((f) => !f.description).map((f) => f.name),
            ].filter(
              (n, i, arr) =>
                !!n &&
                arr.indexOf(n) === i &&
                // Drop any name that DOES have kit text from another listing.
                !listingFacts.some((f) => f.name === n && !!f.description),
            ),
          }
        : undefined,
      availability: c.availability || freshInquiryItems.length
        ? {
            items: [
              ...(c.availability?.items ?? []).map((it) => ({
                name: it.name,
                available: it.available,
              })),
              // freshInquiryItems only ever contains items route.ts already
              // confirmed owned/not-marketing-only (see its own filter) — the
              // renter's ACTUAL requested dates are compared by the agent
              // itself against the booking-dates line in groundTruth, not
              // here; this just tells guardDraft "this item is real and
              // resolvable", not "free for any date".
              ...freshInquiryItems.map((it) => ({ name: it.name, available: true })),
            ],
          }
        : undefined,
    });
    // Hard backstop for ANY unresolved critical-severity guardDraft flag.
    // Live-reproduced repeatedly on a bare first-contact "is X available":
    // UNGROUNDED_AVAILABILITY + UNGROUNDED_PRICE (confident "not available" +
    // fabricated substitute + fabricated price), then on a second, different
    // item PRICE_HALLUCINATION alone (a confidently stated £73.50 vs the real
    // catalog's £145 — the availability claim wasn't even flagged that time).
    // Started this backstop scoped to just those first two flag types; the
    // PRICE_HALLUCINATION case proved that was whack-a-mole — every critical
    // type (FALSE_ACTION_CLAIM, PREMATURE_CONFIRMATION,
    // MARKETING_ITEM_AVAILABLE, EQUIPMENT_SUBSTITUTION, FABRICATED_QUOTE,
    // UNFULFILLABLE_BOOKING, etc. — see SEVERITY map) represents the same
    // class of confidently-wrong claim, which is exactly why the codebase's
    // own taxonomy already marks them "critical" rather than high/medium/low.
    // usedTools/the self-check above are too coarse to prevent this reliably
    // (a tool call happening somewhere in the turn doesn't mean THIS claim
    // was verified — confirmed live: usedTools=true on a run that still
    // fabricated both availability and price). guardDraft's own per-flag
    // detection has been 100% precise across every reproduction so far, it
    // just doesn't act on "flagged" (review-only, per ReplyInbox.tsx's
    // "Never blocks — informs" design) — and a small amber "⚠ N to review"
    // is too easy to miss for a claim this consequential (lost booking, or a
    // promise Daniel can't keep). So: any unresolved critical flag escalates
    // instead of drafting. A genuine "let me check and get back to you" is
    // always safe; a confident fabrication is not.
    const unresolvedCriticalFlags = guard.flags.filter(
      (f) => f.action === "flagged" && f.severity === "critical",
    );
    if (unresolvedCriticalFlags.length > 0) {
      return { status: "skipped", reason: "needs_human" };
    }

    const finalDraft = guard.text.trim() || checkedDraft;

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
      usedTools, // diagnostic: did the agent actually call a grounding tool this turn
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

    // Grab the draft that was shown BEFORE recordSentReply clears/rotates it, so
    // the learner can compare it to what the owner actually sent.
    const shownDraft =
      (await ctx.runQuery(internal.draft_learning.getDraftText, { thread_id })) ?? "";

    const res = await sendManualRenterMessage({
      accountSlug: account_slug,
      hyggloOrderId: thread_id,
      text: body,
    });

    if (res.status === "sent") {
      await ctx.runMutation(internal.replyInbox.recordSentReply, {
        thread_id,
        account_slug,
        text: body,
        message_id: `manual:${crypto.randomUUID()}`,
      });

      // SELF-IMPROVEMENT: on every real send, hand the sent reply + the draft
      // that was shown to the analyzer. It classifies how the draft was used
      // (rewrote / from-scratch / kept-and-added / used-as-is) and only learns
      // when it wasn't just used as-is. Async, never blocks the send.
      await ctx.scheduler.runAfter(0, internal.draft_learning_actions.analyzeDivergence, {
        thread_id,
        account_slug,
        sent_text: body,
        draft_text: shownDraft,
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
