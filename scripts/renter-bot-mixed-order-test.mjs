/**
 * The renter wants a DIFFERENT MIX than the listing they messaged about.
 *
 * Real exchange, from the shadow eval: "Happy to proceed with one A7iii and one
 * A7V plus lenses and tripod" — on a thread whose listing is a fixed 2x A7III
 * kit. The bot produced nothing at all; the guard blocked it for quoting a
 * price it could not ground.
 *
 * I first read that as the guard being right — no grounded price exists for
 * that combination. Daniel corrected it: single-body listings exist. The
 * catalogue holds 37 A7III listings (body-only from £17/day) and 13 A7V
 * listings (body-only £30/day on all three accounts). Every number needed was
 * sitting there.
 *
 * The gap was the instruction: lookup_pricing was scoped to "a substitute
 * you're offering because we don't own what they asked for", so re-speccing an
 * order out of gear we DO stock had no sanctioned path. The bot stayed anchored
 * on the bundle it was handed.
 *
 * A mixed order is one of the most valuable messages a renter can send — they
 * are telling you what they will pay for. Silence there is a booking walking.
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
      timeout: 240000,
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
    return { __error: String(e.message ?? e).slice(0, 160) };
  }
}

/** Hedging when a lookup would have answered it. */
const DEFER =
  /\b(let me check|i'?ll check|i will check|i'?ll confirm|let me confirm|get back to you|i'?ll find out)\b/i;
/** Telling the renter the combination can't be done — the wrong answer. */
const REFUSES =
  /\b(only available as|comes as a (set|pair|bundle)|can'?t split|cannot split|not available separately|only as a kit|isn'?t possible)\b/i;

const CASES = [
  {
    id: "swap_one_body",
    account: "leo",
    item: "2× Sony A7 III 4K Camera + 24-70mm f/2.8 GM Lens Kit – Full Frame Mirrorless",
    q: "happy to proceed with one A7iii and one A7V plus lenses and a tripod — what's the total per day?",
    wants: /a7\s?v/i,
    wantsLabel: "prices the A7 V (an item off this listing but in our catalogue)",
  },
  {
    id: "body_only",
    account: "dbcinema",
    item: "Sony a7III A73 a7 3 + 24-70 mm g master f2.8 lens zoom gm g-master gmaster Sony",
    q: "do i need the lens? i have my own glass — how much for just the body?",
    wants: /£\s?\d/,
    wantsLabel: "quotes a body-only price",
  },
  {
    id: "add_second_camera",
    account: "diogo",
    item: "Sony Alpha a7 IV 4K Mirrorless Camera Body Set | Full Frame, a74, a7",
    q: "can i add a second camera for a two-cam interview setup? what would that come to",
    wants: /£\s?\d/,
    wantsLabel: "prices the second body",
  },
];

async function main() {
  const results = [];
  console.log(`\n=== MIXED-ORDER PROBE [${LABEL}] ===\n`);
  for (const c of CASES) {
    const tid = `__probe__mixed_${c.id}`;
    const res = convexRun("renter_bot_probe:run", {
      thread_id: tid,
      account_slug: c.account,
      stage: "INTERESTED",
      items: [{ name: c.item }],
      messages: [{ role: "renter", text: c.q }],
    });
    const d = res?.draft ?? "";
    const silent = !d;
    const defers = d ? DEFER.test(d) : false;
    const refuses = d ? REFUSES.test(d) : false;
    const answered = d ? c.wants.test(d) : false;
    const pass = !silent && !refuses && answered;
    results.push({ ...c, draft: d, reason: res?.reason, silent, defers, refuses, answered, pass });

    console.log(`  ${pass ? "PASS" : "FAIL"} | ${c.id}`);
    console.log(`    Q: ${c.q}`);
    console.log(`    A: ${(d || `<no draft: ${res?.reason ?? "?"}>`).replace(/\n+/g, " ").slice(0, 230)}`);
    if (silent) console.log(`    !! renter got silence`);
    else if (refuses) console.log(`    !! told them the combination can't be done`);
    else if (!answered) console.log(`    !! never ${c.wantsLabel}`);
    if (defers) console.log(`    ~  hedged, though a lookup_pricing call would answer it`);
  }

  convexRun("renter_bot_probe:cleanup", {});
  const n = results.filter((r) => r.pass).length;
  console.log(`\nSCORE [${LABEL}]: ${n}/${CASES.length} mixed orders handled`);
  writeFileSync(`/tmp/mixed-${LABEL}.json`, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
