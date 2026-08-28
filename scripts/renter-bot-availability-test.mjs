/**
 * Availability answers when the renter gives NO dates.
 *
 * Live failure: the BMPCC 6K Full Frame was out on a real rental spanning that
 * very day (27 Aug 17:00 -> 29 Aug 12:30, dbcinema) with next_free_date the
 * 30th. Asked "hi is this avaliable ?" the bot replied "Hi, yes, the BMPCC 6K
 * Full Frame is available."
 *
 * The cause was structural, not a model slip: the overlap loop is gated on a
 * requested date, so with none, `overlapping` stayed 0 and the fact pack
 * emitted "AVAILABLE ... N remain free. Do NOT describe it as booked out" —
 * the strongest possible claim on zero evidence. Absence of a date was being
 * treated as evidence of freedom.
 *
 * This is the worst failure class in the system: the renter books, and the
 * gear is not there.
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

/** An unqualified yes — "yes it's available" with no caveat about being out. */
const ASSERTS_FREE =
  /\b(yes|yep|yeah)\b[^.!?]{0,40}\b(available|free|up for grabs)\b|\bit'?s (currently )?available\b|\bis available\b(?![^.!?]{0,60}\b(from|after|on the)\b)/i;
/** Acknowledges the real position instead. */
const ACKNOWLEDGES_OUT =
  /\b(out|booked|rented|unavailable|on (another )?rental|currently with)\b|\bfree (from|after)\b|\bnext (free|available)\b|\bback on\b/i;

async function main() {
  const cases = [
    {
      name: "no dates, item OUT right now",
      account: "dbcinema",
      item: "BMPCC 6K Full Frame",
      q: "hi is this avaliable ?",
      mustNotAssertFree: true,
    },
    {
      name: "no dates, follow-up phrasing",
      account: "dbcinema",
      item: "BMPCC 6K Full Frame",
      q: "hey, is this one still free to rent?",
      mustNotAssertFree: true,
    },
  ];

  const results = [];
  console.log(`\n=== AVAILABILITY (NO DATES) PROBE [${LABEL}] ===\n`);
  for (const c of cases) {
    const tid = `__probe__avail_${c.name.replace(/[^a-z]/gi, "")}`;
    convexRun("renter_bot_probe:seed", {
      thread_id: tid,
      account_slug: c.account,
      stage: "INQUIRY",
      items: [{ name: c.item }],
      messages: [{ role: "renter", text: c.q }],
    });
    const res = convexRun("replyInbox_actions:generateDraft", { thread_id: tid });
    const d = res?.draft ?? "";
    const assertsFree = ASSERTS_FREE.test(d);
    const acks = ACKNOWLEDGES_OUT.test(d);
    const pass = !!d && !assertsFree && acks;
    results.push({ ...c, draft: d, assertsFree, acks, pass });
    console.log(`  ${pass ? "PASS" : "FAIL"} | ${c.name}`);
    console.log(`    Q: ${c.q}`);
    console.log(`    A: ${(d || "<no draft>").replace(/\n+/g, " ").slice(0, 220)}`);
    if (!pass && assertsFree)
      console.log(`    !! asserted it is available while it is out on rental today`);
    if (!pass && !acks) console.log(`    !! never mentions it is out / when it is next free`);
  }

  convexRun("renter_bot_probe:cleanup", {});
  const n = results.filter((r) => r.pass).length;
  console.log(`\nSCORE [${LABEL}]: ${n}/${results.length} handled correctly`);
  writeFileSync(`/tmp/availability-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
