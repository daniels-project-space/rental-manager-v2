/**
 * Before/after probe for COMPLEMENT recommendations.
 *
 * The bot's only upsell tool is find_owned_alternatives, which ranks
 * SUBSTITUTES — same kind, same mount, "instead of". It has never had data on
 * what actually goes out TOGETHER, so "what else should I take?" is answered
 * from plausibility rather than evidence.
 *
 * We hold that evidence: across completed rentals the Sony FX3 ships with the
 * GM 24-70mm 141 times (across canonical-name variants), the A7 III with the
 * same lens 39 times, the GoPro with suction cups 13.
 *
 * A pass means the bot names the item our own rental history says pairs with
 * it. Guessing a different-but-plausible lens is a MISS, not a pass — the
 * whole point is that the recommendation is grounded.
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
    name: "fx3_complement",
    item: "Sony FX3",
    start: "2026-11-05",
    end: "2026-11-06",
    // 141 real pairings — by far the strongest signal in the book.
    expect: /24-?70/i,
    expectLabel: "Sony GM 24-70mm f2.8 (141 real pairings)",
    turns: [
      "hi is the fx3 free 5th-6th nov?",
      "im shooting interviews, what else would you recommend taking with it?",
      "ok what do most people rent alongside it",
    ],
  },
  {
    name: "gopro_complement",
    item: "GoPro 12 Hero",
    start: "2026-11-12",
    end: "2026-11-13",
    expect: /suction/i,
    expectLabel: "Suction cups (13 real pairings)",
    turns: [
      "gopro free 12-13 nov?",
      "its for filming in a car, anything else i should add?",
      "what do other people usually take with the gopro",
    ],
  },
];

async function main() {
  const results = [];
  console.log(`\n=== COMPLEMENT PROBE [${LABEL}] ===\n`);
  for (const sc of SCENARIOS) {
    const threadId = `__probe__complement_${sc.name}`;
    convexRun("renter_bot_lab_order:seed", {
      thread_id: threadId,
      account_slug: "leo",
      item_names: [sc.item],
      start_date: sc.start,
      end_date: sc.end,
    });
    const history = [];
    let hit = false;
    let lastDraft = "";
    for (const q of sc.turns) {
      history.push({ role: "renter", text: q });
      convexRun("renter_bot_probe:seed", {
        thread_id: threadId,
        account_slug: "leo",
        stage: "INQUIRY",
        items: [{ name: sc.item }],
        messages: history,
      });
      const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
      const draft = res?.draft ?? "";
      lastDraft = draft || `<blocked: ${res?.reason ?? "?"}>`;
      if (sc.expect.test(draft)) hit = true;
      history.push({ role: "owner", text: draft });
      console.log(`  Q: ${q}`);
      console.log(`  A: ${(draft || "<no draft>").replace(/\n+/g, " ").slice(0, 190)}`);
    }
    console.log(
      `  => ${hit ? "GROUNDED" : "MISSED  "} | expected ${sc.expectLabel}\n`,
    );
    results.push({ scenario: sc.name, hit, expect: sc.expectLabel, lastDraft });
  }
  convexRun("renter_bot_probe:cleanup", {});
  const n = results.filter((r) => r.hit).length;
  console.log(`SCORE [${LABEL}]: ${n}/${SCENARIOS.length} grounded in real pairing history`);
  writeFileSync(`/tmp/complement-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
