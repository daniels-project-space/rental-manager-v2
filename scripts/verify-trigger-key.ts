#!/usr/bin/env tsx
export {}; // mark as ES module so top-level await is allowed
/**
 * Verifies TRIGGER_SECRET_KEY belongs to rental-manager-v2 (not music-house or another project).
 *
 * Guards against the music-house mislabel pattern: someone pastes the wrong project's
 * Trigger.dev secret key into the vault/env, deployment "succeeds", but schedules silently
 * run against the wrong account.
 *
 * Usage:
 *   TRIGGER_SECRET_KEY=tr_dev_xxx npm run verify:trigger-key
 *
 * Exit codes:
 *   0 - key belongs to rental-manager-v2 (expected schedule present, music-house schedule absent)
 *   1 - any failure: missing env var, API error, wrong project, etc.
 */

const KEY = process.env.TRIGGER_SECRET_KEY;
if (!KEY) {
  console.error("FAIL: TRIGGER_SECRET_KEY env var required.");
  console.error("Usage: TRIGGER_SECRET_KEY=<paste> npm run verify:trigger-key");
  process.exit(1);
}

const EXPECTED = "poll-hygglo-inbox";
const MUSIC_HOUSE = "refresh-routenote-auth";

const r = await fetch("https://api.trigger.dev/api/v1/schedules", {
  headers: { Authorization: `Bearer ${KEY}` },
});

if (!r.ok) {
  const body = await r.text();
  console.error(`FAIL: Trigger.dev API returned ${r.status}.`);
  console.error(body);
  process.exit(1);
}

const json = (await r.json()) as { data?: Array<{ taskIdentifier: string }> };
const data = json.data ?? [];
const tasks = new Set(data.map((d) => d.taskIdentifier));
const taskList = [...tasks];

if (!tasks.has(EXPECTED)) {
  console.error(`FAIL: Expected schedule '${EXPECTED}' not found.`);
  console.error(`Expected: ${EXPECTED}`);
  console.error(`Actual  : ${taskList.join(", ") || "(empty)"}`);
  console.error("Likely cause: TRIGGER_SECRET_KEY belongs to a different project.");
  process.exit(1);
}

if (tasks.has(MUSIC_HOUSE)) {
  console.error(
    `FAIL: Schedule '${MUSIC_HOUSE}' is present alongside '${EXPECTED}'.`,
  );
  console.error(
    "This indicates the key may belong to music-house rather than rental-manager-v2.",
  );
  console.error(`All schedules: ${taskList.join(", ")}`);
  process.exit(1);
}

console.log(
  `PASS: ${taskList.length} schedule(s) found, including '${EXPECTED}'.`,
);
console.log(`Schedules: ${taskList.join(", ")}`);
process.exit(0);
