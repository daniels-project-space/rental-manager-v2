/**
 * Shadow evaluation — grade the bot against Daniel's REAL replies.
 *
 * Every other test in this directory scores the bot against scenarios I wrote
 * and a rubric I wrote. This one replays real historical exchanges and compares
 * the draft to what Daniel actually sent. It is the only external yardstick
 * available.
 *
 * Read the output as three separate things, because they mean different things:
 *
 *   DEFECTS       — the bot contradicted a fact Daniel stated, or produced
 *                   nothing at all. These are real and should be fixed.
 *   DIVERGENCES   — the bot said something different but not provably wrong
 *                   (longer, asked no question, answered where he deferred).
 *                   Read these; some are the bot being better.
 *   INCOMPARABLE  — the exchange turned on specific dates. Replayed against
 *                   today's calendar, a difference proves nothing. Excluded
 *                   from scoring on purpose.
 *
 * Usage: node scripts/renter-bot-shadow-eval.mjs [limit] [label]
 * SAFETY: seeds `__probe__` threads only, cleaned up by the action. No send path.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CVX = "./node_modules/.bin/convex";
const LIMIT = Number(process.argv[2] || 25);
const LABEL = process.argv[3] ?? "run";

function convexRun(fn, args) {
  const out = execFileSync(CVX, ["run", fn, JSON.stringify(args ?? {})], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900000,
  });
  const t = out.trim();
  const i = t.search(/[[{]/);
  return JSON.parse(i >= 0 ? t.slice(i) : t);
}

const trim = (s, n = 110) => (s || "").replace(/\s+/g, " ").slice(0, n);

async function main() {
  console.log(`\n=== SHADOW EVAL [${LABEL}] — ${LIMIT} real exchanges ===\n`);
  const res = convexRun("renter_bot_shadow:runSample", {
    limit: LIMIT,
    require_items: true,
  });

  const { results, totals, by_category } = res;

  // Defects first — these are the ones that matter.
  const defective = results.filter((r) => r.defects > 0);
  console.log(`--- DEFECTS (${defective.length}/${results.length} exchanges) ---\n`);
  for (const r of defective.slice(0, 12)) {
    console.log(`  [${r.account_slug}] thread ${r.thread_id}  items: ${r.item_names.join(", ") || "-"}`);
    console.log(`    RENTER: ${trim(r.ask)}`);
    console.log(`    DANIEL: ${trim(r.real_reply)}`);
    console.log(`    BOT   : ${trim(r.draft) || `<no draft: ${r.no_draft_reason ?? "?"}>`}`);
    for (const v of r.verdicts.filter((x) => x.status === "defect"))
      console.log(`    !! ${v.category}: ${v.detail}`);
    console.log("");
  }

  console.log(`--- BY CATEGORY ---`);
  for (const [cat, counts] of Object.entries(by_category)) {
    const parts = Object.entries(counts)
      .map(([k, n]) => `${k}=${n}`)
      .join("  ");
    console.log(`  ${cat.padEnd(34)} ${parts}`);
  }

  console.log(`\n--- TOTALS ---`);
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(24)} ${v}`);
  const clean = results.length - defective.length;
  console.log(
    `\nSCORE [${LABEL}]: ${clean}/${results.length} exchanges with no defect (${Math.round((100 * clean) / Math.max(results.length, 1))}%)`,
  );

  writeFileSync(`/tmp/shadow-${LABEL}.json`, JSON.stringify(res, null, 2));
  console.log(`full transcripts -> /tmp/shadow-${LABEL}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
