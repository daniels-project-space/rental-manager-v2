/**
 * seed-items-from-v1-master-inventory.mjs
 *
 * Reads MASTER_INVENTORY from v1's item-matcher.ts and seeds v2's items table
 * via `npx convex run --prod seed/inventory:seedItems` (internalMutation).
 * Auth: CONVEX_ACCESS_TOKEN (PAT) fetched from project-hub vault.
 *
 * Usage:
 *   node scripts/historical/seed-items-from-v1-master-inventory.mjs [--dry-run]
 *
 * Exit codes:
 *   0 = success (or already seeded)
 *   1 = setup error
 *   2 = table already non-empty (mutation refused) — Daniel must decide
 *   3 = mutation error
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const V1_ITEM_MATCHER = '/home/ubuntu/rental-manager/src/utils/item-matcher.ts';
const VAULT_URL = 'https://fantastic-roadrunner-485.convex.cloud/api/query';
const V2_DIR = '/home/ubuntu/rental-manager-v2';
const DRY_RUN = process.argv.includes('--dry-run');

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

// ── Step 1: Fetch CONVEX_ACCESS_TOKEN (PAT) from vault ───────────────────
log('[seed-items] Step 1: Fetching CONVEX_ACCESS_TOKEN from vault...');
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
  log('[seed-items] PAT fetched (length=' + pat.length + ')');
} catch (e) {
  process.stderr.write('[seed-items] ERROR: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 2: Parse MASTER_INVENTORY from v1 TS file ───────────────────────
log('[seed-items] Step 2: Parsing MASTER_INVENTORY from v1...');
const src = readFileSync(V1_ITEM_MATCHER, 'utf8');

// Extract the literal object body between the first { after MASTER_INVENTORY: Record
const startMarker = 'MASTER_INVENTORY: Record<string, number> = {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  process.stderr.write('[seed-items] ERROR: MASTER_INVENTORY not found in ' + V1_ITEM_MATCHER + '\n');
  process.exit(1);
}

// Find the matching closing brace
let depth = 0;
let bodyStart = src.indexOf('{', startIdx + startMarker.length - 1);
let bodyEnd = bodyStart;
for (let i = bodyStart; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') {
    depth--;
    if (depth === 0) { bodyEnd = i; break; }
  }
}

const body = src.slice(bodyStart + 1, bodyEnd);

// Parse lines like: 'item name': qty, (with optional // comment)
const inventory = [];
const lineRe = /^\s*'([^']+)'\s*:\s*(\d+)\s*,?/;
for (const line of body.split('\n')) {
  const m = lineRe.exec(line);
  if (m) {
    inventory.push({ name: m[1], qty: parseInt(m[2], 10) });
  }
}

log(`[seed-items] Parsed ${inventory.length} items from MASTER_INVENTORY`);
if (inventory.length !== 71) {
  process.stderr.write(`[seed-items] WARNING: expected 71 items, got ${inventory.length}\n`);
}

// ── Step 3: Build seed payload ────────────────────────────────────────────
log('[seed-items] Step 3: Building seed payload...');

/**
 * Infer kind/sub_kind/unit_kind from item name.
 * These are best-effort; all optional fields are omitted (undefined → not sent).
 */
function inferMeta(name) {
  const n = name.toLowerCase();

  // kind
  // Order matters — narrower / higher-specificity regexes first.
  // 1) cage/rig BEFORE camera_body to keep SmallRig FX3 cage from matching `fx3`.
  // 2) smoke/hazer BEFORE monitor to keep "Smoke Ninja" out of monitor (matches `ninja`).
  // 3) lens regex uses `mm\s+f\d` (digit after f) — old `mm f` failed for "mm f2.8".
  let kind = 'accessory';
  if (/\b(cage|smallrig|shoulder\s*rig|camera\s*cage)\b/.test(n)) kind = 'support';
  else if (/\b(smoke|hazer|fogger|smoke\s*ninja)\b/.test(n)) kind = 'effects';
  else if (/\b(fx3|a7|bmpcc|fuji|x100|camera body)\b/.test(n)) kind = 'camera_body';
  else if (/(\blens\b|\d+(?:-\d+)?mm(?:\s+f\d|\b)|\bfisheye\b|\banamorphic\b)/.test(n)) kind = 'lens';
  else if (/\b(light|softbox|reflector|nanlite|ambitful|led|flash)\b/.test(n)) kind = 'lighting';
  else if (/\b(battery|batteries|v-mount|np-f|np-fz|anker|power station|gimbal battery)\b/.test(n)) kind = 'power';
  else if (/\b(gimbal|slider|tripod|c-stand|monopod|follow focus|tilta)\b/.test(n)) kind = 'support';
  else if (/\b(monitor|atomos|ninja|hollyland|transmitter)\b/.test(n)) kind = 'monitor';
  else if (/\b(mic|microphone|rode|sennheiser|audio|boom|dji mic|dji wireless)\b/.test(n)) kind = 'audio';
  else if (/\b(drone|mavic|mini 4|action|osmo|gopro)\b/.test(n)) kind = 'action_cam';
  else if (/\b(dj|controller|speaker|jbl|partybox)\b/.test(n)) kind = 'av';
  else if (/\b(filter|nd filter|cinebloom|mist)\b/.test(n)) kind = 'filter';
  else if (/\b(card|256gb|cf express)\b/.test(n)) kind = 'media';
  else if (/\b(mount|adapter|pl to)\b/.test(n)) kind = 'adapter';
  else if (/\b(suction|cups)\b/.test(n)) kind = 'mount';

  const unit_kind = 'unit';

  return { kind, unit_kind };
}

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const items = inventory.map(({ name, qty }) => {
  const { kind, unit_kind } = inferMeta(name);
  return {
    name_canonical: name,
    name_input: name,
    slug: toSlug(name),
    kind,
    qty,
    unit_kind,
    is_marketing_only: false,
    status: 'active',
  };
});

if (DRY_RUN) {
  log('[seed-items] DRY-RUN — payload built, not sending. Sample:');
  log(JSON.stringify(items.slice(0, 3), null, 2));
  console.log(`DRY_RUN: would seed ${items.length} items`);
  process.exit(0);
}

// ── Step 4: Call seedItems via `npx convex run --prod` ───────────────────
// Args must be passed as a positional JSON string (not stdin).
// Large payload: write to tmp file and read back to avoid shell quoting issues.
log('[seed-items] Step 4: Running convex run --prod seed/inventory:seedItems...');

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argsFile = join(tmpdir(), 'seed-items-args.json');
writeFileSync(argsFile, JSON.stringify({ items }), 'utf8');

let rawOut;
try {
  // Use shell to expand $(cat ...) into the positional args string
  rawOut = execSync(
    `CONVEX_OVERRIDE_ACCESS_TOKEN='${pat}' npx convex run seed/inventory:seedItems --prod --no-push "$(cat ${argsFile})"`,
    {
      cwd: V2_DIR,
      encoding: 'utf8',
      shell: '/bin/bash',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    }
  );
} catch (e) {
  process.stderr.write('[seed-items] RUN ERROR: ' + (e.stderr ?? e.message) + '\n');
  process.exit(3);
}

log('[seed-items] Raw output: ' + rawOut.trim());

// Extract the last JSON object from output (may span multiple lines)
let val;
try {
  const jsonMatch = rawOut.match(/\{[\s\S]*\}(?=[^}]*$)/);
  val = JSON.parse(jsonMatch ? jsonMatch[0] : rawOut.trim());
} catch {
  process.stderr.write('[seed-items] Could not parse result: ' + rawOut.trim() + '\n');
  process.exit(3);
}

log('[seed-items] Result: ' + JSON.stringify(val));

if (val.skipped) {
  process.stderr.write(`[seed-items] REFUSED: table already has ${val.count} rows. Exit 2.\n`);
  console.log(`SEED_REFUSED: items table already has ${val.count} rows. Daniel must clear+reseed or add upsert path.`);
  process.exit(2);
}

console.log(`Seeded ${val.count} items (target: 71)`);
log(`[seed-items] Done. count=${val.count}`);
