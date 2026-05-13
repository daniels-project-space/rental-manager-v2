/**
 * backfill-item-images.mjs
 *
 * One-shot backfill: populate items.image_url from reservations.photos_urls.
 * First-write-wins: once an item gets an image_url, it is skipped.
 * Match logic: 3-tier fuzzy resolver (exact canonical → exact alias → substring).
 * Filters reservation photos for /products/ URLs (Hygglo CDN product images).
 *
 * Usage:
 *   node scripts/historical/backfill-item-images.mjs [--dry-run]
 *
 * Exit codes:
 *   0 = success
 *   1 = setup error
 *   3 = mutation error
 */

import { execSync } from 'node:child_process';

const VAULT_URL = 'https://fantastic-roadrunner-485.convex.cloud/api/query';
const CONVEX_URL = 'https://hearty-oyster-600.convex.cloud';
const V2_DIR = '/home/ubuntu/rental-manager-v2';
const DRY_RUN = process.argv.includes('--dry-run');
const ACCOUNT_SLUGS = ['dbcinema', 'leo'];

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
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
  if (vaultRes.status !== 'success') {
    throw new Error(`Vault query failed: ${JSON.stringify(vaultRes)}`);
  }
  const rec = (vaultRes.value ?? []).find((r) => r.keyName === 'CONVEX_ACCESS_TOKEN');
  if (!rec) throw new Error('CONVEX_ACCESS_TOKEN not found in vault');
  pat = rec.value;
  log('[backfill-images] PAT fetched (length=' + pat.length + ')');
} catch (e) {
  process.stderr.write('[backfill-images] ERROR: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 2: Fetch items without image_url ────────────────────────────────────
log('[backfill-images] Step 2: Fetching items...');
let allItems;
try {
  const res = JSON.parse(
    execSync(
      `curl -sS '${CONVEX_URL}/api/query' -H 'Content-Type: application/json' ` +
        `-d '{"path":"items:listForReconcile","args":{}}'`,
      { encoding: 'utf8' }
    )
  );
  if (res.status !== 'success') throw new Error(`items query failed: ${JSON.stringify(res)}`);
  allItems = res.value;
  log(`[backfill-images] Fetched ${allItems.length} items total`);
} catch (e) {
  process.stderr.write('[backfill-images] ERROR fetching items: ' + e.message + '\n');
  process.exit(1);
}

const itemsWithout = allItems.filter((i) => !i.image_url);
log(`[backfill-images] Items without image_url: ${itemsWithout.length}`);

if (itemsWithout.length === 0) {
  console.log('All items already have image_url. Nothing to do.');
  process.exit(0);
}

// ── Step 3: Fetch reservations from both accounts ────────────────────────────
log('[backfill-images] Step 3: Fetching reservations from both accounts...');
let allReservations = [];
for (const slug of ACCOUNT_SLUGS) {
  try {
    const res = JSON.parse(
      execSync(
        `curl -sS '${CONVEX_URL}/api/query' -H 'Content-Type: application/json' ` +
          `-d '{"path":"reservations:listForReconcile","args":{"account_slug":"${slug}"}}'`,
        { encoding: 'utf8' }
      )
    );
    if (res.status !== 'success') {
      log(`[backfill-images] WARNING: reservations query failed for ${slug}: ${JSON.stringify(res)}`);
      continue;
    }
    log(`[backfill-images]   ${slug}: ${res.value.length} reservations`);
    allReservations = allReservations.concat(res.value);
  } catch (e) {
    process.stderr.write(`[backfill-images] ERROR fetching reservations for ${slug}: ` + e.message + '\n');
  }
}
log(`[backfill-images] Total reservations: ${allReservations.length}`);

// Filter to reservations that have photos_urls with at least one /products/ URL
const resWithPhotos = allReservations.filter(
  (r) => Array.isArray(r.photos_urls) && r.photos_urls.some((u) => u.includes('/products/'))
);
log(`[backfill-images] Reservations with /products/ photos: ${resWithPhotos.length}`);

// ── Step 4: 3-tier fuzzy matcher ─────────────────────────────────────────────
function norm(s) {
  return (s ?? '').toLowerCase().trim();
}

/**
 * 3-tier resolver (mirrors convex/calendar.ts findItemByName):
 *   Tier 1: exact canonical match
 *   Tier 2: exact alias match
 *   Tier 3: substring match (min 5 chars)
 */
function fuzzyMatchesItem(item, itemName) {
  const lower = norm(itemName);
  const canonical = norm(item.name_canonical);
  const aliases = (item.aliases ?? []).map(norm);

  // Tier 1: exact canonical
  if (canonical === lower) return true;

  // Tier 2: exact alias
  if (aliases.some((a) => a === lower)) return true;

  // Tier 3: substring (only when name is reasonably long)
  if (lower.length >= 5) {
    if (lower.includes(canonical) || canonical.includes(lower)) return true;
    if (aliases.some((a) => a.length >= 5 && (lower.includes(a) || a.includes(lower)))) return true;
  }

  return false;
}

function pickProductUrl(photos_urls) {
  return photos_urls.find((u) => u.includes('/products/')) ?? null;
}

// ── Step 5: Match items to reservation photos ────────────────────────────────
log('[backfill-images] Step 4: Matching items to reservation photos...');
const matches = []; // { item, url, account_slug, reservation_id }
const unmatched = [];

for (const item of itemsWithout) {
  let found = false;
  outer: for (const res of resWithPhotos) {
    const resItems = res.items ?? [];
    for (const ri of resItems) {
      if (fuzzyMatchesItem(item, ri.item_name)) {
        const url = pickProductUrl(res.photos_urls);
        if (url) {
          matches.push({
            item,
            item_name: ri.item_name,
            url,
            account_slug: res.account_slug ?? res.accountSlug,
            reservation_id: res._id,
          });
          found = true;
          break outer;
        }
      }
    }
  }
  if (!found) unmatched.push(item.name_canonical);
}

log(`[backfill-images] Matched: ${matches.length}, Unmatched: ${unmatched.length}`);

if (DRY_RUN) {
  console.log(`\nDRY_RUN RESULTS:`);
  console.log(`  Items without image: ${itemsWithout.length}`);
  console.log(`  Predicted matches:   ${matches.length}`);
  console.log(`  Unmatched:           ${unmatched.length}`);
  console.log(`\nTop-5 expected URL assignments:`);
  for (const m of matches.slice(0, 5)) {
    console.log(`  [${m.item.name_canonical}]`);
    console.log(`    matched via: "${m.item_name}"`);
    console.log(`    url: ${m.url.substring(0, 100)}`);
  }
  console.log(`\nTop-5 unmatched items:`);
  for (const name of unmatched.slice(0, 5)) {
    console.log(`  - ${name}`);
  }
  process.exit(0);
}

// ── Step 6: Apply mutations ──────────────────────────────────────────────────
log('[backfill-images] Step 5: Applying populateImageFromReservation mutations...');
let patched = 0;
let errors = [];

for (const m of matches) {
  const payload = JSON.stringify({
    path: 'items:populateImageFromReservation',
    args: {
      item_name: m.item_name,
      photos_urls: [m.url],
      account_slug: m.account_slug,
    },
    format: 'json',
  });

  try {
    const raw = execSync(
      `CONVEX_OVERRIDE_ACCESS_TOKEN='${pat}' npx convex run items:populateImageFromReservation --prod --no-push ` +
        `'${JSON.stringify({ item_name: m.item_name, photos_urls: [m.url], account_slug: m.account_slug })}'`,
      {
        cwd: V2_DIR,
        encoding: 'utf8',
        shell: '/bin/bash',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    // Parse result
    let result;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}(?=[^}]*$)/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : raw.trim());
    } catch {
      result = { raw: raw.trim() };
    }

    if (result.set || result.skipped_already_set) {
      patched++;
      log(`[backfill-images] ✓ ${m.item.name_canonical} → ${m.url.substring(0, 70)}...`);
    } else if (result.found === false) {
      log(`[backfill-images] ✗ NOT FOUND in convex: "${m.item_name}" (canonical: ${m.item.name_canonical})`);
      errors.push({ item: m.item.name_canonical, error: 'not_found_in_mutation' });
    } else {
      log(`[backfill-images] ? Unexpected result for ${m.item.name_canonical}: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    const errMsg = (e.stderr ?? e.message ?? '').substring(0, 200);
    log(`[backfill-images] ERROR for ${m.item.name_canonical}: ${errMsg}`);
    errors.push({ item: m.item.name_canonical, error: errMsg });
  }
}

// ── Step 7: Final report ─────────────────────────────────────────────────────
console.log(`\nLIVE RUN RESULTS:`);
console.log(`  Total items without image:  ${itemsWithout.length}`);
console.log(`  Matched (attempted):        ${matches.length}`);
console.log(`  Patched successfully:       ${patched}`);
console.log(`  Errors:                     ${errors.length}`);
if (errors.length > 0) {
  for (const e of errors) {
    console.log(`    - ${e.item}: ${e.error}`);
  }
}
console.log(`\nUnmatched items (${unmatched.length}):`);
for (const name of unmatched) {
  console.log(`  - ${name}`);
}

log('[backfill-images] Done.');
