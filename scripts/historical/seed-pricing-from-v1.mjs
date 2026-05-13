/**
 * seed-pricing-from-v1.mjs
 *
 * Reads PRICING_CATALOG from v1's pricing-catalog.ts and upserts body-only rows
 * into v2's pricing_catalog table via `api.pricing_catalog.upsertPricingRow`
 * (public mutation, called via Convex HTTP API).
 * Auth: CONVEX_ACCESS_TOKEN (PAT) fetched from project-hub vault.
 *
 * Usage:
 *   node scripts/historical/seed-pricing-from-v1.mjs [--dry-run]
 *
 * Exit codes:
 *   0 = success
 *   1 = setup error
 *   3 = mutation error
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const V1_PRICING = '/home/ubuntu/rental-manager/src/data/pricing-catalog.ts';
const VAULT_URL  = 'https://fantastic-roadrunner-485.convex.cloud/api/query';
const CONVEX_URL = 'https://exciting-lion-29.convex.cloud';
const DRY_RUN    = process.argv.includes('--dry-run');

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

// ── Step 1: Fetch CONVEX_ACCESS_TOKEN (PAT) from vault ───────────────────────
log('[seed-pricing] Step 1: Fetching CONVEX_ACCESS_TOKEN from vault...');
let pat;
try {
  const vaultRes = JSON.parse(
    execSync(
      `curl -sS '${VAULT_URL}' -H 'Content-Type: application/json' ` +
        `-d '{"path":"secrets:listByService","args":{"service":"convex"},"format":"json"}'`,
      { encoding: 'utf8' }
    )
  );
  if (vaultRes.status !== 'success') {
    throw new Error(`Vault query failed: ${JSON.stringify(vaultRes)}`);
  }
  const rec = (vaultRes.value ?? []).find((r) => r.keyName === 'CONVEX_ACCESS_TOKEN');
  if (!rec) throw new Error('CONVEX_ACCESS_TOKEN not found in vault');
  pat = rec.value;
  log('[seed-pricing] PAT fetched (length=' + pat.length + ')');
} catch (e) {
  process.stderr.write('[seed-pricing] ERROR: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 2: Parse PRICING_CATALOG from v1 TS file ────────────────────────────
log('[seed-pricing] Step 2: Parsing PRICING_CATALOG from v1...');
const src = readFileSync(V1_PRICING, 'utf8');

const entries = [];
const lineRe = /\{\s*item_name:\s*'([^']+)',\s*category:\s*'([^']+)',\s*daily_price_min:\s*(\d+),\s*daily_price_max:\s*(\d+),\s*is_bundle:\s*(true|false)/g;
let m;
while ((m = lineRe.exec(src)) !== null) {
  const [, item_name, category, min, max, is_bundle_str] = m;
  if (is_bundle_str === 'true') continue; // skip bundles — they have their own table
  entries.push({
    item_name_canonical: item_name,
    category,
    daily_price_min: Number(min),
    daily_price_max: Number(max),
    is_bundle: false,
  });
}

log(`[seed-pricing] Parsed ${entries.length} body-only entries from v1`);
if (entries.length === 0) {
  process.stderr.write('[seed-pricing] ERROR: no entries parsed — check regex vs file format\n');
  process.exit(1);
}

// ── Step 3: Dry-run ───────────────────────────────────────────────────────────
if (DRY_RUN) {
  log('[seed-pricing] DRY-RUN — not sending. Sample (first 5):');
  for (const e of entries.slice(0, 5)) {
    log('  ', JSON.stringify(e));
  }
  console.log(`DRY_RUN: ${entries.length} entries would be upserted`);
  console.log('SAMPLE_5:');
  for (const e of entries.slice(0, 5)) {
    console.log(`  ${e.item_name_canonical}  min=${e.daily_price_min}  max=${e.daily_price_max}  cat=${e.category}`);
  }
  process.exit(0);
}

// ── Step 4: Upsert each entry via HTTP mutation ───────────────────────────────
log('[seed-pricing] Step 4: Upserting entries via Convex HTTP API...');

let upserted = 0;
let errors = 0;

for (const entry of entries) {
  const body = JSON.stringify({
    path: 'pricing_catalog:upsertPricingRow',
    args: {
      item_name_canonical: entry.item_name_canonical,
      daily_price_min: entry.daily_price_min,
      daily_price_max: entry.daily_price_max,
      is_bundle: false,
      category: entry.category,
    },
    format: 'json',
  });

  try {
    const raw = execSync(
      `curl -sS -X POST '${CONVEX_URL}/api/mutation' ` +
        `-H 'Content-Type: application/json' ` +
        `-H 'Authorization: Convex ${pat}' ` +
        `-d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8' }
    );
    const res = JSON.parse(raw);
    if (res.status !== 'success') {
      process.stderr.write(`[seed-pricing] WARN upsert failed for "${entry.item_name_canonical}": ${raw.trim()}\n`);
      errors++;
    } else {
      upserted++;
      log(`[seed-pricing]   ${res.value?.action ?? 'ok'}: ${entry.item_name_canonical}`);
    }
  } catch (e) {
    process.stderr.write(`[seed-pricing] ERROR for "${entry.item_name_canonical}": ${e.message}\n`);
    errors++;
  }
}

console.log(`Upserted ${upserted} / ${entries.length} pricing rows. Errors: ${errors}`);
if (errors > 0) process.exit(3);
