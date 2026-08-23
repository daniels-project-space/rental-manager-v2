/**
 * Before/after probe for data we HOLD but the bot could not read.
 *
 * Every turn here asks something a real renter asks constantly, and every one
 * is answerable from a populated `items` field that never reached the prompt:
 *
 *   card_type            67/81 items   "what card do I need?"
 *   battery_type         67/81         "does it come with batteries?"
 *   included_with_rental 32/81         "what's actually in the box?"
 *   weight_kg + dims     68/81         "will it fit in hand luggage?"
 *   replacement_cost_gbp 76/81         "what if I damage it?"
 *   delivery_notes       68/81         "can you deliver?"
 *   item_specs           72 rows       "does it shoot 4K120?"
 *
 * Run before the fix to capture the baseline, then after. Grep-able verdicts
 * are printed per turn so the two runs can be diffed directly.
 *
 * SAFETY: `__probe__` thread ids only, cleaned up at the end. No send path.
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

/**
 * Each turn carries the ground truth it should surface, so a pass/fail is
 * mechanical rather than a judgement call about tone.
 */
const TURNS = [
  {
    q: "hi, what memory card does the bmpcc 6k pro take? i need to buy one",
    expect: [/cfast/i, /uhs|sd\b/i],
    field: "card_type = CFast 2.0 + SD UHS-II",
  },
  {
    q: "does it come with batteries or do i bring my own?",
    expect: [/lp-?e6/i],
    field: "battery_type = Canon LP-E6NH, included = 5x LP-E6NH",
  },
  {
    q: "whats actually in the box when i collect it?",
    expect: [/ssd|cage|case/i],
    field: "included_with_rental = 5x battery, 1TB SSD, cage, hard case",
  },
  {
    q: "im flying with it, how heavy is it and what size is the case?",
    expect: [/kg|\d+\s*x\s*\d+/i],
    field: "weight_kg = 0.9, dims = 28x20x16cm",
  },
  {
    q: "whats the situation if i damage it, whats it actually worth?",
    expect: [/£\s?2[,.]?0?0?0|2000/],
    field: "replacement_cost_gbp = 2000",
  },
  {
    q: "does it actually shoot 6k braw internally?",
    expect: [/6k|braw/i],
    field: "item_specs = Super 35 6144x3456, records 6K BRAW",
  },
];

async function main() {
  const threadId = "__probe__datagap";
  const account = "leo";
  const item = "BMPCC 6K Pro";
  convexRun("renter_bot_lab_order:seed", {
    thread_id: threadId,
    account_slug: account,
    item_names: [item],
    start_date: "2026-11-04",
    end_date: "2026-11-05",
  });

  const history = [];
  const results = [];
  console.log(`\n=== DATA-GAP PROBE [${LABEL}] — ${item} @ ${account} ===\n`);
  for (let i = 0; i < TURNS.length; i++) {
    const t = TURNS[i];
    history.push({ role: "renter", text: t.q });
    convexRun("renter_bot_probe:seed", {
      thread_id: threadId,
      account_slug: account,
      stage: "INQUIRY",
      items: [{ name: item }],
      messages: history,
    });
    const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
    const draft = res?.draft ?? "";
    // Answered = the draft contains the real value, not a promise to check.
    const answered = draft ? t.expect.every((re) => re.test(draft)) : false;
    const deferred = /I'?ll (check|confirm|find out|come back)|let me (check|confirm)|get back to you/i.test(
      draft,
    );
    results.push({ q: t.q, field: t.field, draft, answered, deferred, blocked: !draft });
    console.log(`[${i + 1}] ${answered ? "ANSWERED" : deferred ? "DEFERRED" : draft ? "MISSED  " : "BLOCKED "} | ${t.field}`);
    console.log(`    Q: ${t.q}`);
    console.log(`    A: ${(draft || "<no draft>").replace(/\n+/g, " ").slice(0, 200)}`);
    history.push({ role: "owner", text: draft });
  }

  convexRun("renter_bot_probe:cleanup", {});
  const answered = results.filter((r) => r.answered).length;
  console.log(`\nSCORE [${LABEL}]: ${answered}/${TURNS.length} answered from real data`);
  writeFileSync(`/tmp/datagap-${LABEL}.json`, JSON.stringify(results, null, 2));
  console.log(`transcript -> /tmp/datagap-${LABEL}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
