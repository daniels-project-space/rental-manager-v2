import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, getRenterBotAgentStrong, type RenterBotOutput } from "@/mastra/agents/renter_bot";

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
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rc: any = await convex.query(api.renter_bot_tools.get_renter_context, { thread_id });
    account_slug = rc?.account_slug ?? "";
    const msgs = (rc?.last_messages ?? []) as Array<{ sender?: string; body?: string }>;
    const r = [...msgs].reverse().find((m) => m.sender === "renter");
    lastRenter = r?.body ?? "";
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lc: any = await convex.query(api.renter_bot_tools.get_listing_context, { thread_id });
    if (lc?.found) {
      const req: string[] = [];
      if (lc.start_date) req.push(`booking date ${lc.start_date}${lc.pickup_time ? " at " + lc.pickup_time : ""}`);
      if (lc.gross_paid_gbp != null) req.push(`they pay £${lc.gross_paid_gbp}`);
      if (lc.order_step) req.push(`stage ${lc.order_step}`);
      groundTruth += `REQUESTED (ground truth — do NOT contradict): ${req.join(", ")}.\n`;
      for (const it of (lc.items ?? []).slice(0, 3) as Array<{ name?: string; daily_price_gbp?: number; whats_included?: string; owned?: boolean; kind?: string | null }>) {
        if (it.owned === false) {
          marketingItems.push(it.name ?? "that item");
          let altText = "";
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const alts: any = await convex.query(api.renter_bot_tools.find_owned_alternatives, {
              account_slug: account_slug || "",
              kind: it.kind ?? undefined,
              exclude_name: it.name ?? undefined,
            });
            const list = ((alts?.alternatives ?? []) as Array<{ name?: string; daily_price_gbp?: number }>)
              .slice(0, 5)
              .map((a) => `${a.name}${a.daily_price_gbp != null ? ` (£${a.daily_price_gbp}/day)` : ""}`);
            if (list.length) altText = ` Recommend ONE of these we DO own instead, by name: ${list.join("; ")}.`;
          } catch {
            /* best-effort alternatives */
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
            const conflict = reqDate
              ? bookings.some((b) => (b.start_date ?? b.start) <= reqDate && (b.end_date ?? b.end ?? b.start_date ?? b.start) >= reqDate)
              : false;
            const verdict = conflict
              ? `BOOKED on ${reqDate} — NOT available; offer the next free date (${m.next_free_date ?? "?"})`
              : bookings.length === 0
                ? `FREE — no bookings at all, so it IS available for the requested date${reqDate ? " " + reqDate : ""}; you can confirm the pickup works`
                : `no booking conflicts on ${reqDate} — available; confirm it works`;
            groundTruth += `  AVAILABILITY (${it.name}): ${verdict}.\n`;
          }
        } catch { /* best-effort */ }
      }
      groundTruth +=
        "Use these facts for price, kit, dates and availability — do NOT assert availability/price beyond them. If the booking stage is a NEW REQUEST/awaiting approval, do NOT talk as if it's already confirmed.\n";
    }
  } catch {
    /* best-effort ground truth */
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
    // Marketing-redirect is the hard case Haiku fumbles (admits / confirms) —
    // run it on the stronger model. Everything else stays on Haiku.
    const agent = marketingItems.length
      ? await getRenterBotAgentStrong()
      : await getRenterBotAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await (agent as any).generate(baseMessages, { maxSteps: 10 });
    const text: string = result?.text ?? "";
    let obj: RenterBotOutput | null = null;
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
    if (!obj) {
      // Couldn't parse a decision — escalate rather than send garbage.
      return NextResponse.json({ ok: true, draft: "", needs_human: true, factsClaimed: [] });
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
      // Also block drafts that ADMIT we don't stock it (reveals it's marketing).
      if (!violated) {
        const admits =
          /(don'?t|do not|doesn'?t|does not) (stock|own|have|carry)\b|not (stocking|carrying)|isn'?t (something|one) (i|we)|not (something|one) (i|we)|not in (stock|(our|my|the) inventory)|out of stock|on hand/i.test(d);
        if (admits) violated = true;
      }
      if (violated) {
        obj.draft = "";
        obj.needs_human = true;
      }
    }
    return NextResponse.json({
      ok: true,
      draft: obj.draft ?? "",
      needs_human: !!obj.needs_human,
      intent: obj.intent ?? null,
      factsClaimed: obj.factsClaimed ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "agent_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
