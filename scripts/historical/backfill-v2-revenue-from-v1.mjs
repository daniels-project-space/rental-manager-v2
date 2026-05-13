/**
 * backfill-v2-revenue-from-v1.mjs
 *
 * Backfills v2's historical_revenue table for ALL months 2022-08 → 2026-02.
 *
 * V1 CANONICAL FILTER (from revenue.service.ts getRentalsWithRevenue):
 *   status IN ('completed', 'ongoing', 'upcoming')   ← NOT 'consolidated' (v1 audit finding)
 *   rental_price > 0, start_date NOT NULL
 *   EXCLUDE phantom completed: status='completed' AND order_step='APPROVED'
 *   EXCLUDE upcoming with no confirmed bookings
 *   DEDUP: listing_id + renter_info + DATE(start_date) → keep highest rental_price
 *   DATE: COALESCE(earliest confirmed booking pickup_date, rental.start_date) for month attribution
 *   NET: gross * 0.64
 *
 * Per-account algorithm (v1 parity):
 *   Pre-tracking months (2022-08 → 2024-07, where totalOverallMade > 0):
 *     netRental = totalOverallMade - damageCosts
 *     totalTracked = dbcinema_gross * 0.64 + leo_gross * 0.64
 *     if totalTracked > netRental: scale both down proportionally (ratio-cap)
 *     cappedTracked = min(totalTracked, netRental)
 *     remainder = max(0, netRental - cappedTracked)
 *     daniel = vertus = remainder / 2 (50/50 split)
 *   Post-tracking months (2024-08+, totalOverallMade = 0):
 *     daniel = vertus = 0 (accounts retired)
 *     dbcinema + leo = live Postgres net amounts
 *
 * - Preserves existing damage_costs_gbp from stub rows.
 * - Idempotent upsert via historical_revenue:upsertMonth.
 * - Auth: CONVEX_ACCESS_TOKEN (PAT) from project-hub vault.
 *
 * Usage:
 *   node scripts/historical/backfill-v2-revenue-from-v1.mjs [--dry-run]
 *
 * Exit codes:
 *   0 = success
 *   1 = setup error
 *   3 = mutation errors occurred
 */

import { execSync } from 'node:child_process';

const VAULT_URL  = 'https://fantastic-roadrunner-485.convex.cloud/api/query';
const CONVEX_URL = 'https://exciting-lion-29.convex.cloud';
const DRY_RUN    = process.argv.includes('--dry-run');

function log(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function r2(n) {
  return Math.round(n * 100) / 100;
}

// ── Damage cost overlay (preserved from original stub rows) ──────────────────
const DAMAGE_COSTS = {
  '2024-08': 389, '2024-09': 389, '2024-10': 389, '2024-11': 389, '2024-12': 389,
  '2025-01': 389, '2025-02': 389, '2025-03': 389, '2025-04': 389, '2025-05': 389,
  '2025-06': 389, '2025-07': 389, '2025-08': 389, '2025-09': 389, '2025-10': 389,
  '2025-11': 388, '2025-12': 388,
  '2026-01': 388, '2026-02': 0,
};

// ── V1 static historical data (2022-08 → 2024-07) ───────────────────────────
// Source: /home/ubuntu/rental-manager/src/data/historical-revenue.ts
const PRE_TRACKING = [
  { month: '2022-08', totalRevenue: 172,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 172 },
  { month: '2022-09', totalRevenue: 105,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 105 },
  { month: '2022-10', totalRevenue: 152,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 152 },
  { month: '2022-11', totalRevenue: 423,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 423 },
  { month: '2022-12', totalRevenue: 272,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 272 },
  { month: '2023-01', totalRevenue: 204,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 204 },
  { month: '2023-02', totalRevenue: 369,  damageCosts: 55,   businessExpenses: 0,   totalOverallMade: 424 },
  { month: '2023-03', totalRevenue: 614,  damageCosts: 600,  businessExpenses: 0,   totalOverallMade: 1214 },
  { month: '2023-04', totalRevenue: 559,  damageCosts: 450,  businessExpenses: 0,   totalOverallMade: 1009 },
  { month: '2023-05', totalRevenue: 420,  damageCosts: 130,  businessExpenses: 0,   totalOverallMade: 550 },
  { month: '2023-06', totalRevenue: 725,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 725 },
  { month: '2023-07', totalRevenue: 342,  damageCosts: 1318, businessExpenses: 0,   totalOverallMade: 1660 },
  { month: '2023-08', totalRevenue: 586,  damageCosts: 585,  businessExpenses: 0,   totalOverallMade: 1171 },
  { month: '2023-09', totalRevenue: 1002, damageCosts: 778,  businessExpenses: 0,   totalOverallMade: 1780 },
  { month: '2023-10', totalRevenue: 973,  damageCosts: 655,  businessExpenses: 0,   totalOverallMade: 1628 },
  { month: '2023-11', totalRevenue: 2466, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 2466 },
  { month: '2023-12', totalRevenue: 1523, damageCosts: 170,  businessExpenses: 0,   totalOverallMade: 1693 },
  { month: '2024-01', totalRevenue: 3244, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 3244 },
  { month: '2024-02', totalRevenue: 2630, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 2630 },
  { month: '2024-03', totalRevenue: 3242, damageCosts: 330,  businessExpenses: 0,   totalOverallMade: 3572 },
  { month: '2024-04', totalRevenue: 2785, damageCosts: 100,  businessExpenses: 0,   totalOverallMade: 2885 },
  { month: '2024-05', totalRevenue: 2992, damageCosts: 282,  businessExpenses: 0,   totalOverallMade: 2992 },
  { month: '2024-06', totalRevenue: 3406, damageCosts: 419,  businessExpenses: 256, totalOverallMade: 3569 },
  { month: '2024-07', totalRevenue: 4414, damageCosts: 1464, businessExpenses: 0,   totalOverallMade: 5878 },
];

// ── Step 1: Fetch PAT from vault ─────────────────────────────────────────────
log('[backfill] Step 1: Fetching CONVEX_ACCESS_TOKEN from vault...');
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
  log(`[backfill] PAT fetched (length=${pat.length})`);
} catch (e) {
  process.stderr.write('[backfill] ERROR: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 2: Query v1 Postgres for ALL months (2022-08 → 2026-02) ─────────────
// Uses v1's exact filter: status IN ('completed','ongoing','upcoming')
// with phantom-booking exclusion and dedup.
log('[backfill] Step 2: Querying v1 Postgres for 2022-08 → 2026-02 (v1 exact filter)...');
let pgRows;
try {
  const sql = `
    WITH deduped AS (
      SELECT DISTINCT ON (r.listing_id, r.renter_info, DATE(r.start_date))
        r.account,
        r.rental_price,
        COALESCE(
          (SELECT b.pickup_date
             FROM booking b
            WHERE b.rental_id = r.id
              AND b.status IN ('confirmed', 'completed')
              AND b.pickup_date IS NOT NULL
            ORDER BY b.pickup_date ASC
            LIMIT 1),
          r.start_date
        ) AS effective_date
      FROM rental r
      WHERE r.start_date  >= '2022-08-01'
        AND r.start_date   < '2026-03-01'
        AND r.rental_price  > 0
        AND r.start_date   IS NOT NULL
        AND r.status IN ('completed', 'ongoing', 'upcoming')
        -- exclude phantom completed (owner APPROVED but renter never paid)
        -- NULL-safe: order_step IS NULL for pre-2025 rows; = 'APPROVED' comparison returns NULL not FALSE
        AND NOT (r.status = 'completed' AND r.order_step IS NOT DISTINCT FROM 'APPROVED')
        -- exclude upcoming rentals that have no confirmed bookings
        AND NOT (
          r.status = 'upcoming'
          AND NOT EXISTS (
            SELECT 1 FROM booking b2
             WHERE b2.rental_id = r.id
               AND b2.status IN ('confirmed', 'completed')
          )
        )
      ORDER BY r.listing_id, r.renter_info, DATE(r.start_date), r.rental_price DESC
    )
    SELECT
      to_char(date_trunc('month', effective_date), 'YYYY-MM') AS month,
      account,
      ROUND(SUM(rental_price)::numeric, 2) AS gross_total,
      ROUND(SUM(rental_price)::numeric, 2) AS net_total,
      COUNT(*)::int                         AS cnt
    FROM deduped
    GROUP BY month, account
    ORDER BY month, account;
  `;

  // Read DATABASE_URL from v1 env (never print it)
  const envRaw = execSync('cat /home/ubuntu/rental-manager/.env', { encoding: 'utf8' });
  const dbUrl = envRaw.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('DATABASE_URL='))
    .map(l => l.replace(/^DATABASE_URL=/, '').replace(/^["']|["']$/g, ''))
    [0];
  if (!dbUrl) throw new Error('DATABASE_URL not found in v1 .env');

  const psqlOut = execSync(
    `psql "${dbUrl}" -t -A -F '|'`,
    { encoding: 'utf8', input: sql }
  );

  pgRows = psqlOut.trim().split('\n').filter(Boolean).map(line => {
    const [month, account, gross_total, net_total, cnt] = line.split('|');
    return {
      month,
      account: account || 'dbcinema',
      gross_total: parseFloat(gross_total) || 0,
      net_total: parseFloat(net_total) || 0,
      cnt: parseInt(cnt, 10) || 0,
    };
  });

  log(`[backfill] Got ${pgRows.length} month-account rows from v1 Postgres`);
} catch (e) {
  process.stderr.write('[backfill] ERROR querying v1: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 3: Build per-month per-account map from Postgres ────────────────────
// pgByMonth[month] = { dbcinema: {net, gross}, leo: {net, gross} }
const pgByMonth = new Map();
for (const r of pgRows) {
  if (!pgByMonth.has(r.month)) pgByMonth.set(r.month, {});
  const m = pgByMonth.get(r.month);
  const acct = r.account || 'dbcinema';
  if (!m[acct]) m[acct] = { net: 0, gross: 0, cnt: 0 };
  m[acct].net   += r.net_total;
  m[acct].gross += r.gross_total;
  m[acct].cnt   += r.cnt;
}

// ── Step 4: Compute per-account splits for pre-tracking months ───────────────
log('[backfill] Step 4: Computing per-account splits for 2022-08 → 2024-07...');

const preTrackingPayload = [];
let totalDaniel = 0, totalVertus = 0, totalDbPre = 0, totalLeoPre = 0;

for (const row of PRE_TRACKING) {
  const pg = pgByMonth.get(row.month) ?? {};
  const dbNet  = pg['dbcinema']?.net ?? 0;
  const leoNet = pg['leo']?.net ?? 0;

  let dbcinema_revenue_gbp  = dbNet;
  let leo_revenue_gbp       = leoNet;
  let daniel_revenue_gbp    = 0;
  let vertus_revenue_gbp    = 0;

  if (row.totalOverallMade > 0) {
    const damageRevenue = row.damageCosts;
    const netRental = row.totalOverallMade - damageRevenue;
    const totalTracked = dbNet + leoNet;

    if (totalTracked > netRental && totalTracked > 0) {
      // ratio-cap: scale tracked accounts down proportionally
      const ratio = netRental / totalTracked;
      dbcinema_revenue_gbp = r2(dbNet * ratio);
      leo_revenue_gbp      = r2(leoNet * ratio);
    }
    const cappedTracked = dbcinema_revenue_gbp + leo_revenue_gbp;
    const remainder = Math.max(0, netRental - cappedTracked);
    daniel_revenue_gbp = r2(remainder / 2);
    vertus_revenue_gbp = r2(remainder - daniel_revenue_gbp);
  }

  totalDbPre  += dbcinema_revenue_gbp;
  totalLeoPre += leo_revenue_gbp;
  totalDaniel += daniel_revenue_gbp;
  totalVertus += vertus_revenue_gbp;

  preTrackingPayload.push({
    month:                  row.month,
    total_revenue_gbp:      row.totalRevenue,
    damage_costs_gbp:       row.damageCosts,
    business_expenses_gbp:  row.businessExpenses,
    total_overall_made_gbp: row.totalOverallMade,
    source:                 'v1-historical-static',
    dbcinema_revenue_gbp,
    leo_revenue_gbp,
    daniel_revenue_gbp,
    vertus_revenue_gbp,
  });

  log(`[backfill]   ${row.month}  overallMade=£${row.totalOverallMade}  db=£${dbcinema_revenue_gbp.toFixed(2)}  leo=£${leo_revenue_gbp.toFixed(2)}  daniel=£${daniel_revenue_gbp.toFixed(2)}  vertus=£${vertus_revenue_gbp.toFixed(2)}`);
}

log(`[backfill] Pre-tracking totals: db=£${totalDbPre.toFixed(2)} leo=£${totalLeoPre.toFixed(2)} daniel=£${totalDaniel.toFixed(2)} vertus=£${totalVertus.toFixed(2)}`);

// ── Step 5: Build post-tracking payload (2024-08 → 2026-02) ─────────────────
log('[backfill] Step 5: Building post-tracking payload (2024-08 → 2026-02)...');

const postMonths = Object.keys(DAMAGE_COSTS).sort();
const postTrackingPayload = [];
let totalDbPost = 0, totalLeoPost = 0;

for (const month of postMonths) {
  const pg = pgByMonth.get(month) ?? {};
  const dbNet  = r2(pg['dbcinema']?.net ?? 0);
  const leoNet = r2(pg['leo']?.net ?? 0);
  const netTotal = r2(dbNet + leoNet);

  totalDbPost  += dbNet;
  totalLeoPost += leoNet;

  postTrackingPayload.push({
    month,
    total_revenue_gbp:      netTotal,
    damage_costs_gbp:       DAMAGE_COSTS[month] ?? 0,
    business_expenses_gbp:  0,
    total_overall_made_gbp: 0, // sentinel: damage-only overlay
    source:                 'v1-postgres-backfill',
    dbcinema_revenue_gbp:   dbNet,
    leo_revenue_gbp:        leoNet,
    daniel_revenue_gbp:     0, // retired post-2024-07
    vertus_revenue_gbp:     0, // retired post-2024-07
  });
}

log(`[backfill] Post-tracking totals: db=£${totalDbPost.toFixed(2)} leo=£${totalLeoPost.toFixed(2)}`);

const allPayload = [...preTrackingPayload, ...postTrackingPayload];
const overallDbTotal    = r2(totalDbPre + totalDbPost);
const overallLeoTotal   = r2(totalLeoPre + totalLeoPost);
const overallDaniel     = r2(totalDaniel);
const overallVertus     = r2(totalVertus);
const damageSum         = allPayload.reduce((s, r) => s + r.damage_costs_gbp, 0);
const predictedLifetime = r2(overallDbTotal + overallLeoTotal + overallDaniel + overallVertus + damageSum);

log(`[backfill] === PREDICTED TOTALS ===`);
log(`[backfill]   dbcinema: £${overallDbTotal.toFixed(2)}  (target ~£107,294)`);
log(`[backfill]   leo:      £${overallLeoTotal.toFixed(2)}  (target ~£2,577)`);
log(`[backfill]   daniel:   £${overallDaniel.toFixed(2)}  (target ~£7,178)`);
log(`[backfill]   vertus:   £${overallVertus.toFixed(2)}  (target ~£7,178)`);
log(`[backfill]   damage:   £${damageSum.toFixed(2)}  (target £14,335)`);
log(`[backfill]   TOTAL:    £${predictedLifetime.toFixed(2)}  (target £138,563)`);
log(`[backfill] Total months: ${allPayload.length} (v1 has 47)`);

// Identify months in v1 PRE_TRACKING not in pgByMonth (the 4 missing months)
const v1Months = new Set(PRE_TRACKING.map(r => r.month));
const pgMonths = new Set(pgRows.map(r => r.month));
const missingFromPg = [...v1Months].filter(m => !pgMonths.has(m));
if (missingFromPg.length > 0) {
  log(`[backfill] Months with no Postgres data (pre-tracking only, using totalOverallMade): ${missingFromPg.join(', ')}`);
}

if (DRY_RUN) {
  console.log(`DRY_RUN: would upsert ${allPayload.length} months`);
  console.log(`Predicted lifetime: £${predictedLifetime.toFixed(2)} (target £138,563)`);
  console.log('\nPre-tracking preview:');
  for (const r of preTrackingPayload) {
    console.log(`  ${r.month}  overallMade=£${r.total_overall_made_gbp}  db=£${r.dbcinema_revenue_gbp.toFixed(2)}  leo=£${r.leo_revenue_gbp.toFixed(2)}  daniel=£${r.daniel_revenue_gbp.toFixed(2)}  vertus=£${r.vertus_revenue_gbp.toFixed(2)}`);
  }
  console.log('\nPost-tracking preview:');
  for (const r of postTrackingPayload) {
    console.log(`  ${r.month}  net=£${r.total_revenue_gbp.toFixed(2)}  damage=£${r.damage_costs_gbp}  db=£${r.dbcinema_revenue_gbp.toFixed(2)}  leo=£${r.leo_revenue_gbp.toFixed(2)}`);
  }
  process.exit(0);
}

// ── Step 6: Upsert all months via Convex HTTP API ────────────────────────────
log(`[backfill] Step 6: Upserting ${allPayload.length} months via Convex HTTP API...`);

let upserted = 0;
let errors   = 0;

for (const r of allPayload) {
  const args = {
    month:                  r.month,
    total_revenue_gbp:      r.total_revenue_gbp,
    damage_costs_gbp:       r.damage_costs_gbp,
    business_expenses_gbp:  r.business_expenses_gbp,
    total_overall_made_gbp: r.total_overall_made_gbp,
    source:                 r.source,
    dbcinema_revenue_gbp:   r.dbcinema_revenue_gbp,
    leo_revenue_gbp:        r.leo_revenue_gbp,
    daniel_revenue_gbp:     r.daniel_revenue_gbp,
    vertus_revenue_gbp:     r.vertus_revenue_gbp,
  };
  const body = JSON.stringify({ path: 'historical_revenue:upsertMonth', args, format: 'json' });

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
      process.stderr.write(`[backfill] WARN ${r.month} failed: ${raw.trim()}\n`);
      errors++;
    } else {
      upserted++;
      log(`[backfill]   ${res.value?.action ?? 'ok'}: ${r.month}  db=£${r.dbcinema_revenue_gbp.toFixed(2)}  leo=£${r.leo_revenue_gbp.toFixed(2)}  daniel=£${r.daniel_revenue_gbp.toFixed(2)}  vertus=£${r.vertus_revenue_gbp.toFixed(2)}`);
    }
  } catch (e) {
    process.stderr.write(`[backfill] ERROR ${r.month}: ${e.message}\n`);
    errors++;
  }
}

console.log(`\nUpserted ${upserted} / ${allPayload.length} months. Errors: ${errors}`);
console.log(`Per-account totals written:`);
console.log(`  dbcinema: £${overallDbTotal.toFixed(2)}`);
console.log(`  leo:      £${overallLeoTotal.toFixed(2)}`);
console.log(`  daniel:   £${overallDaniel.toFixed(2)}`);
console.log(`  vertus:   £${overallVertus.toFixed(2)}`);
console.log(`  damage:   £${damageSum.toFixed(2)}`);
console.log(`  PREDICTED LIFETIME: £${predictedLifetime.toFixed(2)}`);

if (errors > 0) process.exit(3);
