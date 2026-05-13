#!/usr/bin/env node
/**
 * Wave 4.7 — manual test runner for the monthly model auto-upgrade scanner.
 *
 * Runs the same logic the Trigger.dev task uses (model fetch + comparison)
 * WITHOUT touching Convex, GitHub, or scheduling. Useful for previewing
 * recommendations before the next cron tick.
 *
 * Usage:
 *   node scripts/test-model-scan.mjs --dry-run
 *   node scripts/test-model-scan.mjs --current grok-4.3 --dry-run
 *   node scripts/test-model-scan.mjs --fake "grok-4.3,grok-4.4,grok-5,grok-4-fast"
 *
 * Env:
 *   XAI_API_KEY  Required unless --fake is passed.
 *
 * Flags:
 *   --dry-run            Always present; this script never writes anywhere.
 *   --current <id>       Override the current pinned model (default reads
 *                        DEFAULT_GROK_CHAT_MODEL via dynamic import of the
 *                        compiled tsx file).
 *   --fake "a,b,c"       Skip the xAI fetch; use this comma-separated list.
 *   --verbose            Print every per-candidate outcome, not just the winner.
 */

import process from "node:process";

const args = process.argv.slice(2);
function getFlag(name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
}
const HAS_DRY = args.includes("--dry-run");
const VERBOSE = args.includes("--verbose");
const CURRENT_OVERRIDE = getFlag("--current");
const FAKE_LIST = getFlag("--fake");

if (!HAS_DRY) {
  console.error(
    "[test-model-scan] refusing to run without --dry-run flag (this script never writes — flag is a guard rail).",
  );
  process.exit(2);
}

// Dynamic import so this script works under plain Node (tsx required for the
// TypeScript modules). We tell users to run via `npx tsx scripts/...` if they
// hit the import error; the .mjs extension is kept for editor familiarity.
let decideRecommendation;
let DEFAULT_GROK_CHAT_MODEL;
try {
  ({ decideRecommendation } = await import("../src/lib/model-version.ts"));
  ({ DEFAULT_GROK_CHAT_MODEL } = await import("../src/lib/ai-models.ts"));
} catch (e) {
  console.error(
    "[test-model-scan] failed to import TS modules. Run via tsx:\n  npx tsx scripts/test-model-scan.mjs --dry-run\n\nUnderlying:",
    e instanceof Error ? e.message : e,
  );
  process.exit(1);
}

const current = CURRENT_OVERRIDE ?? DEFAULT_GROK_CHAT_MODEL;
let available;

if (FAKE_LIST) {
  available = FAKE_LIST.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
} else {
  const apiKey = process.env.XAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("[test-model-scan] XAI_API_KEY not set and --fake not passed.");
    process.exit(1);
  }
  const res = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    console.error(
      `[test-model-scan] xAI /v1/models returned ${res.status}: ${await res.text()}`,
    );
    process.exit(1);
  }
  const body = await res.json();
  available = (body.data ?? [])
    .map((m) => m.id)
    .filter((id) => id.toLowerCase().startsWith("grok-"))
    .sort();
}

const outcome = decideRecommendation(current, available);

console.log("=== Wave 4.7 — model auto-upgrade scanner — DRY RUN ===");
console.log(`Current pinned model       : ${current}`);
console.log(`Available Grok models      : ${available.length}`);
for (const m of available) console.log(`  - ${m}`);
console.log("");
console.log(`Recommendation             : ${outcome.recommendation}`);
console.log(`Recommended model          : ${outcome.recommendedModel ?? "-"}`);
console.log(`Reason                     : ${outcome.reason}`);

if (VERBOSE) {
  console.log("");
  console.log("=== All per-candidate outcomes ===");
  for (const o of outcome.allOutcomes ?? []) {
    console.log(
      `[${o.recommendation.padEnd(10)}] ${o.recommendedModel ?? "-"} — ${o.reason}`,
    );
  }
}

console.log("");
if (outcome.recommendation === "auto_pr") {
  console.log(
    "→ In production, this would open PR `chore/auto-grok-bump-<YYYYMMDD>` rewriting DEFAULT_GROK_CHAT_MODEL in src/lib/ai-models.ts.",
  );
  console.log(
    "  Set AUTO_MERGE_MODEL_BUMPS=true to also auto-squash-merge the PR.",
  );
} else if (outcome.recommendation === "advisory") {
  console.log(
    "→ In production, this would write a `model_upgrade_scans` row with recommendation='advisory'.",
  );
  console.log(
    "  The dashboard agent surfaces these via the `get_model_upgrade_advisories` tool.",
  );
} else {
  console.log("→ No action — current pin is up to date.");
}
