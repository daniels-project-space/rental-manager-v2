/**
 * backfill-item-images.mjs
 *
 * One-shot backfill: populate items.image_url from v1 Postgres rental.photos_urls.
 * First-write-wins: once an item gets an image_url, it is skipped.
 * Match logic: 3-tier fuzzy resolver (exact canonical → exact alias → substring).
 * Filters reservation photos for /products/ URLs (Hygglo CDN product images).
 *
 * Data flow:
 *   v1 Postgres: JOIN extracteditem + rental → (item_name, photos_urls[])
 *   v2 Convex items:listForReconcile → { _id, name (=canonical), aliases }
 *   Match → items:populateImageFromReservation mutation per hit
 *
 * Usage:
 *   node scripts/historical/backfill-item-images.mjs [--dry-run]
 */

import { execSync } from 'node:child_process';

const VAULT_URL = 'https://fantastic-roadrunner-485.convex.cloud/api/query';
const CONVEX_URL = 'https://hearty-oyster-600.convex.cloud';
const V1_DIR = '/home/ubuntu/rental-manager';
const V2_DIR = '/home/ubuntu/rental-manager-v2';
const DRY_RUN = process.argv.includes('--dry-run');

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Load DATABASE_URL from v1 .env */
function loadDbUrl() {
  const raw = execSync(`grep '^DATABASE_URL=' ${V1_DIR}/.env`, { encoding: 'utf8' }).trim();
  return raw.replace(/^DATABASE_URL=/, '');
}

/**
 * Run SQL via psql stdin; return rows as string[][] (pipe-delimited).
 * Pattern from import-v1-item-aliases.mjs.
 */
function psql(sql, dbUrl) {
  const stdout = execSync('psql "$DATABASE_URL" -t -A -F "|"', {
    encoding: 'utf8',
    shell: '/bin/bash',
    env: { ...process.env, DATABASE_URL: dbUrl },
    input: sql,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split('|'));
}

/**
 * Parse a Postgres array literal: {val1,val2,...}
 * Handles quoted elements and URL-embedded commas safely by splitting on ","
 * only at positions not inside quotes.
 */
function parsePgArray(pgArr) {
  if (!pgArr || pgArr === '{}') return [];
  // Strip outer braces
  const inner = pgArr.replace(/^\{/, '').replace(/\}$/, '');
  // Split on commas not inside double-quotes
  const result = [];
  let buf = '';
  let inQuote = false;
  for (const ch of inner) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf) result.push(buf);
  return result;
}

function norm(s) {
  return (s ?? '').toLowerCase().trim();
}

/**
 * 3-tier fuzzy resolver (mirrors convex/calendar.ts findItemByName).
 * item has { _id, name (=canonical), aliases }
 */
function fuzzyMatchesItem(item, itemName) {
  const lower = norm(itemName);
  const canonical = norm(item.name);
  const aliases = (item.aliases ?? []).map(norm);

  if (canonical === lower) return true;
  if (aliases.some((a) => a === lower)) return true;
  if (lower.length >= 5) {
    if (lower.includes(canonical) || canonical.includes(lower)) return true;
    if (aliases.some((a) => a.length >= 5 && (lower.includes(a) || a.includes(lower)))) return true;
  }
  return false;
}

// ── Step 1: Fetch PAT from vault ─────────────────────────────────────────────
log('[backfill-images] Step 1: Fetching CONVEX_ACCESS_TOKEN from vault...');
let pat;
try {
  const vaultRes = JSON.parse(
    execSync(
      `curl -sS '${VAULT_URL}' -H 'Content-Type: application/json' ` +
        `-d '{"path":"secrets:listByService","args":{"service":"convex"},"format":"json"}'`,
      { encoding: 'utf8' }
    )
  );
  if (vaultRes.status !== 'success') throw new Error(`Vault query failed: ${JSON.stringify(vaultRes)}`);
  const rec = (vaultRes.value ?? []).find((r) => r.keyName === 'CONVEX_ACCESS_TOKEN');
  if (!rec) throw new Error('CONVEX_ACCESS_TOKEN not found in vault');
  pat = rec.value;
  log('[backfill-images] PAT fetched (length=' + pat.length + ')');
} catch (e) {
  process.stderr.write('[backfill-images] ERROR: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 2: Fetch v2 items ───────────────────────────────────────────────────
// listForReconcile returns { _id, name (=name_canonical), aliases, qty }
// listActive includes image_url field for filtering already-populated items
log('[backfill-images] Step 2: Fetching v2 items...');
let allItems;
let itemsWithImage = new Set();
try {
  const reconcileRes = JSON.parse(
    execSync(
      `curl -sS '${CONVEX_URL}/api/query' -H 'Content-Type: application/json' ` +
        `-d '{"path":"items:listForReconcile","args":{}}'`,
      { encoding: 'utf8' }
    )
  );
  if (reconcileRes.status !== 'success') throw new Error(`listForReconcile failed: ${JSON.stringify(reconcileRes)}`);
  allItems = reconcileRes.value;

  // Also fetch listActive to know which already have image_url
  const activeRes = JSON.parse(
    execSync(
      `curl -sS '${CONVEX_URL}/api/query' -H 'Content-Type: application/json' ` +
        `-d '{"path":"items:listActive","args":{}}'`,
      { encoding: 'utf8' }
    )
  );
  if (activeRes.status === 'success') {
    for (const i of activeRes.value) {
      if (i.image_url) itemsWithImage.add(i._id);
    }
  }

  log(`[backfill-images] Total items: ${allItems.length}, already have image_url: ${itemsWithImage.size}`);
} catch (e) {
  process.stderr.write('[backfill-images] ERROR fetching items: ' + e.message + '\n');
  process.exit(1);
}

const itemsWithout = allItems.filter((i) => !itemsWithImage.has(i._id));
log(`[backfill-images] Items without image_url: ${itemsWithout.length}`);

if (itemsWithout.length === 0) {
  console.log('All items already have image_url. Nothing to do.');
  process.exit(0);
}

// ── Step 3: Load v1 DATABASE_URL ─────────────────────────────────────────────
log('[backfill-images] Step 3: Loading v1 DATABASE_URL...');
let dbUrl;
try {
  dbUrl = loadDbUrl();
  log('[backfill-images] DATABASE_URL loaded');
} catch (e) {
  process.stderr.write('[backfill-images] ERROR: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 4: Query v1 Postgres ────────────────────────────────────────────────
// Get (item_name, photos_urls) pairs where at least one URL contains /products/
// photos_urls is returned as Postgres array literal: {url1,url2,...}
log('[backfill-images] Step 4: Querying v1 Postgres for reservation photos...');
let psqlRows;
try {
  const rows = psql(
    `SELECT ei.item_name, r.photos_urls::text
     FROM extracteditem ei
     JOIN rental r ON ei.rental_id = r.id
     WHERE r.photos_urls IS NOT NULL
       AND array_length(r.photos_urls, 1) > 0
       AND EXISTS (
         SELECT 1 FROM unnest(r.photos_urls) AS u WHERE u LIKE '%/products/%'
       )
     ORDER BY r.created_at DESC;`,
    dbUrl
  );
  // rows = [[item_name, "{url1,url2,...}"], ...]
  psqlRows = rows
    .filter((r) => r.length >= 2)
    .map((r) => ({
      item_name: r[0],
      photos_urls: parsePgArray(r[1]),
    }))
    .filter((r) => r.item_name && r.photos_urls.length > 0);

  log(`[backfill-images] v1 rows with /products/ photos: ${psqlRows.length}`);
} catch (e) {
  process.stderr.write('[backfill-images] ERROR querying v1 Postgres: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 5: Match items → photos ─────────────────────────────────────────────
log('[backfill-images] Step 5: Matching items to reservation photos...');
const matches = [];
const unmatched = [];

for (const item of itemsWithout) {
  let found = false;
  for (const row of psqlRows) {
    if (fuzzyMatchesItem(item, row.item_name)) {
      const url = row.photos_urls.find((u) => u.includes('/products/')) ?? null;
      if (url) {
        matches.push({ item, matched_via: row.item_name, url });
        found = true;
        break; // first-write-wins
      }
    }
  }
  if (!found) unmatched.push(item.name);
}

log(`[backfill-images] Matched: ${matches.length}, Unmatched: ${unmatched.length}`);

if (DRY_RUN) {
  console.log(`\nDRY_RUN RESULTS:`);
  console.log(`  Items without image: ${itemsWithout.length}`);
  console.log(`  Predicted matches:   ${matches.length}`);
  console.log(`  Unmatched:           ${unmatched.length}`);
  console.log(`\nTop-5 expected URL assignments:`);
  for (const m of matches.slice(0, 5)) {
    console.log(`  [${m.item.name}]`);
    console.log(`    matched via: "${m.matched_via}"`);
    console.log(`    url: ${m.url.substring(0, 100)}`);
  }
  if (unmatched.length > 0) {
    console.log(`\nTop-5 unmatched items:`);
    for (const name of unmatched.slice(0, 5)) console.log(`  - ${name}`);
  }
  process.exit(0);
}

// ── Step 6: Apply mutations ──────────────────────────────────────────────────
log('[backfill-images] Step 6: Applying populateImageFromReservation mutations...');
let patched = 0;
const errors = [];

for (const m of matches) {
  // Use HTTP mutation API directly — avoids npx/cwd issues and --prod flag confusion.
  // Pass item.name (canonical from Convex) so the exact-match in the mutation always hits.
  const body = JSON.stringify({
    path: 'items:populateImageFromReservation',
    args: { item_name: m.item.name, photos_urls: [m.url] },
    format: 'json',
  });

  try {
    const raw = execSync(
      `curl -sS '${CONVEX_URL}/api/mutation' -H 'Content-Type: application/json' -H 'Authorization: Convex ${pat}' -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf8', shell: '/bin/bash', maxBuffer: 2 * 1024 * 1024 }
    );

    let result;
    try {
      const parsed = JSON.parse(raw);
      result = parsed.value ?? parsed;
    } catch {
      result = { raw: raw.trim() };
    }

    if (result.set) {
      patched++;
      log(`[backfill-images] SET  ${m.item.name}`);
    } else if (result.skipped_already_set) {
      log(`[backfill-images] SKIP ${m.item.name} (already set)`);
    } else if (result.found === false) {
      log(`[backfill-images] MISS ${m.item.name} — not found in mutation`);
      errors.push({ item: m.item.name, error: 'not_found_in_mutation' });
    } else {
      log(`[backfill-images] ?    ${m.item.name}: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    const errMsg = ((e.stderr ?? '') + (e.message ?? '')).substring(0, 200);
    log(`[backfill-images] ERR  ${m.item.name}: ${errMsg}`);
    errors.push({ item: m.item.name, error: errMsg });
  }
}

// ── Step 7: Report ───────────────────────────────────────────────────────────
console.log(`\nLIVE RUN RESULTS:`);
console.log(`  Total items without image:  ${itemsWithout.length}`);
console.log(`  Matched (attempted):        ${matches.length}`);
console.log(`  Patched successfully:       ${patched}`);
console.log(`  Errors:                     ${errors.length}`);
if (errors.length > 0) {
  for (const e of errors) console.log(`    - ${e.item}: ${e.error}`);
}
console.log(`\nUnmatched items (${unmatched.length}):`);
for (const name of unmatched) console.log(`  - ${name}`);
log('[backfill-images] Done.');
