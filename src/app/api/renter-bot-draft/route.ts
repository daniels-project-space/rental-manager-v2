import { NextResponse } from "next/server";
import { sameMount } from "../../../../convex/lib/item_name_match";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, type RenterBotOutput } from "@/mastra/agents/renter_bot";
import {
  OUT_OF_SCOPE_INTENTS,
  type RenterBotIntent,
} from "@/../convex/lib/renter_bot_intents";
import { resolvePickupHours, remainingWindowsToday } from "@/lib/pickup-hours";

const accountCommunicationRef = makeFunctionReference<"query">(
  "settings:listAccountCommunication",
);

/**
 * Conversation craft — the difference between a lookup service and a lender
 * someone wants to rent from. Added 2026-08-21 after a live multi-turn review
 * where every individual fact was eventually right but the CONVERSATION was
 * unusable: the same "that exact one isn't available" sentence opened all
 * three replies, a lens question was answered with a different brand's body,
 * and a "can I collect the day before?" was priced as an extra day with no
 * explanation and no offer.
 *
 * These are craft rules, not fact rules — they never license a claim that the
 * ground-truth block above doesn't support.
 */
/**
 * Every price the SYSTEM returned to the model, harvested from tool results.
 *
 * The fact pack is not the only grounded source: the agent calls
 * find_owned_alternatives / lookup_pricing mid-turn, and those results carry
 * real prices straight from our listings. The draft guard cannot see tool
 * results, so a correctly-quoted £26 anamorphic came back as a critical
 * PRICE_HALLUCINATION and the reply was withheld. Walk the tool output and
 * treat any price-shaped number in it as grounded — because it is ours.
 */
function harvestToolPrices(steps: unknown, into: number[]): void {
  const PRICE_KEY = /(price|rate|gbp|per_day|perday|daily|total|min|max)/i;
  const seen = new Set<unknown>();
  const walk = (node: unknown, keyHint = ""): void => {
    if (node == null || seen.has(node)) return;
    if (typeof node === "number") {
      if (PRICE_KEY.test(keyHint) && Number.isFinite(node) && node > 0 && node < 10000)
        into.push(Math.round(node));
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v, keyHint);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k);
  };
  for (const st of (steps as Array<{ toolResults?: unknown }>) ?? [])
    walk(st?.toolResults ?? null);
}

const CONVERSATION_CRAFT = `
CONVERSATION CRAFT — how to actually write the reply:

1. NEVER REPEAT YOURSELF ACROSS TURNS. Look at the conversation so far. If you
   have already told this renter an item is unavailable, or already given the
   pickup windows, or already named an alternative, do NOT restate it. Say it
   ONCE, then move the conversation forward. Re-opening consecutive replies
   with the same sentence reads like a broken machine. Answer THIS message's
   actual question first, in your first sentence.

2. ANSWER THE QUESTION THAT WAS ASKED. If they ask "does it include a lens?",
   the reply must begin by answering about a LENS for the item under
   discussion. Do not restate availability, do not pivot to a different
   product line, and do not answer about a different camera than the one being
   discussed. If they asked about a Blackmagic, answer about that Blackmagic.

3. STAY IN THE RENTER'S SYSTEM. A substitute should be the same category and,
   where possible, the same brand/family and lens mount, so their existing
   glass and workflow still fit. Only cross to a different system if nothing
   closer exists — and if you do, say so plainly ("that's a different system,
   so your EF glass wouldn't fit") rather than silently swapping brand.

4. LENSES AND KIT — BE USEFUL, NOT JUST ACCURATE. If a body is offered without
   glass, don't stop at "lens not included". Immediately offer to add a
   specific lens we own that fits its mount, and say what that would cost.
   "Body only, but I can add the [lens] for £X/day so you're ready to shoot"
   is the standard. Never state kit contents that aren't in the facts above.

5. DAY-COUNT REQUESTS ARE A NEGOTIATION, NOT A REJECTION. When someone asks to
   collect earlier or return later, explain the rule in ONE clear sentence,
   then offer the workable version. Late-evening collection the night before
   and an early-morning return can often make a 2-day booking function as a
   single shooting day — if the calendar allows it, offer exactly that, with
   the concrete windows. Lead with what they CAN have, not what they can't.

6. UPSELL WITH RELEVANCE. Suggest only gear that genuinely serves the shoot
   they described, and at most one or two items. A relevant lens or support for
   a camera booking is helpful; a random accessory list is noise.

7. Never repeat the pickup windows in consecutive messages, and never restate
   the price they already have unless it changed or they asked again.

8. NEVER SAY WE DON'T HAVE SOMETHING UNLESS THE FACTS SAY SO. A confident "I
   don't have a wide lens for that" costs a booking exactly like a false
   "it's unavailable" does, and it is just as unfounded when you are guessing.
   Live-caught: the bot told a renter there was no wide EF lens while a Canon
   EF 16-35mm f2.8 sat in the owned list at £20/day. If the facts above don't
   list what they asked for, either call find_owned_alternatives for that
   category/mount, or say you'll confirm — never assert an absence.

9. DO NOT INVENT PRODUCTS OR SPECS - BUT DO USE THE FACTS YOU HAVE. Only
   discuss models named in the facts above; never invent a variant. Never
   state sensor sizes, ND filters, screen types or resolutions unless that
   text is given to you. You MAY freely use what IS given - lens mount, price,
   kit contents, availability - to compare two products and help them choose,
   and you should: "the Pro is EF mount and the Full Frame is L-mount, so it
   depends which glass you have" is a genuinely useful answer built entirely
   from real data. Refusing to differentiate at all is not the goal; inventing
   is.

10. NEVER SELL SOMETHING THEY ARE ALREADY PAYING FOR. Before you offer any
    add-on, check the kit contents in the facts. If the item is already in
    this rental, say so as a POSITIVE ("it already comes with the 16-35 and
    the 24-105, so you're covered wide to long") — never quote a price for it.
    Live-caught: on a bundle that includes both Canon zooms, the bot offered
    those same two lenses at £12 and £20/day. Charging for included gear reads
    as a scam, and it hides the bundle's best selling point.

11. A BLOCKER YOU CAN SOLVE IS AN OFFER, NOT A FULL STOP. If you tell them
    something won't fit or isn't included — an adapter, a card, a battery,
    glass — check the facts for whether we own that part, and if we do, offer
    it BY NAME with its price in the same breath. Live-caught: the bot
    correctly said the PL-mount Blazar lenses need a PL-to-EF adapter that
    isn't included, and stopped there, while we rent that exact adapter. State
    the constraint and the fix together, or you have just talked them out of a
    booking you could have had.

12. WHEN THEY SAY YES, DO IT — DON'T ASK AGAIN. If the renter has asked you
    to add or remove gear or change dates, that IS the instruction. Call
    modify_booking, then tell them what the booking now contains and what it
    now costs. Asking "would you like me to lock those in?" about the very
    thing they just asked for is friction, not politeness, and it reads as
    though you weren't listening. Live-caught: they said "can you add the
    100mm and adapter", got told the items were available and asked AGAIN
    whether to go ahead. Only ask when something is genuinely ambiguous —
    which model, which dates. If modify_booking comes back ok:false, say what
    it tells you and NEVER claim the change happened — a removal that didn't
    happen is as damaging as an addition that didn't.

13. WRITE DATE RANGES AS A RANGE. "the 4th to the 6th of September", never
    "4th, 6th September" — a comma reads as two separate dates and is how a
    renter ends up arriving on the wrong day. Say the day count too when it
    matters to the price ("the 4th to the 6th, so 3 days").
`;

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

  let body: { thread_id?: string; craft_override?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const { thread_id } = body;
  if (!thread_id) return NextResponse.json({ ok: false, error: "no_thread_id" }, { status: 400 });

  /**
   * OPTIMISER HOOK — lets a caller swap the CONVERSATION_CRAFT block for a
   * candidate variant, so a prompt optimiser (GEPA) can score alternatives
   * against the conversation rubric without a redeploy per candidate.
   *
   * Safe by construction:
   *  - this endpoint already requires the Bearer RENTER_BOT_API_SECRET, so
   *    only we can reach it at all;
   *  - it swaps CRAFT rules only — never the ground-truth block, the tools, or
   *    any availability/price fact, so an optimiser cannot talk the bot into
   *    an ungrounded claim;
   *  - it is restricted to __probe__ threads, so a candidate prompt can never
   *    touch a real renter's conversation even by accident.
   */
  const craftOverride =
    typeof body.craft_override === "string" &&
    body.craft_override.length > 0 &&
    thread_id.startsWith("__probe__")
      ? body.craft_override
      : null;
  const craftRules = craftOverride ?? CONVERSATION_CRAFT;

  const convexUrl = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
  const convex = new ConvexHttpClient(convexUrl);

  let account_slug = "";
  let lastRenter = "";
  let recentTranscript = "";
  /**
   * Have we ALREADY told this renter the item isn't available?
   *
   * The concealment instruction re-fires on every turn, so it kept
   * re-prompting the same opener: the renter asked about price and got "The
   * RED Komodo isn't available for those dates, but..." for the third time.
   * That is the original "it repeated the same text on the top every time"
   * complaint, reintroduced by an instruction rather than by the model.
   */
  let alreadySaidUnavailable = false;
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
    alreadySaidUnavailable = msgs.some(
      (m) =>
        m.sender !== "renter" &&
        /\b(is\s?n[o']?t available|not available|unavailable|isn'?t free)\b/i.test(m.body ?? ""),
    );
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
  // Defaults FALSE — this must FAIL CLOSED. It gates pickup-address disclosure
  // (below) and the false-confirmation guard, and it is only set true when a
  // linked reservation actually reports is_confirmed.
  //
  // Live-reproduced 2026-08-18: this defaulted to TRUE ("avoid false blocks"),
  // and the assignment below only runs inside `if (lc?.found)`. A FRESH inquiry
  // has no linked order, so it stayed true and the location block told the
  // agent "booking IS confirmed — OK to share" for someone who had booked
  // NOTHING. Verified against all three accounts: leo and diogo (the two with a
  // pickup_address configured) both handed out the exact street address and
  // postcode to an unbooked stranger who simply asked where pickup was;
  // dbcinema only behaved correctly because it has no address on file, so the
  // bad instruction was never injected. Failing closed costs at most a manual
  // send when a genuinely-confirmed booking's lookup fails; failing open leaks
  // Daniel's pickup locations to anyone who asks.
  let bookingConfirmed = false;
  // Structured echo of whatever real facts made it into groundTruth above,
  // for the ORDER-linked path and the fresh-inquiry path below alike.
  // replyInbox_actions.ts's hasItemGrounding / guardDraft's factPack only
  // look at fields on the conversation DOCUMENT (c.fact_pack, c.availability)
  // — text injected into THIS prompt has zero effect on that separate check,
  // so a correctly-grounded draft was still getting hard-escalated as
  // "UNGROUNDED_PRICE"/"UNGROUNDED_AVAILABILITY" after the groundTruth
  // extension shipped. Returning this lets the caller fold it in.
  const resolvedItems: Array<{ name: string; dailyRateGbp?: number }> = [];
  /**
   * Items in play that we hold NO "what's included" text for. Fed to
   * guardDraft as factPack.itemsWithoutKitData so a fabricated kit list is
   * caught mechanically rather than relying on the agent obeying an
   * instruction — which, live, it did not.
   */
  const itemsWithoutKitData: string[] = [];
  /**
   * Every price the FACT PACK offers the model as ground truth (lens options,
   * mount adapters, alternatives). The draft guard's PRICE_HALLUCINATION check
   * only derives valid prices from the LISTING, so an add-on we explicitly told
   * the bot to quote — an £8/day adapter, a £26/day lens — was flagged critical
   * and escalated. The system was instructing the bot to make an offer and then
   * blocking it for making that offer. A price we supplied is grounded by
   * definition; a price the model invented is still caught.
   */
  const offeredPrices: number[] = [];
  /**
   * Did a booking-modification tool actually SUCCEED this turn? The guard uses
   * this to tell a truthful "I've added it" (Lab, where the simulated order
   * really changed) from a fabricated one (production, where the chat cannot
   * act). Without it, either the Lab is blocked for telling the truth or
   * production is free to invent an action.
   */
  let bookingModified = false;
  /**
   * Length of the simulated order's change log BEFORE this turn. Comparing it
   * afterwards is how we know a booking edit really happened.
   *
   * The first attempt read Mastra's `steps[].toolResults[]` looking for a
   * successful modify_booking call and never matched, so every truthful "I've
   * added the 24-105" was flagged as a fabricated action and the whole reply
   * withheld -- the tool ran, the booking changed, and the renter was told
   * nothing. The order row is the authority on whether it changed; the
   * framework's result shape is an implementation detail that can drift.
   */
  let orderChangesBefore: number | null = null;
  /** Per-draft token accounting, so caching is observable rather than assumed. */
  let tokenUsage: {
    prompt: number | null;
    completion: number | null;
    cached: number | null;
    cost: number | null;
  } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lc: any = await convex.query(api.renter_bot_tools.get_listing_context, { thread_id });
    if (lc?.found) {
      bookingConfirmed = lc.is_confirmed === true;
      const req: string[] = [];
      // "2026-09-04–2026-09-06" came back out of the model as "4th, 6th
      // September", which reads as two separate dates rather than a range and
      // is exactly the kind of thing a renter turns up on the wrong day for.
      // Spell the range out.
      if (lc.start_date)
        req.push(
          lc.end_date && lc.end_date !== lc.start_date
            ? `dates from ${lc.start_date} to ${lc.end_date} inclusive`
            : `date ${lc.start_date} (single day)`,
        );
      if (lc.gross_paid_gbp != null) req.push(`total £${lc.gross_paid_gbp}`);
      req.push(bookingConfirmed ? "status: CONFIRMED" : "status: NOT confirmed (pending)");
      groundTruth += `REQUESTED (ground truth — do NOT contradict): ${req.join(", ")}.\n`;
      if (!bookingConfirmed) {
        const inviteLine = lc.is_inquiry
          ? `This is an ENQUIRY (no booking placed yet) — just confirm the item is available and answer warmly. Do NOT tell them to "send a request" or "complete a booking" merely to get info/a quote; only talk booking if they say they're ready.`
          : `You MAY confirm the item is AVAILABLE and warmly invite them to complete the booking to lock it in — nothing beyond that.`;
        groundTruth += `⚠️ THIS BOOKING IS NOT CONFIRMED — funds may be reserved but it is NOT locked in. Do NOT say "booked", "confirmed", "paid", "it's yours", "all set", "reserved for you", or anything implying it's secured. ${inviteLine}\n`;
      }
      // CURRENT SIMULATED BOOKING (Lab sessions only). Giving the bot the live
      // line items, day count and total means its "your total is now £X" is
      // read off the same arithmetic the Lab panel shows, rather than being
      // recomputed in prose — which is where day-count and multi-item maths
      // goes wrong.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ord: any = await convex.query(api.renter_bot_lab_order.get, {
          thread_id,
        });
        if (ord) {
          const lines = (ord.lines ?? []) as Array<{
            name: string;
            qty: number;
            daily_price_gbp?: number | null;
            line_total_gbp?: number | null;
          }>;
          for (const l of lines) {
            if (typeof l.daily_price_gbp === "number") offeredPrices.push(l.daily_price_gbp);
            if (typeof l.line_total_gbp === "number") offeredPrices.push(l.line_total_gbp);
          }
          if (typeof ord.total_gbp === "number") offeredPrices.push(ord.total_gbp);
          const rows = lines
            .map((l) => {
              const r = (l as { effective_rate_gbp?: number | null }).effective_rate_gbp;
              const t = (l as { tiers?: string | null }).tiers;
              return (
                `${l.qty}x ${l.name}` +
                (r != null ? ` @ £${Math.round(r)}/day for this length` : " (no price on file)") +
                (t ? ` [Hygglo tiers: ${t}]` : "")
              );
            })
            .join("; ");
          groundTruth += `CURRENT BOOKING (live, you CAN change it with modify_booking): ${rows || "(empty)"}. Dates: ${ord.start_date ?? "not set"} to ${ord.end_date ?? "not set"} = ${ord.days} day(s). Total: ${ord.total_gbp != null ? `£${ord.total_gbp}` : `NOT CALCULABLE (no price for ${ord.unpriced.join(", ")}) — do not quote a total`}.\n`;
          orderChangesBefore = (ord.changes ?? []).length;
          groundTruth += `  When the renter asks you to add or remove gear or move dates, CALL modify_booking and then state what changed and the new total. Do NOT ask them to confirm a change they just asked for.\n`;
          groundTruth += `  PRICING IS TIERED: the per-day rate DROPS at 3 and 7 days, and the tiers above are what Hygglo charges. Quote the rate for the length they actually asked for, and when a longer hire is better value, say so using the tier numbers above and nothing else. Never multiply the 1-day rate across a longer booking, and never invent a rate that is not in the tiers.\n`;
        }
      } catch {
        /* not a Lab session — no simulated order exists */
      }

      // What this listing ALREADY includes. Anything in here must never be
      // offered as a paid extra: live-caught on a bundle whose own kit is a
      // body plus the Canon 16-35 and 24-105, where the bot offered both
      // lenses as add-ons at £12 and £20/day. Quoting a renter for gear they
      // are already paying for reads as either a scam or incompetence, and it
      // buries the bundle's actual selling point.
      const kitNames = new Set(
        ((lc.items ?? []) as Array<{ name?: string }>)
          .map((i) => (i.name ?? "").toLowerCase().trim())
          .filter(Boolean),
      );
      for (const it of (lc.items ?? []).slice(0, 3) as Array<{ name?: string; daily_price_gbp?: number; whats_included?: string; owned?: boolean; kind?: string | null; lens_mount?: string | null; ambiguous_with?: Array<{ name: string; lens_mount?: string | null; kind?: string | null }> }>) {
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
              // Ranked by SUBSTITUTABILITY (same category, same lens mount,
              // same product family) — the first entry is the closest real
              // match, not just anything sharing a kind. Carry the mount and
              // the lens-inclusion flag so the agent can answer "does it come
              // with a lens?" from data instead of guessing.
              const list = ((alts?.alternatives ?? []) as Array<{
                name?: string;
                daily_price_gbp?: number;
                lens_mount?: string | null;
                includes_lens?: boolean | null;
              }>)
                .slice(0, 5)
                .map((a) => {
                  const price = a.daily_price_gbp != null ? ` £${a.daily_price_gbp}/day` : "";
                  const mount = a.lens_mount ? `, ${a.lens_mount}` : "";
                  const lens =
                    a.includes_lens === true
                      ? ", INCLUDES a lens"
                      : a.includes_lens === false
                        ? ", body only (no lens)"
                        : "";
                  return `${a.name}(${price}${mount}${lens})`;
                });
              // Register the alternatives as GROUNDED items. Without this the
              // system contradicted itself: the instruction below REQUIRES
              // naming an alternative with its real price, but the item under
              // discussion is marketing-only so hasItemGrounding was false,
              // and guardDraft then flagged the (correct, real) price as
              // UNGROUNDED_PRICE — critical — so every single marketing-only
              // inquiry escalated to Daniel and no renter ever got the
              // alternative. These prices come from find_owned_alternatives'
              // real listing lookup, so they are grounded by construction.
              for (const a of (alts?.alternatives ?? []) as Array<{
                name?: string;
                daily_price_gbp?: number;
              }>) {
                if (a.name && typeof a.daily_price_gbp === "number") {
                  resolvedItems.push({ name: a.name, dailyRateGbp: a.daily_price_gbp });
                }
              }
              // Glass for a body-only ALTERNATIVE. Previously lens options
              // were only attached to the REQUESTED item, so when the answer
              // was a substitute the bot could say "that one's body only" and
              // then pivot to whichever other camera happened to ship with a
              // lens — instead of offering to add glass to the body they were
              // actually discussing.
              // Glass for EVERY body-only option we're about to name, not just
              // the first one found. A `.find()` here picked whichever
              // body-only alternative happened to sort first (a Sony A7 III)
              // and supplied E-mount glass, while the reply actually
              // recommended a Blackmagic — so the renter was told "body only"
              // with no offer, which is the exact gap this closes. One line
              // per distinct mount among the options being offered.
              const offered = ((alts?.alternatives ?? []) as Array<{
                name?: string;
                lens_mount?: string | null;
                includes_lens?: boolean | null;
              }>).slice(0, 5);
              const mountsNeeded: Array<{ mount: string; body: string }> = [];
              for (const a of offered) {
                if (!a.lens_mount || a.includes_lens === true) continue;
                if (mountsNeeded.some((m) => m.mount === a.lens_mount)) continue;
                mountsNeeded.push({ mount: a.lens_mount, body: a.name ?? "that body" });
                if (mountsNeeded.length >= 2) break;
              }
              let lensForAltText = "";
              for (const need of mountsNeeded) {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const g: any = await convex.query(api.renter_bot_tools.find_owned_alternatives, {
                    account_slug: account_slug || "",
                    kind: "lens",
                    lens_mount: need.mount,
                  });
                  const fits = ((g?.alternatives ?? []) as Array<{ name?: string; daily_price_gbp?: number }>)
                    .slice(0, 2)
                    .map((x) => `${x.name}${x.daily_price_gbp != null ? ` (£${x.daily_price_gbp}/day)` : ""}`);
                  if (fits.length) {
                    lensForAltText += ` ${need.body} goes out body-only (${need.mount}); glass we own that natively fits it: ${fits.join("; ")}.`;
                  }
                } catch {
                  /* best-effort */
                }
              }
              if (lensForAltText) {
                lensForAltText +=
                  ` If they ask about a lens, OFFER the matching glass to go WITH the body they're considering, by name and price — do not just point them at a different camera that happens to include one.`;
              }
              if (list.length)
                altText =
                  ` Closest real alternatives WE OWN, best first: ${list.join("; ")}.` +
                  ` Offer the FIRST one unless the renter's stated need clearly favours another. Stay in the same product family/mount where possible — do NOT jump brand or system (e.g. answering a Blackmagic request with a Sony body) unless nothing closer exists, and if you must, say plainly that it's a different system.` +
                  lensForAltText;
            } catch {
              /* best-effort alternatives */
            }
          }
          // Say it ONCE. After that, repeating the unavailability line instead
          // of answering the question they actually asked is the exact defect
          // this whole pass exists to remove.
          const framing = alreadySaidUnavailable
            ? `You have ALREADY told this renter it isn't available — do NOT say it again. Answer THIS message's actual question about the alternative(s) instead, and do not re-open with the unavailability line.`
            : `Frame it ONLY as not available for their dates, then IMMEDIATELY recommend a real alternative BY NAME.`;
          groundTruth += `- ${it.name}: we CANNOT rent this to the renter. Do NOT confirm or quote it, and NEVER say why — no "stock", "own", "have (one/that)", "on hand", "inventory", "marketing", "display". ${framing} Do NOT ask them what focal length / mount / type of shoot they want — just offer the alternative(s).${altText}\n`;
          continue;
        }
        // owned === null means UNVERIFIED, not "we don't own it". Before the
        // tri-state fix these were indistinguishable and every unverified line
        // took the concealment path above, so the bot told renters that real,
        // free, in-stock gear was unavailable. Never conceal on unknown —
        // check availability and answer normally.
        if (it.owned == null) {
          groundTruth += `- ${it.name}: ownership NOT yet verified from the listing link (this is a DATA gap, NOT a signal that we lack the item). Do NOT say or imply it is unavailable on this basis. Treat the AVAILABILITY line below as the truth for these dates.\n`;
        }
        // AMBIGUOUS MODEL NAME — ask, do not pick. "BMPCC 6K" fully describes
        // both the 6K Pro and the 6K Full Frame. Live-caught: the bot replied
        // "yes I have the BMPCC 6K", then invented a THIRD product line with
        // fabricated specs (ND filters, screen types) to explain the
        // difference between them.
        if (Array.isArray(it.ambiguous_with) && it.ambiguous_with.length > 1) {
          const opts = it.ambiguous_with
            .map((a) => `${a.name}${a.lens_mount ? ` — ${a.lens_mount}` : ""}`)
            .join("; ");
          groundTruth += `- "${it.name}" is AMBIGUOUS — it matches ${it.ambiguous_with.length} DIFFERENT products we own: ${opts}. These are the ONLY models in this line; there is no other variant. Do NOT answer as if "${it.name}" were one product and do NOT invent a variant. ASK which they mean, by exact name. You MAY and SHOULD use the mounts listed here to help them choose (e.g. which one their existing glass fits) and you may quote each one's price — those are real facts. What you must NOT do is state sensor sizes, ND filters, screen types or other specs that are not given to you.\n`;
        }
        if (!it.whats_included && it.name) itemsWithoutKitData.push(it.name);
        // A camera with no kit text still supports a USEFUL lens answer: we
        // know its mount, and we know what glass we own that fits. Without
        // this the honest reply degrades to "let me check and come back",
        // which loses the booking and the upsell in one line.
        if (it.kind === "camera" && it.lens_mount) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const glass: any = await convex.query(api.renter_bot_tools.find_owned_alternatives, {
              account_slug: account_slug || "",
              kind: "lens",
              lens_mount: it.lens_mount,
            });
            const all = (glass?.alternatives ?? []) as Array<{ name?: string; daily_price_gbp?: number }>;
            // Split, don't just filter: the renter needs to hear "already
            // included" about kit glass, which is a stronger answer than
            // silence AND stops it being quoted as an extra.
            const alreadyIn = all
              .filter((g) => kitNames.has((g.name ?? "").toLowerCase().trim()))
              .map((g) => g.name)
              .filter(Boolean);
            const keep = all
              .filter((g) => !kitNames.has((g.name ?? "").toLowerCase().trim()))
              .slice(0, 3);
            for (const g of keep)
              if (typeof g.daily_price_gbp === "number") offeredPrices.push(g.daily_price_gbp);
            const fits = keep.map(
              (g) => `${g.name}${g.daily_price_gbp != null ? ` (£${g.daily_price_gbp}/day)` : ""}`,
            );
            if (alreadyIn.length) {
              groundTruth += `  ALREADY IN THIS RENTAL for ${it.name}: ${alreadyIn.join("; ")}. This glass is INCLUDED in the price they already have. Say so as a positive ("it already comes with…") and NEVER offer it as a paid add-on.\n`;
            }
            if (fits.length) {
              groundTruth += `  LENS OPTIONS for ${it.name} (${it.lens_mount}) — real, owned, NOT already in this rental, and a native fit: ${fits.join("; ")}. If they ask about a lens, or if the body goes out without one, OFFER one of these BY NAME with its price rather than saying you'll check.\n`;
            }
          } catch {
            /* best-effort */
          }
        }
        // MOUNT ADAPTERS WE ACTUALLY OWN.
        //
        // Live-caught: the bot told a renter the Blazar Remus lenses are
        // native PL and "would require a PL-to-EF adapter, which isn't
        // included" — true, well explained, and a dead end. We rent five
        // adapters. Naming the blocker without naming the fix we stock turns
        // a solvable objection into a lost booking.
        if (it.lens_mount) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ad: any = await convex.query(api.renter_bot_tools.get_mount_adapters, {
              account_slug: account_slug || "",
            });
            const relevant = ((ad?.adapters ?? []) as Array<{
              name?: string;
              to_mount?: string;
              daily_price_gbp?: number | null;
            }>)
              // Only adapters that land ON this body's mount are useful here.
              // Mount spellings differ across inventory ("Canon EF mount" vs
              // "EF"), so compare normalised — an exact compare matched
              // nothing and hid the adapter we stock.
              .filter((a) => sameMount(a.to_mount, it.lens_mount))
              .map((a) => {
                if (typeof a.daily_price_gbp === "number")
                  offeredPrices.push(a.daily_price_gbp);
                return `${a.name}${a.daily_price_gbp != null ? ` (£${a.daily_price_gbp}/day)` : ""}`;
              });
            if (relevant.length) {
              groundTruth += `  ADAPTERS WE OWN AND RENT for ${it.name} (${it.lens_mount}): ${relevant.join("; ")}. If you tell them a lens needs an adapter to fit, you MUST immediately offer the matching one from this list BY NAME with its price. Never end on "an adapter is required and not included" — we have it, so say so.\n`;
            }
          } catch {
            /* best-effort */
          }
        }
        const kitText = it.whats_included
          // Truncate at INJECTION, not in storage. The stored description is
          // now full-length so bundle mapping can read the whole component
          // list; the prompt only needs enough to answer "what's included".
          ? it.whats_included.slice(0, 900)
          : "(NOT LISTED — you do not know this item's kit. Do NOT invent contents: never claim it comes with, or without, a cage/card/battery/lens unless stated here. If asked what's included, say you'll confirm the exact kit.)";
        groundTruth += `- ${it.name}: £${it.daily_price_gbp ?? "?"} /day. Included: ${kitText}\n`;
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
            // QUANTITY-AWARE (2026-08-21). This previously treated ANY
            // overlapping booking as a conflict, ignoring how many units we
            // own. Live-caught by the conversation rubric: the Sony FX3 is
            // qty 4 with 3 units free and free_whole_horizon=true, and the bot
            // still told a renter it was "booked out this weekend" because a
            // single unrelated booking overlapped. For every multi-unit item,
            // one booking silently made the whole line unavailable — the same
            // lost-booking failure as the owned:false bug, from a different
            // direction.
            const totalUnits = typeof m.qty === "number" && m.qty > 0 ? m.qty : 1;
            let overlapping = 0;
            let turnaround: string | null = null;
            if (reqDate) {
              for (const b of bookings) {
                const pDate = String(b.pickup ?? "").split(" ")[0];
                const rParts = String(b.return ?? "").split(" ");
                const rDate = rParts[0];
                const rTime = rParts[1];
                if (pDate && rDate && pDate <= reqDate && rDate >= reqDate) {
                  // A booking RETURNING on the requested day frees its unit
                  // later that day rather than blocking it outright.
                  if (rDate === reqDate && rTime) turnaround = addHour(rTime);
                  else overlapping++;
                }
              }
            }
            const conflict = overlapping >= totalUnits;
            // Only surface the turnaround caveat when it's the LAST free unit;
            // with spare units the renter can collect whenever they like.
            if (turnaround && overlapping + 1 < totalUnits) turnaround = null;
            const verdict = turnaround
              ? `it's out on another rental that RETURNS ${reqDate} — so it's only free from ${turnaround} that day (1-hour turnaround buffer); do NOT offer it before ${turnaround}, and only inside a pickup window`
              : conflict
                ? `ALL ${totalUnits} unit(s) are out on ${reqDate} — NOT available; offer the next free date (${m.next_free_date ?? "?"})`
                : bookings.length === 0
                  ? `FREE — no bookings, available for ${reqDate ?? "the requested date"}`
                  : `AVAILABLE for ${reqDate} — we hold ${totalUnits} of these and only ${overlapping} is/are out then, so ${totalUnits - overlapping} remain free. Do NOT describe it as booked out.`;
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
            // Same quantity blind spot as the order-linked branch: a bare list
            // of booked dates reads as "unavailable then", but with several
            // units a booking on a date does not block it. State the unit count
            // so the model cannot infer a conflict that isn't there.
            const units = typeof (m as { qty?: number }).qty === "number" ? (m as { qty?: number }).qty! : 1;
            const unitNote =
              units > 1
                ? ` NOTE: we hold ${units} of these, so a booking on a date does NOT make it unavailable — only treat it as unavailable if ALL ${units} are out.`
                : "";
            const verdict = m.free_whole_horizon
              ? "FREE for the next 30 days — no bookings in that window"
              : bookingDates.length
                ? `has existing bookings on: ${bookingDates.join(", ")} (dates outside this list are free within the next 30 days).${unitNote}`
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
    const [hubs, communications, globalSettings] = await Promise.all([
      convex.query(api.settings.listAccountHubs, {}),
      convex.query(accountCommunicationRef, {}),
      // Needed for the pickup-hours cascade below — see there for why.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      convex.query(api.settings.get, {}) as Promise<any>,
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
    } else if (!bookingConfirmed) {
      // No pickup_address configured for this account (dbcinema, as of
      // 2026-08-18) — but the withhold instruction must STILL be injected.
      // Previously the whole gate lived inside the `if (hub?.pickup_address)`
      // above, so an account with no address on file got no location guidance
      // at all and the only thing standing between a renter and the address
      // was the system prompt. That matters because the address for such an
      // account is not absent from the bot's reach: it is written into the
      // account's TEMPLATES (e.g. "Template: DB Cinema Welcome Text" contains
      // the full Trafalgar Square meeting point), which search_knowledge can
      // return at any conversation stage.
      groundTruth +=
        `PICKUP LOCATION: do NOT reveal any street address, postcode, or specific meeting point for this account yet (booking is NOT confirmed) — including any address that appears inside an account template you may retrieve. Say you'll send the exact pickup address the moment the booking is confirmed; you may say "central London" and nothing more specific.\n`;
    }
    // Time-aware pickup/return windows (per account) — at 4pm the morning slot
    // is gone, so only offer windows that haven't passed today.
    //
    // THREE-TIER CASCADE (fixed 2026-08-18): per-account override → the GLOBAL
    // settings.pickup_hours → a hardcoded last resort. The middle tier was
    // missing here, while convex/replyInbox.ts:1167 has always had it, so the
    // two halves of the same bot disagreed: an account with no per-account
    // windows got the operator's real global setting in one prompt path and a
    // hardcoded literal in this one. Worse, SettingsDrawer.tsx:444 tells the
    // operator "Using the shared fallback windows." when an account's list is
    // empty and offers a delete button to get there — so the settings page
    // promised behaviour this path did not honour, and editing the global
    // hours would silently not reach renters. Cascade + its regression tests
    // now live in src/lib/pickup-hours.ts.
    const hours = resolvePickupHours(hub?.pickup_hours, globalSettings?.pickup_hours);
    const nowHM = new Date().toLocaleString("en-GB", {
      timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit",
    });
    // "10:00 to 12:00", NOT "10:00–12:00". Live-caught 2026-08-18: with an
    // en-dash the agent routinely rewrote a window as a comma pair — "our
    // windows are 10am, 12pm and 7pm, 9pm" — which reads to a renter as four
    // fixed appointment times rather than two continuous ranges, and is
    // actively misleading for the evening one (7-9pm is a two-hour window, not
    // "7pm or 9pm"). 6 of 8 window mentions across the response matrix came out
    // in the ambiguous comma form. Spelling the range out in words, plus the
    // explicit presentation instruction below, removes the ambiguity at source.
    const fmt = (w: { start: string; end: string }) => `${w.start} to ${w.end}`;
    const remaining = remainingWindowsToday(hours, nowHM);
    groundTruth +=
      `CURRENT LONDON TIME: ${nowHM}. Pickup/return windows for this account: ${hours.map(fmt).join(" or ")} — NEVER agree to any time outside these. ` +
      `Each window is a CONTINUOUS range the renter can arrive within, not two fixed times: always write it to the renter as a range ("10am to 12pm", "7-9pm"), NEVER as a comma pair ("7pm, 9pm"), which reads as two separate appointments. ` +
      (remaining.length
        ? `Windows still open TODAY: ${remaining.map(fmt).join(" or ")} — offer the EARLIEST of these first; do NOT offer a window that has already passed today (e.g. don't offer a morning slot in the afternoon).`
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

  // PROMPT CACHING (2026-08-21).
  //
  // CONVERSATION_CRAFT is ~2KB of byte-identical text on every single call, and
  // it used to be concatenated into the volatile user message below — where it
  // can never be cached, because that message changes every turn.
  //
  // It now rides in its own system message carrying an explicit cache_control
  // breakpoint. `@openrouter/ai-sdk-provider` reads providerOptions.openrouter
  // .cacheControl off a system message and emits `cache_control` on the wire
  // (see convertToOpenRouterChatMessages), so everything up to and including
  // this block becomes a cacheable prefix.
  //
  // Measured on google/gemini-3.7-flash via scripts/probe-openrouter-cache.mjs,
  // same ~31k-token prefix, with vs without the breakpoint:
  //   call 1  $0.00184 vs $0.01179  → 6.4x cheaper
  //   call 2  $0.00119 vs $0.00213  → 1.8x cheaper
  // Gemini's implicit caching does NOT make this redundant: the control's
  // first call reported cached=0 and paid full price. Percentages mislead here
  // (the control shows a bigger *within-arm* drop purely because it starts from
  // an uncached baseline) — absolute cost is the number that decides.
  //
  // ORDERING IS LOAD-BEARING: a cache prefix must be byte-stable, so anything
  // volatile (dates, ground truth, the renter's message) must come AFTER this.
  const baseMessages = [
    {
      role: "system" as const,
      content: craftRules,
      // Only cache the real, byte-stable block. A candidate variant changes
      // every evaluation, so caching it would pay write cost for a prefix that
      // is never read back.
      ...(craftOverride
        ? {}
        : {
            providerOptions: {
              openrouter: { cacheControl: { type: "ephemeral" as const } },
            },
          }),
    },
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
      harvestToolPrices(result?.steps, offeredPrices);
      // TOKEN TELEMETRY. Prompt caching fails SILENTLY — under the provider's
      // minimum, provider ignores the breakpoint, or a framework wrapper drops
      // cache_control on the way out. All three look identical from outside:
      // it just quietly costs full price. Without this, "caching is on" was an
      // assumption rather than an observation.
      //
      // Also tells us the real static/volatile split per draft, so prompt-size
      // work can be aimed with numbers instead of guesses.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u: any = result?.usage ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pm: any = result?.providerMetadata ?? {};
      tokenUsage = {
        prompt: u.promptTokens ?? u.inputTokens ?? null,
        completion: u.completionTokens ?? u.outputTokens ?? null,
        cached:
          u.cachedPromptTokens ??
          u.cachedInputTokens ??
          pm?.openrouter?.usage?.promptTokensDetails?.cachedTokens ??
          null,
        cost: pm?.openrouter?.usage?.cost ?? null,
      };
      if (tokenUsage.prompt != null) {
        const pct =
          tokenUsage.cached != null && tokenUsage.prompt
            ? ` (${Math.round((tokenUsage.cached / tokenUsage.prompt) * 100)}% cached)`
            : "";
        console.log(
          `[renter-bot-draft] tokens prompt=${tokenUsage.prompt} cached=${tokenUsage.cached ?? "?"}${pct} completion=${tokenUsage.completion ?? "?"} cost=${tokenUsage.cost ?? "?"}`,
        );
      }
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
            harvestToolPrices(retryResult?.steps, offeredPrices);
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
    if (orderChangesBefore !== null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const after: any = await convex.query(api.renter_bot_lab_order.get, { thread_id });
        bookingModified = ((after?.changes ?? []).length as number) > orderChangesBefore;
      } catch {
        /* leave false — a claim without proof stays a false claim */
      }
    }
    return NextResponse.json({
      ok: true,
      draft: obj.draft ?? "",
      needs_human: !!obj.needs_human,
      intent: obj.intent ?? null,
      factsClaimed: obj.factsClaimed ?? [],
      usedTools,
      resolvedItems,
      itemsWithoutKitData,
      // Prices the fact pack itself offered — see offeredPrices' declaration.
      offeredPrices: [...new Set(offeredPrices)],
      bookingModified,
      tokenUsage,
      // Verified NOT-rentable items. Registering the alternatives above turns
      // hasItemGrounding on, which disables the blanket ungrounded-assertion
      // net — so the marketing-specific net (guardDraft rule 8,
      // MARKETING_ITEM_AVAILABLE) must be armed with real data instead.
      marketingItems,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "agent_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
