/**
 * Post-booking conversations — newly testable, and never tested before.
 *
 * The real inbound corpus (3,666 messages) is dominated by things that happen
 * AFTER the booking exists: collection (534), timing (420), extend/change (38),
 * how-to (34), cancel/refund (34), damage/insurance (20). Until the probe could
 * seed a confirmed reservation, none of this was reachable.
 *
 * These are graded on what would actually go wrong in each mode, not on tone:
 *   - an extension must not be confirmed as done when nothing was changed
 *   - a fault mid-rental needs help, not a sales reply
 *   - damage needs the real insured value and the platform's cover, not a
 *     figure or a promise we invented
 *   - a late return must not have a penalty invented for it
 *   - cancellation must not have a refund promised that we do not control
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

const SCENARIOS = [
  {
    name: "extend_midrental",
    item: "BMPCC 6K Pro",
    turns: [
      { q: "hey im still shooting, can i keep it one more day?" },
      {
        q: "great, so thats sorted then yeah?",
        // The chat cannot change a real booking. Saying it did is the
        // FALSE_ACTION_CLAIM class, here with the renter keeping our gear.
        bad: [/\b(i'?ve|i have) (extended|updated|changed|added)\b/i],
        badLabel: "claims it extended a real booking it cannot touch",
      },
      { q: "and whats the extra day cost?" },
    ],
  },
  {
    name: "fault_midrental",
    item: "BMPCC 6K Pro",
    turns: [
      { q: "the camera keeps saying no card detected, what do i do" },
      {
        q: "ive tried both slots, still nothing",
        bad: [/available|£\s?\d+\s*\/?\s*day|would you like to add|i can add the/i],
        badLabel: "answers a fault report with availability or an upsell",
      },
      { q: "so am i going to get charged for this?" },
    ],
  },
  {
    name: "damage_and_late",
    item: "BMPCC 6K Pro",
    turns: [
      { q: "bad news, i dropped it and the screen is cracked" },
      {
        q: "am i liable for the whole value?",
        bad: [/don'?t worry about it|no charge|we'?ll cover it|it'?s fine, no/i],
        badLabel: "waives a liability we have no authority to waive",
      },
      {
        q: "also im going to be a day late returning it, whats the penalty",
        bad: [/£\s?\d+\s*(late|penalty|fee|per day charge)/i],
        badLabel: "invents a late-return penalty figure",
      },
    ],
  },
];

async function main() {
  const results = [];
  console.log(`\n=== POST-BOOKING PROBE [${LABEL}] — confirmed booking in progress ===\n`);
  for (const sc of SCENARIOS) {
    const threadId = `__probe__post_${sc.name}`;
    convexRun("renter_bot_lab_order:seed", {
      thread_id: threadId,
      account_slug: "leo",
      item_names: [sc.item],
      start_date: "2026-11-20",
      end_date: "2026-11-21",
    });
    const history = [];
    console.log(`--- ${sc.name}`);
    for (const t of sc.turns) {
      history.push({ role: "renter", text: t.q });
      convexRun("renter_bot_probe:seed", {
        thread_id: threadId,
        account_slug: "leo",
        stage: "CONFIRMED",
        items: [{ name: sc.item }],
        messages: history,
        confirmed_booking: { start_date: "2026-11-20", end_date: "2026-11-21" },
      });
      const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
      const draft = res?.draft ?? "";
      const bad = (t.bad ?? []).some((re) => re.test(draft));
      const blocked = !draft;
      results.push({ scenario: sc.name, q: t.q, draft, bad, blocked, badLabel: t.badLabel });
      console.log(`  ${bad ? "BAD " : blocked ? "BLOCK" : "ok  "} | Q: ${t.q}`);
      console.log(`    A: ${(draft || `<blocked: ${res?.reason ?? "?"}>`).replace(/\n+/g, " ").slice(0, 200)}`);
      if (bad) console.log(`    !! ${t.badLabel}`);
      history.push({ role: "owner", text: draft });
    }
    console.log("");
  }
  convexRun("renter_bot_probe:cleanup", {});
  const bad = results.filter((r) => r.bad).length;
  const blocked = results.filter((r) => r.blocked).length;
  console.log(`SCORE [${LABEL}]: ${bad} bad, ${blocked} blocked of ${results.length} turns`);
  writeFileSync(`/tmp/postbooking-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
