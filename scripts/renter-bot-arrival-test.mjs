/**
 * Before/after probe for ARRIVAL COORDINATION — the conversation mode real
 * renters spend most of their messages in, and the one never tested.
 *
 * Mining 3,666 real inbound messages: collection/pickup is the single largest
 * topic (534), timing is third (420), and the uncategorised bucket is full of
 * people standing in the street — "In front of waterstones now :) two people",
 * "We're at trafalgar in 6 min", "We're having troubles finding the place",
 * "Hi sorry I missed you". Every probe written before this one was a
 * pre-booking enquiry.
 *
 * What good looks like here is different from a sales reply:
 *   - recognise the renter is PHYSICALLY THERE, right now
 *   - on a CONFIRMED booking, give the actual address/access detail
 *   - do not open with availability, price or an upsell
 *   - do not tell someone standing outside that you'll send the address
 *     "once the booking is confirmed" — it already is
 *
 * SAFETY: `__probe__` threads only, cleaned up at the end. No send path.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";
const LABEL = process.argv[2] ?? "run";

function convexRun(fn, args) {
  try {
    const out = execFileSync(CVX, ["run", fn, JSON.stringify(args ?? {})], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180000,
    });
    const t = out.trim();
    if (!t) return null;
    const i = t.search(/[[{]/);
    try {
      return JSON.parse(i >= 0 ? t.slice(i) : t);
    } catch {
      return t;
    }
  } catch (e) {
    return { __error: String(e.message ?? e).slice(0, 200) };
  }
}

/** Phrasings taken from the real inbound corpus. */
const TURNS = [
  {
    q: "hi im outside now, cant find the entrance",
    bad: [/once (the )?booking is confirmed/i, /i'?ll send (you )?the (exact )?(pickup )?address/i],
    badLabel: "defers the address to 'once confirmed' — they are standing outside a CONFIRMED booking",
  },
  {
    q: "im by the starbucks on the corner, where do i go",
    bad: [/available|£\s?\d+\s*\/?\s*day|add (the|a)\b/i],
    badLabel: "answers a wayfinding question with availability/price/upsell",
  },
  {
    q: "sorry i missed you, im running about 15 min late",
    bad: [/collection windows are/i],
    badLabel: "recites the standard collection windows at someone already en route",
  },
];

async function main() {
  const threadId = "__probe__arrival";
  const item = "BMPCC 6K Pro";
  convexRun("renter_bot_lab_order:seed", {
    thread_id: threadId,
    account_slug: "leo",
    item_names: [item],
    start_date: "2026-11-20",
    end_date: "2026-11-21",
  });

  const history = [];
  const results = [];
  console.log(`\n=== ARRIVAL PROBE [${LABEL}] — CONFIRMED booking, renter on site ===\n`);
  for (const t of TURNS) {
    history.push({ role: "renter", text: t.q });
    convexRun("renter_bot_probe:seed", {
      thread_id: threadId,
      account_slug: "leo",
      // The renter has BOOKED and is collecting — not an enquiry.
      stage: "CONFIRMED",
      items: [{ name: item }],
      messages: history,
      // A REAL confirmed reservation — confirmation comes from
      // reservations.status, not the conversation stage.
      confirmed_booking: { start_date: "2026-11-20", end_date: "2026-11-21" },
    });
    const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
    const draft = res?.draft ?? "";
    const bad = t.bad.some((re) => re.test(draft));
    results.push({ q: t.q, draft, bad, badLabel: t.badLabel });
    console.log(`  ${bad ? "BAD " : "ok  "} | Q: ${t.q}`);
    console.log(`    A: ${(draft || `<blocked: ${res?.reason ?? "?"}>`).replace(/\n+/g, " ").slice(0, 210)}`);
    if (bad) console.log(`    !! ${t.badLabel}`);
    history.push({ role: "owner", text: draft });
  }

  convexRun("renter_bot_probe:cleanup", {});
  const n = results.filter((r) => r.bad).length;
  console.log(`\nSCORE [${LABEL}]: ${n}/${TURNS.length} turns mishandled someone standing outside`);
  writeFileSync(`/tmp/arrival-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
