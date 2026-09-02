#!/usr/bin/env node
/**
 * set-cancellation-terms — bulk cancellation/refund policy runner (2026-09-02).
 *
 * Walks EVERY listing on the given Hygglo accounts, one at a time, and sets
 * `cancellationTerms` to the requested tier. Hygglo's enum is a STRING:
 *   "0" = flexible   "1" = moderate   "2" = strict
 *
 * It drives the same path the dashboard uses, so there is one write mechanic
 * in the codebase rather than two:
 *   GET   /api/listings/{account}/items       → the id list
 *   GET   /api/listings/{account}/item/{id}   → live detail (backup + skip check)
 *   PATCH /api/listings/{account}/item/{id}   → editListing() GET → merge → PUT
 *
 * SAFETY MODEL (mirrors scripts/order-edit.ts):
 *   1. DRY RUN BY DEFAULT. Without `--yes` it only reads, and prints the exact
 *      diff it would apply. Nothing reaches Hygglo.
 *   2. Every listing's CURRENT value is written to a timestamped backup file
 *      before any write, so a whole run is reversible.
 *   3. Listings already on the target tier are skipped, so re-running is cheap
 *      and idempotent — that is the intended way to catch up new listings.
 *   4. Each listing is re-read after its write and the result verified. A
 *      failure is recorded and the run CONTINUES; one bad listing never
 *      strands the rest.
 *
 * Two behaviours worth knowing before running this:
 *   - `editListing` is GET → merge → full PUT, so every field is rewritten from
 *     live state on each listing. That is Hygglo's only way to edit; PATCH
 *     silently ignores most fields.
 *   - A side effect of that PUT is that Hygglo re-creates the image row: same
 *     filename, same URLs, but a new image id and a fresh createdAt. The photo
 *     is untouched; `images[].createdAt` just stops meaning "photo added on".
 *
 * Usage (from repo root):
 *   node scripts/set-cancellation-terms.mjs                      # dry run, all accounts
 *   node scripts/set-cancellation-terms.mjs leo                  # dry run, one account
 *   node scripts/set-cancellation-terms.mjs --tier 2 --yes       # WRITE, all accounts
 *   node scripts/set-cancellation-terms.mjs leo dbcinema --yes   # WRITE, two accounts
 *
 * Roughly 10-13 listings/min. The three accounts are ~1,130 listings, so a full
 * pass takes about 90 minutes — run it with nohup and tail the log.
 */
import { writeFileSync } from "node:fs";

const BASE = process.env.NOTIF_BASE_URL ?? "https://rental-manager-v2-nu.vercel.app";
const ALL_ACCOUNTS = ["leo", "dbcinema", "diogo"];
const LABEL = { 0: "flexible", 1: "moderate", 2: "strict" };
/** Pause between listings — deliberate, to stay polite to Hygglo. */
const THROTTLE_MS = 400;

const argv = process.argv.slice(2);
const APPLY = argv.includes("--yes");
const tierArg = argv[argv.indexOf("--tier") + 1];
const TARGET = argv.includes("--tier") ? String(tierArg) : "2";
const picked = argv.filter((a) => ALL_ACCOUNTS.includes(a));
const ACCOUNTS = picked.length ? picked : ALL_ACCOUNTS;

if (!Object.hasOwn(LABEL, TARGET)) {
  console.error(`--tier must be 0 (flexible), 1 (moderate) or 2 (strict); got ${JSON.stringify(TARGET)}`);
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BACKUP = `/tmp/cancellation-backup-${STAMP}.json`;
const REPORT = `/tmp/cancellation-report-${STAMP}.json`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} → ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

const backup = { created: new Date().toISOString(), target: TARGET, accounts: {} };
const report = [];

console.log(
  `${APPLY ? "APPLYING" : "DRY RUN"} — cancellationTerms → "${TARGET}" (${LABEL[TARGET]})\n` +
    `accounts: ${ACCOUNTS.join(", ")}\nbase: ${BASE}`,
);

for (const account of ACCOUNTS) {
  const items = await call(`/api/listings/${account}/items`);
  console.log(`\n=== ${account}: ${items.length} listings ===`);
  backup.accounts[account] = [];

  for (const [i, it] of items.entries()) {
    const n = `${i + 1}/${items.length}`;
    let detail;
    try {
      detail = await call(`/api/listings/${account}/item/${it.id}`);
    } catch (err) {
      console.log(`  ${n} ${it.id} READ-FAIL ${err.message}`);
      report.push({ account, id: it.id, name: it.name, status: "read-failed", error: err.message });
      continue;
    }

    const cur = detail.cancellationTerms ?? null;
    const published = detail.isPublished;
    backup.accounts[account].push({
      id: it.id,
      name: detail.name,
      cancellationTerms: cur,
      isPublished: published,
    });

    if (String(cur) === TARGET) {
      console.log(`  ${n} ${it.id} already ${LABEL[TARGET]} — skip`);
      report.push({ account, id: it.id, name: detail.name, from: cur, status: "already" });
      continue;
    }

    if (!APPLY) {
      console.log(`  ${n} ${it.id} ${cur ?? "(none)"} → ${TARGET}  [dry run] ${detail.name}`);
      report.push({ account, id: it.id, name: detail.name, from: cur, status: "would-change" });
      continue;
    }

    // For an unpublished listing, send isPublished explicitly: that makes
    // editListing run its follow-up enforcement PATCH, so the draft state is
    // guaranteed rather than left to the PUT (which ignores an unpublish).
    const body = { cancellationTerms: TARGET };
    if (published === false) body.isPublished = false;

    try {
      const r = await call(`/api/listings/${account}/item/${it.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok !== true) throw new Error(r.error ?? "Hygglo rejected the edit");

      const after = await call(`/api/listings/${account}/item/${it.id}`);
      const applied = String(after.cancellationTerms) === TARGET;
      const publishHeld = after.isPublished === published;
      console.log(
        `  ${n} ${it.id} ${cur ?? "(none)"} → ${after.cancellationTerms}` +
          `${applied ? " OK" : " MISMATCH"}${publishHeld ? "" : " PUBLISH-STATE-CHANGED"}` +
          `  ${detail.name}`,
      );
      report.push({
        account,
        id: it.id,
        name: detail.name,
        from: cur,
        to: after.cancellationTerms,
        status: applied ? "changed" : "verify-mismatch",
        publishStateChanged: !publishHeld,
      });
    } catch (err) {
      console.log(`  ${n} ${it.id} WRITE-FAIL ${err.message}`);
      report.push({
        account,
        id: it.id,
        name: detail.name,
        from: cur,
        status: "failed",
        error: err.message,
      });
    }
    await sleep(THROTTLE_MS);
  }
}

writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
writeFileSync(REPORT, JSON.stringify(report, null, 2));

const count = (s) => report.filter((r) => r.status === s).length;
console.log(`\n--- ${APPLY ? "APPLIED" : "DRY RUN"} ---`);
console.log(`total ${report.length}`);
for (const s of ["changed", "already", "would-change", "verify-mismatch", "failed", "read-failed"]) {
  if (count(s)) console.log(`${s}: ${count(s)}`);
}
const moved = report.filter((r) => r.publishStateChanged);
if (moved.length) console.log(`PUBLISH STATE CHANGED on: ${moved.map((r) => r.id).join(", ")}`);
console.log(`backup: ${BACKUP}`);
console.log(`report: ${REPORT}`);

// Non-zero exit if anything needs a human.
process.exit(count("failed") + count("read-failed") + count("verify-mismatch") > 0 ? 1 : 0);
