#!/usr/bin/env node
/**
 * check-patterns — guard against regressions to the patterns established
 * in the 2026-05-15 cost audit (CLAUDE.md). Runs as `npm run check:patterns`.
 *
 * Ratchet model: a baseline file (`scripts/check-patterns-baseline.txt`)
 * lists every violation that existed at the time the rules were
 * introduced. Pre-existing violations are silently allowed; ANY NEW
 * violation fails the build. This gives the codebase a one-way
 * cleanup ratchet without forcing a big-bang rewrite.
 *
 * Workflow when adding a rule:
 *   1. Add it to RULES.
 *   2. Re-baseline:  npm run check:patterns -- --update-baseline
 *   3. Commit the new baseline file.
 *
 * Workflow when removing a violation (the desirable direction):
 *   1. Fix the file.
 *   2. The baseline entry is now stale; either accept the warning or
 *      re-baseline (which shrinks the file — you want this).
 *
 * Allow individual lines via trailing comment  // check-patterns:ok.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const BASELINE = join(ROOT, "scripts", "check-patterns-baseline.txt");
const ALLOW_MARKER = "check-patterns:ok";
const updateBaseline = process.argv.includes("--update-baseline");

const RULES = [
  {
    name: "no-collect-on-reservations-without-index",
    pattern: /ctx\.db\.query\("reservations"\)\s*\.collect\(\)/,
    include: /^convex\/.*\.ts$/,
    exclude: /(_generated|listForReconcile|admin_purgeV1|reservations\.ts)/,
    fix: 'Use .withIndex("by_start_date", q => q.gte("start_date", cutoff)) — see convex/mv/top_earners.ts',
    severity: "error",
  },
  {
    name: "no-llm-in-convex-action",
    pattern: /(generateObject|generateText)\s*\(/,
    include: /^convex\/.*\.ts$/,
    exclude: /(_generated)/,
    fix: 'Move LLM batch to src/trigger/ — copy src/trigger/canonicalize-denials.ts',
    severity: "error",
  },
  {
    name: "no-public-convex-url-env-in-mastra",
    pattern: /process\.env\.NEXT_PUBLIC_CONVEX_URL/,
    include: /^src\/(mastra|app\/api)\/.*\.ts$/,
    fix: 'Vercel pins this to the wrong deployment. Hardcode hearty-oyster-600 — see src/mastra/data/client.ts',
    severity: "error",
  },
  {
    name: "cron-cadence-floor-5min",
    pattern: /crons\.interval\([^)]*\{\s*minutes:\s*[1-4]\b/s,
    include: /^convex\/crons\.ts$/,
    fix: 'Cadence < 5 min is wasteful. Use a webhook or reactive subscription, or raise to 5+ min.',
    severity: "error",
  },
  {
    name: "trigger-task-must-set-maxDuration",
    pattern: /schedules\.task\(\{\s*(?![^}]*maxDuration)/s,
    include: /^src\/trigger\/.*\.ts$/,
    fix: 'Add maxDuration: <seconds> so stuck LLM calls bill bounded — see src/trigger/canonicalize-denials.ts',
    severity: "warn",
  },
];

function* walk(dir) {
  const SKIP = new Set(["node_modules", ".next", ".trigger", "dist", "build", ".git"]);
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".mjs")) yield p;
  }
}

function key(rule, file, line) {
  return `${rule}|${file}:${line}`;
}

const baseline = new Set(
  existsSync(BASELINE)
    ? readFileSync(BASELINE, "utf8").split("\n").filter((l) => l && !l.startsWith("#"))
    : [],
);

const found = []; // { rule, severity, file, line, text, fix }

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const lines = readFileSync(file, "utf8").split("\n");
  for (const rule of RULES) {
    if (!rule.include.test(rel)) continue;
    if (rule.exclude && rule.exclude.test(rel)) continue;

    const checkLine = (idx, text) => {
      if (text.includes(ALLOW_MARKER)) return;
      found.push({
        rule: rule.name,
        severity: rule.severity,
        file: rel,
        line: idx + 1,
        text,
        fix: rule.fix,
      });
    };

    if (rule.pattern.flags.includes("s")) {
      const text = lines.join("\n");
      const m = rule.pattern.exec(text);
      if (m) {
        const lineNum = text.slice(0, m.index).split("\n").length;
        checkLine(lineNum - 1, lines[lineNum - 1] ?? "");
      }
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) checkLine(i, lines[i]);
    }
  }
}

if (updateBaseline) {
  const sorted = found
    .map((v) => key(v.rule, v.file, v.line))
    .sort();
  writeFileSync(
    BASELINE,
    `# check-patterns baseline — pre-existing violations allowed by the ratchet.
# Regenerate with:  npm run check:patterns -- --update-baseline
# Each line: rule|relative-path:line
${sorted.join("\n")}
`,
  );
  console.log(`✓ baseline updated: ${sorted.length} entries`);
  process.exit(0);
}

const newViolations = found.filter((v) => !baseline.has(key(v.rule, v.file, v.line)));

let errors = 0;
let warnings = 0;
for (const v of newViolations) {
  const tag = v.severity === "error" ? "✖" : "⚠";
  console.log(`${tag}  ${v.file}:${v.line}  ${v.rule}`);
  console.log(`   ${v.text.trim()}`);
  console.log(`   fix: ${v.fix}`);
  console.log();
  if (v.severity === "error") errors++;
  else warnings++;
}

if (errors === 0 && warnings === 0) {
  console.log(`✓ check-patterns: no NEW violations (${baseline.size} pre-existing in baseline)`);
  process.exit(0);
}

console.log(`check-patterns: ${errors} new error(s), ${warnings} new warning(s)`);
console.log(`Pre-existing violations (${baseline.size}) are allowed by the ratchet.`);
console.log(
  "If a violation is intentional and not yet fixable, add  // check-patterns:ok  to the line, OR run\n" +
  "  npm run check:patterns -- --update-baseline\n" +
  "to accept the new baseline (only do this if you're tracking the cleanup separately).",
);
process.exit(errors > 0 ? 1 : 0);
