/**
 * Before/after probe for the per-account HARD TRUTHS.
 *
 * Daniel writes these in Settings, one block per account, and they read as
 * standing instructions to the bot: what is free, what may be offered, how to
 * read a listing title. They are assembled in convex/replyInbox.ts and shown in
 * the Settings drawer — and the renter-bot draft route never receives them. The
 * model has never seen a single one.
 *
 * The cost is visible in old transcripts: "I have a 128GB V30 SD card
 * available for £10/day if you need extra storage", on accounts whose hard
 * truths say SD cards are included free and must never be quoted as paid.
 *
 * Each turn targets one clause:
 *   - accessories are free            -> must not carry a price
 *   - only offer gear we actually own -> must not name stock we don't have
 *   - "like a [model]" in a title is marketing, not inventory
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
  {
    q: "do i need to bring my own sd card or is one included?",
    // Any price attached to a card/battery/charger/cable/strap breaks the rule.
    bad: /\b(sd card|memory card|card|batter\w+|charger|cable|strap)\b[^.!?]{0,40}£\s?\d|£\s?\d[^.!?]{0,40}\b(sd card|memory card|batter\w+|charger|cable|strap)\b/i,
    label: "prices an accessory the account gives away free",
  },
  {
    q: "and spare batteries, how much are those?",
    bad: /£\s?\d/,
    label: "quotes a price for spare batteries (included free)",
  },
  {
    q: "do you have an atomos ninja monitor?",
    // WE GENUINELY OWN an Atomos Ninja V, so "yes, I have one" is TRUE and an
    // earlier version of this regex was simply wrong to flag it. The real
    // breach would be offering a model we DON'T stock because a listing title
    // says "like a [model]" — e.g. offering an Atomos Shogun, which we do not
    // have, off the back of the Hollyland Pyro's "(Like Atomos)" title.
    bad: /\b(yes|i (do )?have|i've got)\b[^.!?]{0,40}atomos (shogun|flame|inferno)/i,
    label: "offers an Atomos model we do not stock, off a 'like Atomos' title",
  },
];

async function main() {
  const threadId = "__probe__hardtruths";
  const item = "Sony FX3";
  convexRun("renter_bot_lab_order:seed", {
    thread_id: threadId,
    account_slug: "leo",
    item_names: [item],
    start_date: "2026-11-25",
    end_date: "2026-11-26",
  });

  const history = [];
  const results = [];
  console.log(`\n=== HARD TRUTHS PROBE [${LABEL}] ===\n`);
  for (const t of TURNS) {
    history.push({ role: "renter", text: t.q });
    convexRun("renter_bot_probe:seed", {
      thread_id: threadId,
      account_slug: "leo",
      stage: "INQUIRY",
      items: [{ name: item }],
      messages: history,
    });
    const res = convexRun("replyInbox_actions:generateDraft", { thread_id: threadId });
    const draft = res?.draft ?? "";
    const bad = draft ? t.bad.test(draft) : false;
    results.push({ q: t.q, draft, bad, label: t.label });
    console.log(`  ${bad ? "BREACH" : draft ? "ok    " : "block "} | Q: ${t.q}`);
    console.log(`    A: ${(draft || `<blocked: ${res?.reason ?? "?"}>`).replace(/\n+/g, " ").slice(0, 200)}`);
    if (bad) console.log(`    !! ${t.label}`);
    history.push({ role: "owner", text: draft });
  }

  convexRun("renter_bot_probe:cleanup", {});
  const n = results.filter((r) => r.bad).length;
  console.log(`\nSCORE [${LABEL}]: ${n}/${TURNS.length} turns broke a hard truth`);
  writeFileSync(`/tmp/hardtruths-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
