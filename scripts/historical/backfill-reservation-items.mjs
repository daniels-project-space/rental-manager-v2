// Phase 5.4 backfill: populate items[] on reservations that were imported with empty items[].
// Reads extracteditem rows from v1 Postgres and patches matching Convex reservations.
// Run: node scripts/backfill-reservation-items.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
const { Client } = pg;

const PG_URL = 'postgresql://ai:ai@localhost:5432/rental_manager';
const REPO = '/home/ubuntu/rental-manager-v2';
const BATCH = 100;

function runConvex(fn, args) {
  const argJson = JSON.stringify(args);
  const r = spawnSync('npx', ['convex', 'run', fn, argJson], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`convex ${fn} failed: ${r.stderr}`);
  const out = r.stdout.trim();
  const lines = out.split('\n');
  let jsonStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('{') || lines[i].trim().startsWith('[')) {
      jsonStart = i;
      break;
    }
  }
  const jsonText = jsonStart >= 0 ? lines.slice(jsonStart).join('\n') : out;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`failed to parse convex output for ${fn}: ${out.slice(0, 500)}`);
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  console.log('[backfill-items] start');
  const pgc = new Client({ connectionString: PG_URL });
  await pgc.connect();

  // Pull all extracteditem rows for eligible rentals
  const { rows: extractedRows } = await pgc.query(`
    SELECT e.id, e.rental_id, e.item_name, e.source, e.confidence_score
    FROM extracteditem e
    WHERE e.rental_id IN (
      SELECT id FROM rental
      WHERE status IN ('confirmed', 'completed')
        AND renter_price IS NOT NULL
        AND start_date IS NOT NULL
        AND end_date IS NOT NULL
    )
    ORDER BY e.rental_id, e.id
  `);

  console.log(`[backfill-items] v1 extracteditem rows: ${extractedRows.length}`);

  // Group by rental_id
  const byRental = new Map();
  for (const e of extractedRows) {
    if (!byRental.has(e.rental_id)) byRental.set(e.rental_id, []);
    byRental.get(e.rental_id).push({
      item_name: e.item_name,
      qty: 1,
      source: e.source ?? undefined,
      confidence_score: e.confidence_score ?? undefined,
      v1_extracteditem_id: e.id,
    });
  }

  console.log(`[backfill-items] rentals with items in v1: ${byRental.size}`);

  // Build payload rows
  const payload = Array.from(byRental.entries()).map(([v1_rental_id, items]) => ({
    v1_rental_id,
    items,
  }));

  let totalUpdated = 0;
  let totalSkippedNotFound = 0;
  let totalSkippedHasItems = 0;
  let batchNum = 0;

  for (const batch of chunk(payload, BATCH)) {
    batchNum++;
    const res = runConvex('seed/data:backfillReservationItemsBatch', { rows: batch });
    totalUpdated += res.updated;
    totalSkippedNotFound += res.skipped_not_found;
    totalSkippedHasItems += res.skipped_already_has_items;
    console.log(`[backfill-items] batch ${batchNum}: updated=${res.updated} not_found=${res.skipped_not_found} already_has=${res.skipped_already_has_items}`);
  }

  await pgc.end();

  const summary = {
    v1_extracteditem_rows: extractedRows.length,
    v1_rentals_with_items: byRental.size,
    total_updated: totalUpdated,
    total_skipped_not_found: totalSkippedNotFound,
    total_skipped_already_has_items: totalSkippedHasItems,
  };
  writeFileSync('/tmp/backfill_items_log.json', JSON.stringify(summary, null, 2));
  console.log('[backfill-items] done', summary);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
