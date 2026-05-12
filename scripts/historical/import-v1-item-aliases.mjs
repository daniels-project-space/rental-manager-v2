/**
 * import-v1-item-aliases.mjs
 *
 * Imports v1's AI-extracted item names into v2's items.aliases[] column.
 *
 * V1 source:
 *   - `extracteditem` table: raw AI-extracted item names per rental (item_name, rental_id)
 *   - `booking` table: canonical item names (already fuzzy-matched to MASTER_INVENTORY)
 *   Strategy: group extracteditem.item_name values that appear alongside a canonical
 *   booking.item_name in the same rental → those become aliases for that canonical.
 *   Also treat each distinct booking.item_name as a self-alias (captures alternate
 *   long-form Hygglo listing titles).
 *
 * V2 target:
 *   - Convex prod: https://exciting-lion-29.convex.cloud
 *   - Query:  items:listForReconcile  → [{_id, name, aliases, account_slug, qty}]
 *   - Mutation: items:upsertAliases({ item_id, aliases })
 *
 * Usage:
 *   node scripts/historical/import-v1-item-aliases.mjs [--dry-run] [--limit N]
 *
 * Exit codes:
 *   0 = success
 *   1 = DB connection failed
 *   2 = no items returned from Convex
 *   3 = at least one mutation failed
 */

import { execSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// ─── Config ────────────────────────────────────────────────────────────────
const CONVEX_URL = 'https://exciting-lion-29.convex.cloud';
const V1_DIR = '/home/ubuntu/rental-manager';
const REPORT_PATH = '/tmp/import-v1-aliases-report.md';

// ─── Arg parsing ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

// ─── Helpers ───────────────────────────────────────────────────────────────

function log(...msg) {
  process.stderr.write(msg.join(' ') + '\n');
}

/**
 * Run a psql query against v1 DB.
 * Returns rows as arrays (pipe-delimited), stripped of empty lines.
 * @param {string} sql
 * @returns {string[][]}
 */
function psql(sql) {
  // Load DATABASE_URL from v1 .env
  let dbUrl;
  try {
    const envRaw = execSync(`grep '^DATABASE_URL=' ${V1_DIR}/.env`, { encoding: 'utf8' }).trim();
    dbUrl = envRaw.replace(/^DATABASE_URL=/, '');
  } catch (e) {
    throw new Error(`Could not read DATABASE_URL from ${V1_DIR}/.env: ${e.message}`);
  }

  // Pass DATABASE_URL via env; pipe SQL via stdin to avoid all shell-quoting issues.
  let stdout;
  try {
    stdout = execSync(
      'psql "$DATABASE_URL" -t -A -F "|"',
      {
        encoding: 'utf8',
        shell: '/bin/bash',
        env: { ...process.env, DATABASE_URL: dbUrl },
        input: sql,
        maxBuffer: 50 * 1024 * 1024, // 50 MB
      }
    );
  } catch (e) {
    throw new Error(`psql failed: ${e.stderr ?? e.message}`);
  }

  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l.split('|'));
}

/** Levenshtein distance (simple, for short strings) */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalise for matching: lowercase, strip non-alphanumeric */
function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find best v2 item match for a v1 canonical name.
 * Returns { item, distance } or null if no reasonable match.
 */
function findBestMatch(v1Name, v2Items) {
  const v1Norm = norm(v1Name);
  let best = null;
  let bestDist = Infinity;

  for (const item of v2Items) {
    const v2Norm = norm(item.name);
    // Exact normalised match
    if (v1Norm === v2Norm) return { item, distance: 0 };
    // Contains match (one contains the other)
    if (v1Norm.includes(v2Norm) || v2Norm.includes(v1Norm)) {
      const dist = Math.abs(v1Norm.length - v2Norm.length);
      if (dist < bestDist) { bestDist = dist; best = item; }
      continue;
    }
    // Levenshtein — only consider if both strings share enough prefix
    const prefixLen = Math.min(6, Math.min(v1Norm.length, v2Norm.length));
    if (v1Norm.slice(0, prefixLen) === v2Norm.slice(0, prefixLen)) {
      const dist = levenshtein(v1Norm, v2Norm);
      const maxLen = Math.max(v1Norm.length, v2Norm.length);
      // Accept if edit distance < 40% of length
      if (dist < maxLen * 0.4 && dist < bestDist) {
        bestDist = dist;
        best = item;
      }
    }
  }

  return best ? { item: best, distance: bestDist } : null;
}

/** POST to Convex HTTP API */
async function convexQuery(path, args = {}) {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`Query ${path} failed: ${JSON.stringify(data)}`);
  return data.value;
}

async function convexMutation(path, args = {}) {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`Mutation ${path} failed: ${JSON.stringify(data)}`);
  return data.value;
}

// ─── Main ──────────────────────────────────────────────────────────────────

log(`[aliases] Starting import-v1-item-aliases.mjs (dry-run=${DRY_RUN}, limit=${LIMIT ?? 'all'})`);

// ── Step 1: Pull v1 data ───────────────────────────────────────────────────
log('[aliases] Step 1: Connecting to v1 Postgres...');

let canonicalNames; // string[]
let rentalToCanonicals; // Map<rental_id, string[]>
let rentalToExtracted; // Map<rental_id, string[]>

try {
  // 1a. Distinct canonical item names from booking table
  log('[aliases]   Loading canonical names from booking...');
  const bookingRows = psql(
    "SELECT DISTINCT item_name FROM booking WHERE item_name IS NOT NULL AND item_name <> '' ORDER BY item_name"
  );
  canonicalNames = bookingRows.map(r => r[0]).filter(Boolean);
  log(`[aliases]   ${canonicalNames.length} distinct canonical names in booking.`);

  // 1b. Build rental_id → canonical names mapping
  log('[aliases]   Building rental→canonical map from booking...');
  const rentalBookingRows = psql(
    "SELECT rental_id, item_name FROM booking WHERE item_name IS NOT NULL AND item_name <> '' AND rental_id IS NOT NULL"
  );
  rentalToCanonicals = new Map();
  for (const [rental_id, item_name] of rentalBookingRows) {
    if (!rentalToCanonicals.has(rental_id)) rentalToCanonicals.set(rental_id, new Set());
    rentalToCanonicals.get(rental_id).add(item_name);
  }
  log(`[aliases]   ${rentalToCanonicals.size} rentals with canonical bookings.`);

  // 1c. Build rental_id → extracted names mapping
  log('[aliases]   Loading extracteditem...');
  const extractedRows = psql(
    "SELECT rental_id, item_name FROM extracteditem WHERE item_name IS NOT NULL AND item_name <> '' AND rental_id IS NOT NULL"
  );
  rentalToExtracted = new Map();
  for (const [rental_id, item_name] of extractedRows) {
    if (!rentalToExtracted.has(rental_id)) rentalToExtracted.set(rental_id, new Set());
    rentalToExtracted.get(rental_id).add(item_name);
  }
  log(`[aliases]   ${rentalToExtracted.size} rentals with extracted items.`);

} catch (err) {
  log(`[aliases] ERROR: DB connection/query failed: ${err.message}`);
  process.exit(1);
}

// ── Step 2: Build canonical → alias set mapping ────────────────────────────
log('[aliases] Step 2: Building canonical→alias map...');

// For each rental that has both booking (canonical) and extracteditem rows,
// assign extracted names to their canonical counterpart.
// Strategy: if a rental has exactly 1 canonical, all its extracted names → that canonical.
// If multiple canonicals, match extracted name to the closest canonical.

const canonicalAliasMap = new Map(); // canonical_name → Set<alias>
// Initialise with canonical names themselves as aliases
for (const cn of canonicalNames) {
  canonicalAliasMap.set(cn, new Set([cn]));
}

let multiCanonicalRentals = 0;
let singleCanonicalRentals = 0;

for (const [rental_id, extractedSet] of rentalToExtracted) {
  const canonicalsForRental = rentalToCanonicals.get(rental_id);
  if (!canonicalsForRental || canonicalsForRental.size === 0) continue;

  if (canonicalsForRental.size === 1) {
    singleCanonicalRentals++;
    const canonical = [...canonicalsForRental][0];
    if (!canonicalAliasMap.has(canonical)) canonicalAliasMap.set(canonical, new Set([canonical]));
    for (const extracted of extractedSet) {
      canonicalAliasMap.get(canonical).add(extracted);
    }
  } else {
    multiCanonicalRentals++;
    // Multiple canonicals in this rental — assign each extracted name to closest canonical
    for (const extracted of extractedSet) {
      const extractedNorm = norm(extracted);
      let bestCanonical = null;
      let bestDist = Infinity;
      for (const cn of canonicalsForRental) {
        const cnNorm = norm(cn);
        if (extractedNorm === cnNorm) { bestCanonical = cn; bestDist = 0; break; }
        if (extractedNorm.includes(cnNorm) || cnNorm.includes(extractedNorm)) {
          const dist = Math.abs(extractedNorm.length - cnNorm.length);
          if (dist < bestDist) { bestDist = dist; bestCanonical = cn; }
          continue;
        }
        const dist = levenshtein(extractedNorm, cnNorm);
        if (dist < bestDist) { bestDist = dist; bestCanonical = cn; }
      }
      if (bestCanonical) {
        if (!canonicalAliasMap.has(bestCanonical)) canonicalAliasMap.set(bestCanonical, new Set([bestCanonical]));
        canonicalAliasMap.get(bestCanonical).add(extracted);
      }
    }
  }
}

log(`[aliases]   ${canonicalAliasMap.size} canonical items with alias sets.`);
log(`[aliases]   Single-canonical rentals: ${singleCanonicalRentals}, multi-canonical: ${multiCanonicalRentals}`);

// Convert to array, apply limit
let canonicals = [...canonicalAliasMap.entries()].map(([name, aliasSet]) => ({
  v1_canonical: name,
  aliases: [...aliasSet].sort(),
}));

if (LIMIT !== null && !isNaN(LIMIT)) {
  log(`[aliases]   Applying --limit ${LIMIT}`);
  canonicals = canonicals.slice(0, LIMIT);
}

// ── Step 3: Load v2 items ──────────────────────────────────────────────────
log('[aliases] Step 3: Loading v2 items from Convex...');

let v2Items; // [{_id, name, aliases, account_slug}]

// Try listForReconcile first (no status filter, includes aliases)
try {
  const rows = await convexQuery('items:listForReconcile', {});
  v2Items = rows;
  log(`[aliases]   items:listForReconcile returned ${v2Items.length} items.`);
} catch (err) {
  log(`[aliases]   items:listForReconcile failed (${err.message}), falling back to listActive...`);
  v2Items = null;
}

// Fallback: listActive
if (v2Items === null || v2Items.length === 0) {
  try {
    const activeItems = await convexQuery('items:listActive', {});
    v2Items = activeItems.map(i => ({ _id: i.id, name: i.name, aliases: [], account_slug: null }));
    log(`[aliases]   items:listActive returned ${v2Items.length} items.`);
  } catch (err) {
    log(`[aliases] ERROR: Both item queries failed. Last error: ${err.message}`);
    process.exit(2);
  }
}

if (v2Items.length === 0) {
  log('[aliases] WARNING: v2 items table is empty. All v1 canonicals will be unmatched.');
  log('[aliases]   This is expected if items have not been seeded into v2 yet.');
  log('[aliases]   Proceeding to generate report only.');
}

// ── Step 4: Match v1 → v2 ─────────────────────────────────────────────────
log('[aliases] Step 4: Matching v1 canonicals to v2 items...');

const matched = [];     // { v2_item_id, v1_canonical, v2_name, aliases, match_distance }
const unmatched = [];   // { v1_canonical, alias_count }
const multiMatch = [];  // { v1_canonical, candidates: [{name, distance}] }

for (const entry of canonicals) {
  const { v1_canonical, aliases } = entry;

  if (v2Items.length === 0) {
    unmatched.push({ v1_canonical, alias_count: aliases.length });
    continue;
  }

  // Find all candidates within threshold
  const v1Norm = norm(v1_canonical);
  const candidates = [];

  for (const item of v2Items) {
    const v2Norm = norm(item.name);
    if (v1Norm === v2Norm) {
      candidates.push({ item, distance: 0 });
      break;
    }
    if (v1Norm.includes(v2Norm) || v2Norm.includes(v1Norm)) {
      const dist = Math.abs(v1Norm.length - v2Norm.length);
      candidates.push({ item, distance: dist });
      continue;
    }
    const prefixLen = Math.min(6, Math.min(v1Norm.length, v2Norm.length));
    if (v1Norm.slice(0, prefixLen) === v2Norm.slice(0, prefixLen)) {
      const dist = levenshtein(v1Norm, v2Norm);
      const maxLen = Math.max(v1Norm.length, v2Norm.length);
      if (dist < maxLen * 0.4) candidates.push({ item, distance: dist });
    }
  }

  if (candidates.length === 0) {
    unmatched.push({ v1_canonical, alias_count: aliases.length });
  } else if (candidates.length === 1 || candidates[0].distance === 0) {
    // Sort by distance and take best
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    matched.push({
      v2_item_id: best.item._id,
      v1_canonical,
      v2_name: best.item.name,
      aliases,
      match_distance: best.distance,
    });
    // If >1 candidates with distance > 0, note as potential ambiguity
    if (candidates.length > 1 && best.distance > 0) {
      multiMatch.push({
        v1_canonical,
        chosen: best.item.name,
        candidates: candidates.slice(0, 5).map(c => ({ name: c.item.name, distance: c.distance })),
      });
    }
  } else {
    // Multiple equal-distance matches
    candidates.sort((a, b) => a.distance - b.distance);
    const bestDist = candidates[0].distance;
    const topCandidates = candidates.filter(c => c.distance === bestDist);
    if (topCandidates.length === 1) {
      matched.push({
        v2_item_id: topCandidates[0].item._id,
        v1_canonical,
        v2_name: topCandidates[0].item.name,
        aliases,
        match_distance: bestDist,
      });
    } else {
      multiMatch.push({
        v1_canonical,
        chosen: null,
        candidates: topCandidates.slice(0, 5).map(c => ({ name: c.item.name, distance: c.distance })),
      });
      unmatched.push({ v1_canonical, alias_count: aliases.length, reason: 'ambiguous' });
    }
  }
}

log(`[aliases]   Matched: ${matched.length}, Unmatched: ${unmatched.length}, Multi-match: ${multiMatch.length}`);

// ── Step 5: Write to Convex (unless dry-run) ───────────────────────────────
let mutationErrors = 0;
let mutationSuccesses = 0;

if (!DRY_RUN && matched.length > 0) {
  log(`[aliases] Step 5: Writing aliases to Convex (${matched.length} items)...`);
  for (let i = 0; i < matched.length; i++) {
    const m = matched[i];
    try {
      const result = await convexMutation('items:upsertAliases', {
        item_id: m.v2_item_id,
        aliases: m.aliases,
      });
      mutationSuccesses++;
      log(`[aliases]   Wrote ${i + 1}/${matched.length}: ${m.v2_name} (+${m.aliases.length} aliases → ${result.alias_count} total)`);
    } catch (err) {
      mutationErrors++;
      process.stderr.write(`[aliases] MUTATION ERROR for ${m.v2_name}: ${err.message}\n`);
    }
  }
  log(`[aliases]   Done: ${mutationSuccesses} ok, ${mutationErrors} errors.`);
} else if (DRY_RUN) {
  log('[aliases] Step 5: Dry-run — skipping Convex writes.');
} else {
  log('[aliases] Step 5: No matched items — nothing to write.');
}

// ── Step 6: Write report ───────────────────────────────────────────────────
log('[aliases] Step 6: Writing report...');

const sampleMappings = matched.slice(0, 10);

const reportLines = [
  '# import-v1-item-aliases — Report',
  '',
  `**Run at:** ${new Date().toISOString()}`,
  `**Dry-run:** ${DRY_RUN}`,
  `**Limit:** ${LIMIT ?? 'none'}`,
  '',
  '## Summary',
  '',
  `| Metric | Value |`,
  `|--------|-------|`,
  `| v1 canonical items | ${canonicals.length} |`,
  `| v2 items loaded | ${v2Items.length} |`,
  `| Matched | ${matched.length} |`,
  `| Unmatched (v1 only) | ${unmatched.length} |`,
  `| Multi-match ambiguities | ${multiMatch.length} |`,
  `| Mutation successes | ${mutationSuccesses} |`,
  `| Mutation errors | ${mutationErrors} |`,
  '',
  '## Unmatched v1 Items (no v2 equivalent)',
  '',
  ...(unmatched.length === 0
    ? ['_(none)_']
    : unmatched.map(u => `- \`${u.v1_canonical}\` (${u.alias_count} aliases${u.reason ? ', reason: ' + u.reason : ''})`)),
  '',
  '## Multi-match Ambiguities',
  '',
  ...(multiMatch.length === 0
    ? ['_(none)_']
    : multiMatch.flatMap(m => [
        `- \`${m.v1_canonical}\` → chosen: ${m.chosen ?? '(none — ambiguous)'}`,
        ...m.candidates.map(c => `    - candidate: \`${c.name}\` (dist=${c.distance})`),
      ])),
  '',
  '## Sample Mappings (first 10)',
  '',
  '| v1 canonical | v2 name | distance | aliases (first 5) |',
  '|---|---|---|---|',
  ...sampleMappings.map(m =>
    `| ${m.v1_canonical} | ${m.v2_name} | ${m.match_distance} | ${m.aliases.slice(0, 5).join(', ')} |`
  ),
  '',
  '## All Matched Items',
  '',
  ...matched.map(m =>
    `### ${m.v2_name}\n- v1_canonical: \`${m.v1_canonical}\`\n- match_distance: ${m.match_distance}\n- aliases (${m.aliases.length}): ${m.aliases.map(a => `\`${a}\``).join(', ')}\n`
  ),
];

const reportContent = reportLines.join('\n');
await writeFile(REPORT_PATH, reportContent, 'utf8');
log(`[aliases] Report written to ${REPORT_PATH}`);

// ── Step 7: Final stdout summary ───────────────────────────────────────────
console.log('');
console.log('=== import-v1-item-aliases summary ===');
console.log(`v1 canonical items : ${canonicals.length}`);
console.log(`v2 items loaded    : ${v2Items.length}`);
console.log(`matched            : ${matched.length}`);
console.log(`unmatched          : ${unmatched.length}`);
console.log(`multi-match        : ${multiMatch.length}`);
if (!DRY_RUN) {
  console.log(`mutations ok       : ${mutationSuccesses}`);
  console.log(`mutations errors   : ${mutationErrors}`);
}
console.log(`report             : ${REPORT_PATH}`);
console.log('');

if (unmatched.length > 0) {
  console.log('Unmatched v1 canonicals:');
  for (const u of unmatched) console.log(`  - ${u.v1_canonical}`);
  console.log('');
}

// Exit code
if (mutationErrors > 0) process.exit(3);
process.exit(0);
