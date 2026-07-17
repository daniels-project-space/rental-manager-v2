import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import { getRenterBotAgent, getRenterBotAgentStrong, type RenterBotOutput } from "@/mastra/agents/renter_bot";
import { runs, tasks } from "@trigger.dev/sdk/v3";
import { allowsRenterBotMeteredFallback } from "@/lib/renter-bot-policy";

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
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const alts: any = await convex.query(api.renter_bot_tools.find_owned_alternatives, {
              account_slug: account_slug || "",
              kind: it.kind ?? undefined,
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
    }
  } catch {
    /* best-effort ground truth */
  }

  // Per-account PICKUP location — share ONLY after the booking is confirmed.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hubs: any = await convex.query(api.settings.listAccountHubs, {});
    const hub = (hubs || []).find((h: { slug?: string }) => h.slug === account_slug);
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
    const meteredFallbackAllowed = allowsRenterBotMeteredFallback(
      process.env.RENTER_BOT_METERED_FALLBACK,
    );
    // Primary path: GPT-5.6 Luna through Codex on Daniel's ChatGPT
    // subscription. Trigger is a trusted runner; Platform API keys are blanked
    // inside the task so this cannot silently become metered API usage.
    try {
      const lunaPrompt = [
        "You draft replies for an equipment-rental owner. Return ONLY compact JSON: {\"draft\":\"...\",\"needs_human\":false}.",
        "Write one natural, concise renter-facing reply, normally 1-3 sentences. No email filler, internal reasoning, AI mention, or markdown.",
        "Use only supplied facts. Never invent price, availability, included gear, dates, address, policy, stock or ownership.",
        "Never call an unconfirmed request booked/paid/confirmed. Never refer the renter to a competitor.",
        "If the message is a complaint, damage report, cancellation, legal threat, refund dispute, or facts are insufficient, return an empty draft with needs_human true.",
        account_slug === "dbcinema" ? "DB Cinema voice: professional, concise, no emoji." : "Voice: warm, direct, at most one emoji.",
        `Recent conversation:\n${recentTranscript || "(none)"}`,
        baseMessages[0].content,
      ].join("\n\n");
      const handle = await tasks.trigger("rental-draft-luna", { prompt: lunaPrompt });
      const run = await runs.poll(handle.id, { pollIntervalMs: 500 });
      if (run.isSuccess && run.output) {
        const out = run.output as { draft?: string; needs_human?: boolean };
        obj = {
          draft: out.draft ?? "",
          needs_human: out.needs_human === true,
          intent: "GENERAL",
          conversation_stage: "INQUIRY",
          red_flags: [],
          factsClaimed: [],
        } as RenterBotOutput;
      }
    } catch {
      // The subscription lane is fail-closed by default. A separately billed
      // Mastra/API fallback exists only as an explicit emergency override; it
      // must never activate silently when Luna or Trigger is unavailable.
    }

    if (!obj && !meteredFallbackAllowed) {
      return NextResponse.json(
        { ok: false, error: "subscription_unavailable", needs_human: true },
        { status: 503 },
      );
    }

    if (!obj) {
      // Explicit emergency-only fallback. Production defaults to subscription
      // only; enabling this separately billed route requires a deliberate env
      // change and never changes the draft-only / manual-send safety boundary.
      const agent = marketingItems.length
        ? await getRenterBotAgentStrong()
        : await getRenterBotAgent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await (agent as any).generate(baseMessages, { maxSteps: 10 });
      const text: string = result?.text ?? "";
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
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "agent_failed", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
