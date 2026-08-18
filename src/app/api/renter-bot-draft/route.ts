import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, type RenterBotOutput } from "@/mastra/agents/renter_bot";
import {
  OUT_OF_SCOPE_INTENTS,
  type RenterBotIntent,
} from "@/../convex/lib/renter_bot_intents";

const accountCommunicationRef = makeFunctionReference<"query">(
  "settings:listAccountCommunication",
);

// Conversational/date/question filler — NOT item-name content. Strips a free-
// text renter message down to whatever's left, for feeding
// calendar.getItemAvailabilityForChat's fuzzy matcher a focused candidate
// instead of the whole sentence. Live-tested: passing the raw message "Hey is
// the Sony A7 V available 25th to 27th August?" matched "Sony 11mm f2.8
// fisheye" (wrong item) — noise tokens (question/date words) apparently
// out-scored the real item's own tokens. A stopword-filtered "sony a7 v"
// resolved correctly. Not exhaustive — a genuine miss just leaves groundTruth
// empty (same as today), so err on the side of stripping too much.
const ITEM_QUERY_STOPWORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","i","im","you","your","my","me","we","our","us",
  "he","she","it","they","them","their","this","that","these","those","and","or","but","if","then","so",
  "to","of","for","with","without","on","in","at","by","from","as","up","out","over","under","again",
  "not","no","yes","do","does","did","can","could","would","should","will","shall","may","might","must",
  "hi","hey","hello","thanks","thank","please","pls","just","really","also","still","yet","already","ok","okay",
  "available","availability","free","freely","book","booking","bookings","rent","rental","rentals","hire","hiring",
  "get","getting","need","needing","want","wanting","looking","check","checking","confirm","confirming",
  "today","tomorrow","tonight","yesterday","week","weekend","weekday","month","year","day","days","date","dates",
  "time","times","morning","afternoon","evening","night","next","last","this","upcoming",
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "jan","january","feb","february","mar","march","apr","april","jun","june","jul","july",
  "aug","august","sep","sept","september","oct","october","nov","november","dec","december",
  "what","when","where","who","why","how","which","one","some","any","anything","something","else",
]);
function extractItemQuery(message: string): string {
  const tokens = (message.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    // strip a bare ordinal suffix stuck to a date number, e.g. "25th" -> "25"
    .map((t) => t.replace(/^(\d+)(st|nd|rd|th)$/, "$1"))
    .filter((t) => t.length > 0 && !ITEM_QUERY_STOPWORDS.has(t));
  return tokens.join(" ");
}

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Production draft path — the agentic Mastra renter bot. Given a thread, it pulls
 * the account + latest renter message, gives the agent TODAY's date, runs it, and
 * returns { draft, needs_human, factsClaimed }. Called by convex generateDraft
 * (which keeps the guard + setDraft + learning). This is the bot; the old
 * single-shot is only a fallback if this errors.
 */
export async function POST(req: Request) {
  const expected = process.env.RENTER_BOT_API_SECRET;
  const authorization = req.headers.get("authorization");
  if (!expected || authorization !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { thread_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const { thread_id } = body;
  if (!thread_id) return NextResponse.json({ ok: false, error: "no_thread_id" }, { status: 400 });

  const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  const convex = new ConvexHttpClient(convexUrl);

  let account_slug = "";
  let lastRenter = "";
  let recentTranscript = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rc: any = await convex.query(api.renter_bot_tools.get_renter_context, { thread_id });
    account_slug = rc?.account_slug ?? "";
    const msgs = (rc?.last_messages ?? []) as Array<{ sender?: string; body?: string }>;
    const r = [...msgs].reverse().find((m) => m.sender === "renter");
    lastRenter = r?.body ?? "";
    recentTranscript = msgs
      .map((m) => `${m.sender === "renter" ? "Renter" : "Owner"}: ${m.body ?? ""}`)
      .join("\n");
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "context_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

  // PRE-FETCH the ground truth (Haiku under-calls its tools, so we hand it the
  // requested listing + its real availability up front — it must not contradict
  // these). The agent can still call check_location, search_knowledge, etc.
  let groundTruth = "";
  const marketingItems: string[] = [];
  let bookingConfirmed = true; // stays true when we can't tell (avoid false blocks)
  // Structured echo of whatever real facts made it into groundTruth above,
  // for the ORDER-linked path and the fresh-inquiry path below alike.
  // replyInbox_actions.ts's hasItemGrounding / guardDraft's factPack only
  // look at fields on the conversation DOCUMENT (c.fact_pack, c.availability)
  // — text injected into THIS prompt has zero effect on that separate check,
  // so a correctly-grounded draft was still getting hard-escalated as
  // "UNGROUNDED_PRICE"/"UNGROUNDED_AVAILABILITY" after the groundTruth
  // extension shipped. Returning this lets the caller fold it in.
  const resolvedItems: Array<{ name: string; dailyRateGbp?: number }> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lc: any = await convex.query(api.renter_bot_tools.get_listing_context, { thread_id });
    if (lc?.found) {
      bookingConfirmed = lc.is_confirmed === true;
      const req: string[] = [];
      if (lc.start_date) req.push(`dates ${lc.start_date}${lc.end_date && lc.end_date !== lc.start_date ? "–" + lc.end_date : ""}`);
      if (lc.gross_paid_gbp != null) req.push(`total £${lc.gross_paid_gbp}`);
      req.push(bookingConfirmed ? "status: CONFIRMED" : "status: NOT confirmed (pending)");
      groundTruth += `REQUESTED (ground truth — do NOT contradict): ${req.join(", ")}.\n`;
      if (!bookingConfirmed) {
        const inviteLine = lc.is_inquiry
          ? `This is an ENQUIRY (no booking placed yet) — just confirm the item is available and answer warmly. Do NOT tell them to "send a request" or "complete a booking" merely to get info/a quote; only talk booking if they say they're ready.`
          : `You MAY confirm the item is AVAILABLE and warmly invite them to complete the booking to lock it in — nothing beyond that.`;
        groundTruth += `⚠️ THIS BOOKING IS NOT CONFIRMED — funds may be reserved but it is NOT locked in. Do NOT say "booked", "confirmed", "paid", "it's yours", "all set", "reserved for you", or anything implying it's secured. ${inviteLine}\n`;
      }
      for (const it of (lc.items ?? []).slice(0, 3) as Array<{ name?: string; daily_price_gbp?: number; whats_included?: string; owned?: boolean; kind?: string | null }>) {
        if (it.owned === false) {
          marketingItems.push(it.name ?? "that item");
          let altText = "";
          // Real bug (2026-08-17): the Mastra TOOL now requires `kind` so the
          // agent can never omit it (see renter_bot_tools.ts), but THIS is a
          // direct server-side query call that bypasses that Zod validation.
          // Without kind, the underlying query falls back to weak name-token
          // similarity, which can rank a wrong-category item near the top (a
          // lens sharing only "Sony" with an unavailable camera, in the case
          // that surfaced this). Skip the substitute entirely rather than
          // risk offering the wrong kind of gear — no suggestion is safer
          // than a nonsensical one.
          if (it.kind) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const alts: any = await convex.query(api.renter_bot_tools.find_owned_alternatives, {
                account_slug: account_slug || "",
                kind: it.kind,
                item_name: it.name ?? undefined,
                exclude_name: it.name ?? undefined,
              });
              const list = ((alts?.alternatives ?? []) as Array<{ name?: string; daily_price_gbp?: number }>)
                .slice(0, 5)
                .map((a) => `${a.name}${a.daily_price_gbp != null ? ` (£${a.daily_price_gbp}/day)` : ""}`);
              if (list.length) altText = ` Recommend ONE of these we DO own instead, by name: ${list.join("; ")}.`;
            } catch {
              /* best-effort alternatives */
            }
          }
          groundTruth += `- ${it.name}: we CANNOT rent this to the renter. Do NOT confirm or quote it, and NEVER say why — no "stock", "own", "have (one/that)", "on hand", "inventory", "marketing", "display". Frame it ONLY as not available for their dates, then IMMEDIATELY recommend a real alternative BY NAME. Do NOT ask them what focal length / mount / type of shoot they want — just offer the alternative(s).${altText}\n`;
          continue;
        }
        groundTruth += `- ${it.name}: £${it.daily_price_gbp ?? "?"} /day. Included: ${it.whats_included ?? "(not listed)"}\n`;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const av: any = await convex.query(api.calendar.getItemAvailabilityForChat, {
            query: it.name ?? "",
            horizonDays: 30,
            accountSlug: account_slug || null,
          });
          const m = (av?.items ?? [])[0];
          if (m) {
            const reqDate = lc.start_date as string | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bookings = (m.upcoming_bookings ?? []) as Array<any>;
            const addHour = (hm: string) => {
              const [h, mn] = hm.split(":").map(Number);
              const t = (h * 60 + (mn || 0) + 60) % (24 * 60);
              return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
            };
            // Bookings are {pickup:"YYYY-MM-DD HH:MM", return:"YYYY-MM-DD HH:MM"}.
            // If one RETURNS on the requested day, the item is free 1 HOUR after
            // that return time (turnaround buffer) — not fully booked, not free.
            let conflict = false;
            let turnaround: string | null = null;
            if (reqDate) {
              for (const b of bookings) {
                const pDate = String(b.pickup ?? "").split(" ")[0];
                const rParts = String(b.return ?? "").split(" ");
                const rDate = rParts[0];
                const rTime = rParts[1];
                if (pDate && rDate && pDate <= reqDate && rDate >= reqDate) {
                  if (rDate === reqDate && rTime) turnaround = addHour(rTime);
                  else conflict = true;
                }
              }
            }
            const verdict = turnaround
              ? `it's out on another rental that RETURNS ${reqDate} — so it's only free from ${turnaround} that day (1-hour turnaround buffer); do NOT offer it before ${turnaround}, and only inside a pickup window`
              : conflict
                ? `BOOKED on ${reqDate} — NOT available; offer the next free date (${m.next_free_date ?? "?"})`
                : bookings.length === 0
                  ? `FREE — no bookings, available for ${reqDate ?? "the requested date"}`
                  : `no booking conflict on ${reqDate} — available`;
            groundTruth += `  AVAILABILITY (${it.name}): ${verdict}.\n`;
          }
        } catch { /* best-effort */ }
      }
      // RULE 10 — Minimum Rental Value. Nudge small bookings up (add-ons first,
      // then adjust the total) WITHOUT ever revealing a threshold.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settings: any = await convex.query(api.settings.get, {});
        const minGbp = typeof settings?.minimum_rental_gbp === "number" ? settings.minimum_rental_gbp : 40;
        let total = typeof lc.gross_paid_gbp === "number" ? lc.gross_paid_gbp : 0;
        if (!total) {
          let days = 1;
          if (lc.start_date && lc.end_date) {
            const dd = (new Date(lc.end_date).getTime() - new Date(lc.start_date).getTime()) / 86400000;
            if (dd >= 1) days = Math.round(dd);
          }
          for (const it of (lc.items ?? []) as Array<{ owned?: boolean; daily_price_gbp?: number }>) {
            if (it.owned !== false && typeof it.daily_price_gbp === "number") total += it.daily_price_gbp * days;
          }
        }
        if (total > 0 && total < minGbp) {
          groundTruth += `BOOKING TOTAL is only ~£${Math.round(total)} — this is a small booking. DANIEL RULE 10 (Minimum Rental Value): FIRST naturally suggest a relevant add-on or two that we OWN (an extra lens, a gimbal, a monitor, lighting, extra batteries/cards) to lift the total; if they decline, warmly offer to adjust the booking total (e.g. a slightly longer hire). NEVER reveal there is a minimum, NEVER name a threshold or the words "minimum rental value", NEVER mention revenue or earnings.\n`;
        }
      } catch {
        /* best-effort */
      }
      groundTruth +=
        "Use these facts for price, kit, dates and availability — do NOT assert availability/price beyond them. IMPORTANT: unless the facts show the booking is already PAID/confirmed, do NOT say \"it's all set\", \"confirmed\", \"it's yours\", or talk as if it's locked in — confirm availability warmly, then invite them to lock it in by completing the booking. And NEVER refer the renter to another lender, rental company, or competitor — keep every renter with us.\n";
    } else {
      // FRESH INQUIRY — no linked reservation yet (the common case for a
      // renter's very first "is X available" message, before any order
      // exists). Without this, groundTruth stays empty and the agent's only
      // grounding option is calling check_availability itself — which,
      // live-reproduced repeatedly, it does not reliably do, producing a
      // confidently fabricated "not available" + wrong substitute + wrong
      // price (now caught by the hard escalation backstop in
      // replyInbox_actions.ts, but that just means EVERY fresh inquiry
      // escalates to Daniel instead of drafting). Mirror the order-linked
      // block above: resolve the item(s) the renter is actually asking about
      // from their own message text (getItemAvailabilityForChat's existing
      // fuzzy/alias matcher — same one the calendar UI and the Lab use) and
      // hand the agent real rolling-calendar + real price up front.
      try {
        const itemQuery = extractItemQuery(lastRenter);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const av: any = itemQuery
          ? await convex.query(api.calendar.getItemAvailabilityForChat, {
              query: itemQuery,
              horizonDays: 30,
              accountSlug: account_slug || null,
            })
          : null;
        // Two live-caught false-match modes on a stopword-filtered query, both
        // guarded against below:
        // 1. A generic/no-signal query (e.g. pure logistics chatter, no item
        //    named) can tie dozens of items at the same low score — the
        //    matcher returns them all. match_count this high means "no real
        //    signal", not "the renter meant ~30 items" — don't use any of it.
        // 2. A single confident-LOOKING match can still be wrong: the
        //    matcher's haystack includes kind/aliases, not just the visible
        //    name, so pure filler tokens (no real item mentioned at all) can
        //    score >=2 against something's kind/alias by chance (caught one
        //    live: unrelated chatter matched "Smoke machine fogger"). Cross-
        //    check that the matched item's own NAME contains at least one
        //    extracted token before trusting it.
        const queryTokens = itemQuery.split(" ").filter((t) => t.length >= 3);
        const tooGeneric = (av?.match_count ?? 0) > 5;
        type AvItem = {
          name?: string;
          owned?: boolean;
          is_marketing_only?: boolean;
          next_free_date?: string | null;
          free_whole_horizon?: boolean | null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          upcoming_bookings?: Array<any>;
        };
        const matches: AvItem[] = tooGeneric
          ? []
          : ((av?.items ?? []) as AvItem[])
              .filter(
                (m) =>
                  m.name &&
                  queryTokens.some((t) => m.name!.toLowerCase().includes(t)),
              )
              .slice(0, 3); // cap — a vague query can still match a couple items; don't dump the whole catalog
        if (matches.length) {
          groundTruth += "REQUESTED ITEM(S) — resolved from the renter's own message, real live data:\n";
          for (const m of matches) {
            if (!m.name) continue;
            if (m.owned === false || m.is_marketing_only) {
              groundTruth += `- ${m.name}: we CANNOT rent this to the renter (marketing-only / not owned). Do NOT confirm or quote it, and NEVER say why. Frame it ONLY as not available for their dates, then recommend a real alternative if you know one.\n`;
              continue;
            }
            let priceLine = "";
            let dailyRateGbp: number | undefined;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pricing: any = await convex.query(api.renter_bot_tools.lookup_pricing, {
                item_name: m.name,
                account_slug: account_slug || undefined,
              });
              if (pricing?.found && typeof pricing.daily_rate_gbp === "number") {
                dailyRateGbp = pricing.daily_rate_gbp;
                priceLine = ` £${dailyRateGbp}/day.`;
              }
            } catch {
              /* best-effort */
            }
            resolvedItems.push({ name: m.name, dailyRateGbp });
            // upcoming_bookings carries a real OTHER renter's name — never put
            // that in a prompt that drafts a reply to THIS renter. Dates only.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bookingDates = (m.upcoming_bookings ?? [])
              .slice(0, 5)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((b: any) => `${String(b.pickup ?? "").split(" ")[0]}→${String(b.return ?? "").split(" ")[0]}`);
            const verdict = m.free_whole_horizon
              ? "FREE for the next 30 days — no bookings in that window"
              : bookingDates.length
                ? `has existing bookings on: ${bookingDates.join(", ")} (dates outside this list are free within the next 30 days)`
                : `next confirmed-free date: ${m.next_free_date ?? "unknown — treat as unconfirmed, offer to check exact dates"}`;
            groundTruth += `- ${m.name}: ${verdict}.${priceLine}\n`;
          }
          groundTruth +=
            "Compare the renter's requested dates against the booking list above yourself (you know today's date). Use ONLY this data for availability/price on these item(s) — do NOT call check_availability again for the same item, and do NOT state a price that isn't given above.\n";
          // RULE 10 — Minimum Rental Value, extended to fresh inquiries
          // (Daniel, 2026-08-18): previously this nudge only fired in the
          // order-linked branch above, so it never ran during a renter's
          // first "is X available" message — the exact moment a small
          // booking is still being decided, arguably more useful than
          // nudging after an order already exists. No real dates yet here,
          // so use the single-day rate as a conservative "at least this
          // small" signal rather than guessing a duration.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const settings: any = await convex.query(api.settings.get, {});
            const minGbp = typeof settings?.minimum_rental_gbp === "number" ? settings.minimum_rental_gbp : 40;
            const singleDayTotal = resolvedItems.reduce(
              (sum, it) => sum + (typeof it.dailyRateGbp === "number" ? it.dailyRateGbp : 0),
              0,
            );
            if (singleDayTotal > 0 && singleDayTotal < minGbp) {
              groundTruth += `RESOLVED ITEM(S) ABOVE total only ~£${Math.round(singleDayTotal)}/day — likely a small booking. DANIEL RULE 10 (Minimum Rental Value): FIRST naturally suggest a relevant add-on or two that we OWN (an extra lens, a gimbal, a monitor, lighting, extra batteries/cards) to lift the total; if they decline, warmly offer to adjust the booking total (e.g. a slightly longer hire). NEVER reveal there is a minimum, NEVER name a threshold or the words "minimum rental value", NEVER mention revenue or earnings.\n`;
            }
          } catch {
            /* best-effort */
          }
        }
      } catch {
        /* best-effort — if this fails, groundTruth just stays empty as before */
      }
    }
  } catch {
    /* best-effort ground truth */
  }

  // Per-account PICKUP location — share ONLY after the booking is confirmed.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [hubs, communications] = await Promise.all([
      convex.query(api.settings.listAccountHubs, {}),
      convex.query(accountCommunicationRef, {}),
    ]);
    const hub = (hubs || []).find((h: { slug?: string }) => h.slug === account_slug);
    const communication = (communications || []).find(
      (row: { slug?: string }) => row.slug === account_slug,
    ) as {
      draft_text_blocks?: {
        opening?: string;
        availability?: string;
        location?: string;
        pickup_time?: string;
        payment?: string;
      };
    } | undefined;
    if (hub?.pickup_address) {
      groundTruth += bookingConfirmed
        ? `PICKUP LOCATION (booking IS confirmed — OK to share): ${hub.pickup_address}. Give this exact address when arranging pickup and ask them to text "arrived" when they get there — no need to go inside.\n`
        : `PICKUP LOCATION for this account is "${hub.pickup_address}" — do NOT reveal it yet (booking not confirmed). Say you'll send the exact pickup address the moment the booking is confirmed. NEVER give a different or made-up address.\n`;
    }
    // Time-aware pickup/return windows (per account) — at 4pm the morning slot
    // is gone, so only offer windows that haven't passed today.
    const hours = (hub?.pickup_hours && hub.pickup_hours.length
      ? hub.pickup_hours
      : [{ start: "10:00", end: "12:00" }, { start: "19:00", end: "21:00" }]) as Array<{ start: string; end: string }>;
    const nowHM = new Date().toLocaleString("en-GB", {
      timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit",
    });
    const toMin = (t: string) => {
      const [h, m2] = t.split(":").map(Number);
      return h * 60 + (m2 || 0);
    };
    const nowMin = toMin(nowHM);
    const fmt = (w: { start: string; end: string }) => `${w.start}–${w.end}`;
    const remaining = hours.filter((w) => toMin(w.end) > nowMin + 15);
    groundTruth +=
      `CURRENT LONDON TIME: ${nowHM}. Pickup/return windows for this account: ${hours.map(fmt).join(", ")} — NEVER agree to any time outside these. ` +
      (remaining.length
        ? `Windows still open TODAY: ${remaining.map(fmt).join(", ")} — offer the EARLIEST of these first; do NOT offer a window that has already passed today (e.g. don't offer a morning slot in the afternoon).`
        : `No windows remain today — for today it's too late, offer tomorrow's first window (${fmt(hours[0])}).`) + `\n`;
    const blocks = communication?.draft_text_blocks;
    const controlledWording = blocks
      ? [
          ["Opening / greeting", blocks.opening],
          ["Availability / booking", blocks.availability],
          ["Location", blocks.location],
          ["Pickup / return time", blocks.pickup_time],
          ["Payment", blocks.payment],
        ]
          .filter(([, text]) => typeof text === "string" && text.trim().length > 0)
          .map(([label, text]) => `- ${label}: ${text}`)
          .join("\n")
      : "";
    if (controlledWording) {
      groundTruth +=
        "OPERATOR-CONTROLLED DRAFT WORDING — use the relevant block when the renter asks about that topic. Preserve operational facts exactly, adapt only grammar, and never reveal the pickup address before a booking is confirmed:\n" +
        controlledWording +
        "\n";
    }
  } catch {
    /* best-effort */
  }

  // Hard top-line directive when the renter is asking about gear we can't rent.
  const marketingDirective = marketingItems.length
    ? `🚫 INTERNAL — DO NOT REVEAL: we cannot rent ${marketingItems.join(", ")} to this renter. Do NOT tell them it's "marketing-only", a "display listing", that we "don't stock/own it", or explain why — that is INTERNAL and must never be said. Simply say that exact one isn't available for their dates, and warmly recommend a real alternative we own (by name, with its price). NEVER say ${marketingItems.join(", ")} is available / ready / works for pickup.\n\n`
    : "";

  const baseMessages = [
    {
      role: "user" as const,
      content: [
        marketingDirective,
        `TODAY IS ${today} (Europe/London). Compute any relative dates the renter uses from TODAY; never guess a date.`,
        `THREAD: ${thread_id}`,
        `ACCOUNT: ${account_slug}`,
        groundTruth ? `\n${groundTruth}` : "",
        `LATEST INBOUND MESSAGE FROM RENTER:`,
        lastRenter,
      ].join("\n"),
    },
  ];

  try {
    let obj: RenterBotOutput | null = null;
    // Real tool-call trace (same shape used in renter-bot-ab/route.ts's debug
    // trace) — replyInbox_actions.ts uses this to decide whether its
    // "grounded self-check" hedge pass can be skipped. Previously that
    // caller hardcoded usedTools=true for every successful Mastra draft on
    // the assumption "the agent grounds via its own tools", which is not
    // guaranteed — Haiku is documented to under-call tools. When groundTruth
    // above is empty (no linked reservation yet — the common case for a
    // renter's very first "is X available" message, before any order exists)
    // this tool-call signal is the ONLY grounding check available.
    let usedTools = false;
    let text = "";
    // Quick Reply is an explicit, on-demand OpenRouter/Haiku call with no
    // subscription lane and no automatic stronger-model route.
    if (!obj) {
      const agent = await getRenterBotAgent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await (agent as any).generate(baseMessages, {
        maxSteps: 10,
        // Root cause found live (2026-08-17): with no cap set, Gemini 3.7
        // Flash (a reasoning model — thinks before it speaks, same behavior
        // documented in /api/walle/health) was returning a completely EMPTY
        // result.text on some real calls, presumably burning the default
        // output budget on internal reasoning/tool-call bookkeeping before
        // it ever got to the final JSON. That parsed as "no decision" and
        // auto-escalated via the (!obj) branch below — a silent, structural
        // regression from the Haiku->Gemini swap, not a model judgment call.
        // Confirmed via debugRawText: multiple real calls returned "" (empty
        // string), not malformed JSON. 4096 is well above a one-word reply's
        // "512 was enough" baseline from the WallE health probe, sized for
        // this agent's actual multi-field structured JSON output.
        modelSettings: { maxOutputTokens: 4096 },
      });
      text = result?.text ?? "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      usedTools = ((result?.steps ?? []) as any[]).some(
        (st) => (st?.toolCalls?.length ?? 0) > 0,
      );
    try {
      let js = text.trim();
      const fence = js.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) js = fence[1].trim();
      const a = js.indexOf("{");
      const b = js.lastIndexOf("}");
      if (a >= 0 && b > a) obj = JSON.parse(js.slice(a, b + 1)) as RenterBotOutput;
    } catch {
      obj = null;
    }
    }
    if (!obj) {
      // Couldn't parse a decision — escalate rather than send garbage.
      return NextResponse.json({ ok: true, draft: "", needs_human: true, factsClaimed: [] });
    }

    // SECOND CHANCE (2026-08-17): if the agent escalated WITHOUT ever calling
    // a tool, and this isn't a genuinely urgent intent, give it one grounded
    // retry before accepting the escalation. Real, repeatedly confirmed
    // finding: the agent sometimes sets needs_human=true on topic-based
    // caution (third-party access, international travel, lens compatibility)
    // without calling search_knowledge at all, even though a documented
    // answer exists — verified by calling this same route directly, which
    // DID call the tool and answered correctly. A system-prompt clarification
    // alone didn't move this (re-tested 8 fresh runs post-deploy, 7/8 still
    // escalated). This gives the agent the SAME real grounding a successful
    // run gets, explicitly — but it keeps full discretion: the note tells it
    // to still escalate if the match isn't actually relevant. Fails safe:
    // any error here, or a retry that itself still can't produce an answer,
    // leaves the original escalation untouched.
    if (
      obj.needs_human === true &&
      !usedTools &&
      !OUT_OF_SCOPE_INTENTS.has(obj.intent as RenterBotIntent)
    ) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hits: any = await convex.query(api.knowledge.search, {
          query: lastRenter,
          limit: 3,
        });
        const top = Array.isArray(hits) ? hits[0] : null;
        // relevance is a token-hit count (see convex/lib/knowledge_search.ts)
        // — require at least 2 matching tokens so a single generic word
        // doesn't count as "found something relevant".
        if (top && typeof top.relevance === "number" && top.relevance >= 2) {
          const retryMessages = [
            ...baseMessages,
            {
              role: "user" as const,
              content: `[SYSTEM NOTE: you set needs_human=true without calling search_knowledge this turn. It found this potentially relevant match — "${top.title}": "${top.content}". If this genuinely answers the renter's question, use it (cite it in factsClaimed with sourceTool "search_knowledge") and set needs_human=false. If it does not actually answer what they asked, you may still set needs_human=true.]`,
            },
          ];
          const retryAgent = await getRenterBotAgent(); // lazy singleton — cheap to re-fetch
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const retryResult: any = await (retryAgent as any).generate(retryMessages, {
            maxSteps: 6,
            modelSettings: { maxOutputTokens: 4096 },
          });
          const retryText: string = retryResult?.text ?? "";
          const retryUsedTools = ((retryResult?.steps ?? []) as any[]).some(
            (st) => (st?.toolCalls?.length ?? 0) > 0,
          );
          let retryObj: RenterBotOutput | null = null;
          try {
            let js = retryText.trim();
            const fence = js.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) js = fence[1].trim();
            const a = js.indexOf("{");
            const b = js.lastIndexOf("}");
            if (a >= 0 && b > a) retryObj = JSON.parse(js.slice(a, b + 1)) as RenterBotOutput;
          } catch {
            retryObj = null;
          }
          if (retryObj && (retryObj.draft || retryObj.needs_human === false)) {
            obj = retryObj;
            usedTools = retryUsedTools;
          }
        }
      } catch {
        /* best-effort — keep the original escalation on any failure */
      }
    }

    // BACKSTOP: never let a draft AFFIRM a phantom item is available. If the
    // marketing item's model token sits near availability/pickup language, the
    // bot is confirming an item we can't rent — blank it and escalate. (We do
    // NOT require the draft to "admit" anything — it just must not confirm it.)
    if (marketingItems.length && obj.draft && !obj.needs_human) {
      const d = obj.draft.toLowerCase();
      // POSITIVE availability of the phantom (near its model token) — but only
      // when NOT negated. "the 14mm isn't available" is a correct redirect, not
      // a confirmation, so the negation guard must exclude it.
      const AFFIRM =
        /(in stock|ready to go|ready for|works (perfectly|great|for you|today|fine)|all set|all yours|pop by|come by|come collect|head (to|over)|swing by|collect (it|the)|grab it|is available|are available|it'?s available|pick (it|that|them|one) up)/;
      const NEG =
        /(isn'?t|is not|are not|aren'?t|not|no longer|unavailable|can'?t|cannot|won'?t|unfortunately|afraid|sadly|sorry)/;
      let violated = false;
      for (const name of marketingItems) {
        const tokMatch = name.toLowerCase().match(/\b(\d{1,3}-?\d{0,3}\s?mm|mini\s?\d|a7\s?[a-z0-9]+|fx\s?\d|r[56]|fs\d)\b/);
        const tok = tokMatch ? tokMatch[0] : null;
        if (!tok) continue;
        const idx = d.indexOf(tok);
        if (idx < 0) continue;
        const win = d.slice(Math.max(0, idx - 45), idx + 65);
        if (AFFIRM.test(win) && !NEG.test(win)) {
          violated = true; // affirms the phantom is available, un-negated
          break;
        }
      }
      // Also block drafts that REVEAL the item is marketing / not owned. A soft
      // "that exact one isn't available for your dates" is fine — only the
      // marketing-revealing language (below) crosses the line.
      if (!violated) {
        const reveals =
          /marketing|display (listing|item|only|piece|model)|showcase|showroom|(don'?t|do not|doesn'?t|does not|never) (actually |currently )?(stock|own|carry)\b|not (in )?(our|my|the) (stock|inventory)|not one (i|we) (stock|own|actually)|isn'?t (in )?(stock|(our|my) inventory)|not (a )?(real|physical|genuine) (item|listing|product)/i.test(d);
        if (reveals) violated = true;
      }
      if (violated) {
        obj.draft = "";
        obj.needs_human = true;
      }
    }
    // Never refer a renter to a competitor / another lender — blank + escalate.
    if (obj.draft && !obj.needs_human) {
      const d2 = obj.draft.toLowerCase();
      const refersCompetitor =
        /(another|other|a different|a local|somewhere else) (lender|rental|hire|shop|supplier|provider|company|store|business|renter)|search (for\b.{0,40})?(rental|elsewhere|another|online)|try (another|a different|someone else|elsewhere)|from another (lender|local|rental|hire|shop|supplier)|other (lenders|rentals|hires|providers|suppliers)|rent(al)? (it )?(from|with) (another|someone)/i.test(d2);
      if (refersCompetitor) {
        obj.draft = "";
        obj.needs_human = true;
      }
    }
    // Never claim an unconfirmed booking is confirmed/paid/booked — escalate.
    // BUT "once/when your booking is confirmed" is a fine DEFERRAL, not a claim —
    // so check the words right before the confirmation term for a conditional.
    if (obj.draft && !obj.needs_human && !bookingConfirmed) {
      const d3 = obj.draft.toLowerCase();
      let falseConfirm = false;
      const re = /(confirmed|booked|all set|locked in|reserved|paid)/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(d3)) !== null) {
        const pre = d3.slice(Math.max(0, mm.index - 28), mm.index);
        const asserts = /(your booking is|it'?s|it is|you'?re|you are|now|all)\s*$/.test(pre);
        const conditional = /\b(once|when|after|as soon as|until|to|complete|lock|get|be|gets|being|makes|before)\b/.test(pre);
        if (asserts && !conditional) {
          falseConfirm = true;
          break;
        }
      }
      if (falseConfirm) {
        obj.draft = "";
        obj.needs_human = true;
      }
    }
    // Never agree to an off-hours pickup/return — windows are 10–12 & 7–9pm.
    if (obj.draft && !obj.needs_human) {
      const d4 = obj.draft.toLowerCase();
      const offHours =
        /\b(this |the )?afternoon\b.{0,30}(work|fine|good|great|perfect|suit|see you|pick|collect|sounds|lovely)|(work|fine|good|great|perfect|see you|pick|collect|sounds|lovely).{0,25}\b(this |the )?afternoon\b|\b([1-6])\s?(pm|o'?clock)\b.{0,25}(work|fine|good|great|perfect|suit|see you|sounds|pick|collect|that'?s|lovely)/i.test(d4);
      if (offHours) {
        obj.draft = "";
        obj.needs_human = true;
      }
    }
    // Cosmetic cleanup: fix Diogo spelling + cap emoji overuse (DB Cinema = none).
    if (obj.draft && !obj.needs_human) {
      let text = obj.draft;
      if ((account_slug || "").toLowerCase() === "diogo") {
        text = text.replace(/\bDiego\b/g, "Diogo");
      }
      const maxEmoji = (account_slug || "").toLowerCase() === "dbcinema" ? 0 : 1;
      const emojiRe = /\p{Extended_Pictographic}/gu;
      const found = text.match(emojiRe) || [];
      if (found.length > maxEmoji) {
        let kept = 0;
        text = text.replace(emojiRe, (m) => (++kept <= maxEmoji ? m : ""));
        text = text.replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n");
      }
      obj.draft = text;
    }
    return NextResponse.json({
      ok: true,
      draft: obj.draft ?? "",
      needs_human: !!obj.needs_human,
      intent: obj.intent ?? null,
      factsClaimed: obj.factsClaimed ?? [],
      usedTools,
      resolvedItems,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "agent_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
