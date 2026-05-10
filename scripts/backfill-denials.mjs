/**
 * backfill-denials.mjs
 *
 * Pulls owner_denied + expired rows from v1 Postgres lost_revenue_record
 * and inserts them into the v2 Convex denial_records table.
 *
 * Run from: /home/ubuntu/rental-manager-v2
 * Usage: node scripts/backfill-denials.mjs
 *
 * Idempotent: deduplicates by checking existing denial_records count before
 * inserting to avoid double-runs (full wipe + reimport pattern not used).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load Prisma from v1 project
const { PrismaClient } = require('/home/ubuntu/rental-manager/node_modules/@prisma/client/default.js');

const CONVEX_URL = 'https://hearty-oyster-600.convex.cloud';

// ── Convex HTTP helper ────────────────────────────────────────

async function convexMutation(path, args) {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Convex mutation ${path} failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(`Convex mutation error: ${JSON.stringify(data)}`);
  }
  return data.value;
}

async function convexQuery(path, args) {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  if (!res.ok) throw new Error(`Query ${path} failed: ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`Query error: ${JSON.stringify(data)}`);
  return data.value;
}

// ── Main ──────────────────────────────────────────────────────

const prisma = new PrismaClient();

try {
  // Guard: skip if denial_records already has rows (idempotent)
  const existing = await convexQuery('denial_records:list', { limit: 1 });
  if (existing.length > 0) {
    console.log(`[backfill-denials] denial_records already has rows — skipping to avoid duplicates.`);
    console.log(`[backfill-denials] Run with --force to override (not implemented — truncate table manually first).`);
    process.exit(0);
  }

  // Fetch owner_denied + expired rows from v1
  const rows = await prisma.lost_revenue_record.findMany({
    where: { denial_type: { in: ['owner_denied', 'expired'] } },
    orderBy: { created_at: 'asc' },
    select: {
      id: true,
      hygglo_order_id: true,
      title: true,
      renter_info: true,
      account: true,
      lost_revenue: true,
      denial_type: true,
      created_at: true,
    },
  });

  console.log(`[backfill-denials] Found ${rows.length} v1 denial rows to import.`);

  let inserted = 0;
  let errored = 0;
  const BATCH = 50;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const row of batch) {
      try {
        await convexMutation('denial_records:createDenial', {
          itemName: row.title ?? 'Unknown',
          reason: row.denial_type ?? 'owner_denied',
          estimatedValue: row.lost_revenue ?? undefined,
          notes: row.renter_info
            ? `v1 order ${row.hygglo_order_id ?? row.id} — renter: ${row.renter_info}`
            : `v1 order ${row.hygglo_order_id ?? row.id}`,
          accountSlug: row.account ?? undefined,
        });
        inserted++;
      } catch (err) {
        errored++;
        if (errored <= 3) {
          console.error(`[backfill-denials] Row ${row.id} failed: ${err.message}`);
        }
      }
    }
    const pct = Math.round(((i + batch.length) / rows.length) * 100);
    process.stdout.write(`\r[backfill-denials] Progress: ${i + batch.length}/${rows.length} (${pct}%)  `);
  }

  console.log(`\n[backfill-denials] Done. Inserted: ${inserted}, Errored: ${errored}`);

  // Verify
  const after = await convexQuery('denial_records:list', { limit: 5 });
  console.log(`[backfill-denials] Sample denial_records:`, JSON.stringify(after.slice(0, 2), null, 2));

} finally {
  await prisma.$disconnect();
}
