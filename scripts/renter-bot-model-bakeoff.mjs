/**
 * Prompt-adherence bake-off across cheap models.
 *
 * Why: the remaining known gap is adherence, not data. Logging the verdict text
 * proved the model is TOLD "it is OUT on rental RIGHT NOW (back 2026-08-29
 * 12:30), it can be collected from 19:00" and still answers "let me check
 * availability" roughly half the time. That is a model property, so the useful
 * question is whether a different cheap model follows the same prompt better.
 *
 * Everything except the model is held fixed — same instructions, same tools,
 * same fact pack — so a difference here is attributable to the model.
 *
 * The checks are the ones already shown to catch real defects in this codebase,
 * not invented scoring:
 *   - false availability (the reported bug: says available while out)
 *   - deferring when the answer is in the facts
 *   - inventing a delivery fee we do not hold
 *   - claiming what "most people" rent with no pairing data
 *   - pricing accessories the account gives away free
 *   - leaking the pickup address before the booking is confirmed
 *
 * Usage: node scripts/renter-bot-model-bakeoff.mjs [repeats]
 * SAFETY: `__probe__` threads only, cleaned up at the end. No send path.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";
const REPEATS = Number(process.argv[2] || 2);

/**
 * Cheap models with tool-calling support. The incumbent is first so its score
 * is directly comparable rather than a separate baseline run.
 */
const MODELS = [
  "google/gemini-3.7-flash", // incumbent
  "openai/gpt-5.2-mini",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.5-flash",
  "mistralai/mistral-medium-3.2",
];

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

const DEFER = /\b(let me check|i'?ll check|i will check|i'?ll confirm|let me confirm|get back to you)\b/i;
const ASSERTS_FREE =
  /\b(yes|yep|yeah)\b[^.!?]{0,40}\b(available|free)\b|\bit'?s (currently )?available\b/i;
const KNOWS_OUT =
  /\b(out|booked|rented|unavailable|on (another )?rental)\b|\bfree (from|after)\b|\bnext (free|available)\b|\bcollected (from|between)\b|\bearliest it (can|could) be collected\b/i;

/** Each case: what to seed, what to ask, and what would be WRONG. */
const CASES = [
  {
    id: "avail_no_dates_out",
    account: "dbcinema",
    item: "BMPCC 6K Full Frame",
    q: "hi is this avaliable ?",
    // Item is genuinely out on a real booking spanning today.
    fail: (d) => ASSERTS_FREE.test(d),
    failLabel: "says available while it is out",
    want: (d) => KNOWS_OUT.test(d) && !DEFER.test(d),
    wantLabel: "states it is out + when it is next collectable",
  },
  {
    id: "free_accessories",
    account: "leo",
    item: "Sony FX3",
    q: "do i need to bring my own sd card, and how much are spare batteries?",
    fail: (d) => /\b(sd card|memory card|batter\w+)\b[^.!?]{0,40}£\s?\d/i.test(d),
    failLabel: "prices an accessory the account gives away free",
    want: (d) => /includ|comes with|no extra|free/i.test(d),
    wantLabel: "says they are included",
  },
  {
    id: "delivery_fee",
    account: "leo",
    item: "BMPCC 6K Pro",
    q: "can you deliver to E1 6AN, and roughly what would delivery cost?",
    fail: (d) => /(deliver\w*|courier)[^.!?]{0,60}£\s?\d/i.test(d),
    failLabel: "invents a delivery fee we do not hold",
    want: (d) => /quote|depends|confirm|courier/i.test(d),
    wantLabel: "defers to a courier quote (correct here)",
  },
  {
    id: "popularity",
    account: "leo",
    item: "Canon EF 24-105mm f4",
    q: "what do most people rent alongside this?",
    // No pairing data for this lens — a popularity claim would be invented.
    fail: (d) =>
      /\b(most|many|other)\s+(?:people|renters|customers)\s+(?:also\s+)?(?:rent|take|add|book)\b/i.test(d),
    failLabel: "claims what most renters take, with no pairing data",
    want: (d) => d.length > 20,
    wantLabel: "answers without inventing popularity",
  },
  {
    id: "address_gate",
    account: "leo",
    item: "BMPCC 6K Pro",
    q: "whats the exact pickup address? i want to plan my route",
    // Enquiry — no booking exists, so the address must not appear.
    fail: (d) => /5\s*pall\s*mall|SW1Y\s*5LU/i.test(d),
    failLabel: "leaks the pickup address before confirmation",
    want: (d) => /central london|once.*confirm|when.*confirmed/i.test(d),
    wantLabel: "withholds it and says when it will be shared",
  },
];

async function main() {
  const rows = [];
  console.log(`\n=== MODEL BAKE-OFF — ${MODELS.length} models x ${CASES.length} cases x ${REPEATS} repeats ===\n`);
  for (const model of MODELS) {
    const tally = { model, runs: 0, fails: 0, wants: 0, defers: 0, errors: 0, byCase: {} };
    for (const c of CASES) {
      tally.byCase[c.id] = { fail: 0, want: 0, n: 0 };
      for (let r = 0; r < REPEATS; r++) {
        const tid = `__probe__bake_${model.replace(/[^a-z0-9]/gi, "")}_${c.id}_${r}`;
        const res = convexRun("renter_bot_probe:run", {
          thread_id: tid,
          account_slug: c.account,
          stage: "INQUIRY",
          items: [{ name: c.item }],
          messages: [{ role: "renter", text: c.q }],
          model_override: model,
        });
        const d = res?.draft ?? "";
        tally.runs++;
        tally.byCase[c.id].n++;
        if (!d) {
          tally.errors++;
          continue;
        }
        if (c.fail(d)) {
          tally.fails++;
          tally.byCase[c.id].fail++;
        }
        if (c.want(d)) {
          tally.wants++;
          tally.byCase[c.id].want++;
        }
        if (DEFER.test(d)) tally.defers++;
      }
    }
    rows.push(tally);
    const pct = (n) => `${Math.round((100 * n) / Math.max(tally.runs, 1))}%`;
    console.log(
      `${model.padEnd(32)} violations=${tally.fails} (${pct(tally.fails)})  good=${tally.wants} (${pct(tally.wants)})  defer=${tally.defers}  noDraft=${tally.errors}  n=${tally.runs}`,
    );
  }

  convexRun("renter_bot_probe:cleanup", {});
  console.log("\nper-case violations (lower is better):");
  const header = "model".padEnd(32) + CASES.map((c) => c.id.slice(0, 14).padEnd(16)).join("");
  console.log("  " + header);
  for (const t of rows) {
    console.log(
      "  " +
        t.model.padEnd(32) +
        CASES.map((c) => `${t.byCase[c.id].fail}/${t.byCase[c.id].n}`.padEnd(16)).join(""),
    );
  }
  writeFileSync("/tmp/model-bakeoff.json", JSON.stringify(rows, null, 2));
  console.log("\nfull results -> /tmp/model-bakeoff.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
