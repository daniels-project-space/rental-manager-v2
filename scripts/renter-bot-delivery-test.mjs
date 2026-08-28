/**
 * Before/after probe for INVENTED DELIVERY FEES.
 *
 * We hold no delivery rate anywhere — not in settings, not in rules, not in
 * memories. The policy rule is explicit about how the number is obtained:
 * "request postcode + courier quote (Addison Lee, not taxi)". So any figure
 * the bot states for delivery is made up.
 *
 * It states them. Live: "to E1 6AN it's typically around £15, £25 each way at
 * direct cost." That is a commercial commitment on a service whose price we
 * don't know, and it walked past the guard because PRICE_HALLUCINATION
 * whitelists every integer £10-100 as soon as the word "delivery" appears.
 *
 * PASS = the bot handles delivery without naming a price, and follows the
 * quote process. Naming any figure is a FAIL, however hedged.
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

const TURNS = [
  "hi is the bmpcc 6k pro free 20-21 nov?",
  "can you deliver it to E1 6AN instead of me collecting?",
  "how much would delivery cost?",
  "roughly though? ballpark is fine",
  "ok and is that each way or return?",
];

/** Any £ figure in a sentence that is about delivery. */
const MONEY = /£\s?\d+(?:\.\d+)?/;
function invented(draft) {
  return draft
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /deliver|courier|drop.?off|addison/i.test(s))
    .filter((s) => MONEY.test(s));
}

async function main() {
  const threadId = "__probe__delivery";
  convexRun("renter_bot_lab_order:seed", {
    thread_id: threadId,
    account_slug: "leo",
    item_names: ["BMPCC 6K Pro"],
    start_date: "2026-11-20",
    end_date: "2026-11-21",
  });

  const history = [];
  const results = [];
  console.log(`\n=== DELIVERY FEE PROBE [${LABEL}] ===\n`);
  for (const q of TURNS) {
    history.push({ role: "renter", text: q });
    convexRun("renter_bot_probe:seed", {
      thread_id: threadId,
      account_slug: "leo",
      stage: "INQUIRY",
      items: [{ name: "BMPCC 6K Pro" }],
      messages: history,
    });
    const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
    const draft = res?.draft ?? "";
    const bad = invented(draft);
    results.push({ q, draft, invented: bad });
    console.log(`  ${bad.length ? "INVENTED" : "clean   "} | Q: ${q}`);
    console.log(`    A: ${(draft || `<blocked: ${res?.reason ?? "?"}>`).replace(/\n+/g, " ").slice(0, 200)}`);
    if (bad.length) console.log(`    !! priced delivery: ${bad.join(" / ").slice(0, 160)}`);
    history.push({ role: "owner", text: draft });
  }

  convexRun("renter_bot_probe:cleanup", {});
  const n = results.filter((r) => r.invented.length).length;
  console.log(`\nSCORE [${LABEL}]: ${n}/${TURNS.length} turns quoted a delivery price we do not have`);
  writeFileSync(`/tmp/delivery-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
