/**
 * How often does the SAME turn produce a different outcome?
 *
 * Everything else here measures one run of each scenario, which cannot see
 * flakiness at all. Across this session the same input passed 3 of 4 times more
 * than once, and every sweep number quoted so far is a single sample — so a
 * "100%" and an "84%" might be the same system twice.
 *
 * That matters more than the average. A renter does not experience the mean:
 * they send one message and either get a reply or get silence. A 10% silence
 * rate is one booking in ten going quiet.
 *
 * Runs a fixed set of turns N times each and reports, per turn: how often it
 * answered, and which guard rule withheld it when it did not. Everything is
 * held constant except the model's own non-determinism.
 *
 * Usage: node scripts/renter-bot-variance-test.mjs [repeats] [label]
 * SAFETY: `__probe__` threads only, cleaned up at the end. No send path.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";
const REPEATS = Number(process.argv[2] || 8);
const LABEL = process.argv[3] ?? "run";

function convexRun(fn, args) {
  try {
    const out = execFileSync(CVX, ["run", fn, JSON.stringify(args ?? {})], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
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

/**
 * Deliberately ordinary turns. Flakiness on an exotic edge case matters far
 * less than flakiness on "is this available" — the most common message there is.
 */
const TURNS = [
  {
    id: "availability_no_dates",
    account: "dbcinema",
    item: "Sony a7III A73 a7 3 + 24-70 mm g master f2.8 lens zoom gm g-master gmaster Sony",
    q: "hi, is this available?",
  },
  {
    id: "price_3day",
    account: "dbcinema",
    item: "Dji RS3 Gimbal ronin stabilizer rs4 rs 2 Dji ",
    q: "how much would this be for 3 days?",
  },
  {
    id: "kit_contents",
    account: "dbcinema",
    item: "Senheiser  MKE 600 Shotgun Mic (like Rode NTG mic)",
    q: "what exactly comes with it?",
  },
  {
    id: "mixed_order",
    account: "leo",
    item: "2× Sony A7 III 4K Camera + 24-70mm f/2.8 GM Lens Kit – Full Frame Mirrorless",
    q: "happy to proceed with one A7iii and one A7V plus a tripod — total per day?",
  },
];

async function main() {
  console.log(`\n=== VARIANCE PROBE [${LABEL}] — ${TURNS.length} turns x ${REPEATS} repeats ===\n`);
  const results = [];

  for (const t of TURNS) {
    const outcomes = [];
    for (let r = 0; r < REPEATS; r++) {
      const tid = `__probe__var_${t.id}_${r}`;
      convexRun("renter_bot_probe:seed", {
        thread_id: tid,
        account_slug: t.account,
        stage: "INQUIRY",
        items: [{ name: t.item }],
        messages: [{ role: "renter", text: t.q }],
      });
      const res = convexRun("replyInbox_actions:generateDraft", { thread_id: tid });
      const draft = res?.draft ?? "";
      const rule = (res?.flags ?? [])
        .map((f) => f.type ?? f.detail ?? "?")
        .join(",");
      outcomes.push({
        answered: !!draft,
        reason: res?.reason ?? null,
        rule: draft ? null : rule || res?.reason || "unknown",
        chars: draft.length,
      });
      process.stdout.write(draft ? "." : "X");
    }
    const ok = outcomes.filter((o) => o.answered).length;
    const lens = outcomes.filter((o) => o.answered).map((o) => o.chars);
    results.push({ ...t, outcomes, answered: ok });
    console.log(
      `\n  ${t.id.padEnd(22)} answered ${ok}/${REPEATS}` +
        (lens.length
          ? `  reply length ${Math.min(...lens)}-${Math.max(...lens)} chars`
          : ""),
    );
    const failures = outcomes.filter((o) => !o.answered);
    if (failures.length) {
      const byRule = {};
      for (const f of failures) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
      for (const [k, n] of Object.entries(byRule))
        console.log(`      ${n}x withheld: ${String(k).slice(0, 90)}`);
    }
  }

  convexRun("renter_bot_probe:cleanup", {});

  const total = TURNS.length * REPEATS;
  const answered = results.reduce((s, r) => s + r.answered, 0);
  // A turn that is sometimes fine and sometimes silent is the finding — a
  // consistent failure is a bug you can chase, but flakiness is invisible to
  // every single-sample test in this repo.
  const flaky = results.filter((r) => r.answered > 0 && r.answered < REPEATS);
  console.log(`\n--- SUMMARY [${LABEL}] ---`);
  console.log(`  answered            ${answered}/${total} (${Math.round((100 * answered) / total)}%)`);
  console.log(`  always answered     ${results.filter((r) => r.answered === REPEATS).length}/${TURNS.length} turns`);
  console.log(`  NEVER answered      ${results.filter((r) => r.answered === 0).length}/${TURNS.length} turns`);
  console.log(`  FLAKY               ${flaky.length}/${TURNS.length} turns${flaky.length ? ` — ${flaky.map((f) => `${f.id} ${f.answered}/${REPEATS}`).join(", ")}` : ""}`);
  writeFileSync(`/tmp/variance-${LABEL}.json`, JSON.stringify(results, null, 2));
  console.log(`\nfull results -> /tmp/variance-${LABEL}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
