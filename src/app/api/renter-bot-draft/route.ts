import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, type RenterBotOutput } from "@/mastra/agents/renter_bot";

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
      for (const it of (lc.items ?? []).slice(0, 3) as Array<{ name?: string; daily_price_gbp?: number; whats_included?: string; owned?: boolean }>) {
        if (it.owned === false) {
          marketingItems.push(it.name ?? "that item");
          groundTruth += `- ${it.name}: ⚠️ MARKETING-ONLY LISTING — we do NOT stock this item (it's advertised but not owned). Do NOT confirm availability or a pickup for it, and do NOT quote it as if we have it. Tell the renter warmly we don't have that exact one and offer the closest thing we DO own instead.\n`;
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

  // Hard top-line directive when the renter is asking about gear we don't stock.
  const marketingDirective = marketingItems.length
    ? `🚫 CRITICAL — WE DO NOT OWN OR STOCK: ${marketingItems.join(", ")}. These are marketing-only listings (advertised to show the class of gear, not held in stock). You MUST tell the renter we don't have that exact item, and offer the closest thing we DO own. NEVER say it's available / ready / works for pickup — confirming it would send a renter to collect an item that does not exist.\n\n`
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
    const agent = await getRenterBotAgent();
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
    // BACKSTOP: if a marketing-only item was requested and the draft does NOT
    // acknowledge we don't stock it, the bot is confirming a phantom item.
    // Never send that — blank it and escalate for the operator.
    if (marketingItems.length && obj.draft && !obj.needs_human) {
      const d = obj.draft.toLowerCase();
      const acknowledges =
        /(don'?t|do not|doesn'?t|does not|no longer|not one|not something|not a) (have|stock|own|carry|hold|keep)|we don'?t (have|stock|own|carry)|not (in stock|available (from|through|with) us)|isn'?t (one|something|a lens|an item) (we|i)/i.test(d);
      if (!acknowledges) {
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
