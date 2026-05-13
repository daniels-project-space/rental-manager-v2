/**
 * backfill-v2-revenue-from-v1.mjs
 *
 * Backfills v2's historical_revenue table for 2024-08 → 2026-02 using v1's
 * Postgres `rental` table (matches v1's getRentalsWithRevenue() logic exactly).
 *
 * V1 CANONICAL FILTER (from revenue.service.ts getRentalsWithRevenue):
 *   status IN ('completed', 'ongoing', 'upcoming', 'consolidated')
 *   rental_price > 0, start_date NOT NULL
 *   EXCLUDE phantom completed: status='completed' AND order_step='APPROVED'
 *   EXCLUDE upcoming with no confirmed bookings
 *   DEDUP: listing_id + renter_info + start_date → keep highest rental_price
 *   DATE: COALESCE(earliest confirmed booking pickup_date, start_date) for month attribution
 *   NET: gross * 0.64
 *
 * - Preserves existing damage_costs_gbp from stub rows (389/388 monthly overlay).
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

// ── Damage cost overlay (preserved from original stub rows) ──────────────────
// Monthly camera-damage amortised cost from original migrate-historical-revenue.mjs
const DAMAGE_COSTS = {
  '2024-08': 389, '2024-09': 389, '2024-10': 389, '2024-11': 389, '2024-12': 389,
  '2025-01': 389, '2025-02': 389, '2025-03': 389, '2025-04': 389, '2025-05': 389,
  '2025-06': 389, '2025-07': 389, '2025-08': 389, '2025-09': 389, '2025-10': 389,
  '2025-11': 388, '2025-12': 388,
  '2026-01': 388, '2026-02': 0,
};

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

// ── Step 1b: Upsert pre-tracking historical data (2022-08 → 2024-07) ────────
// These months have no Postgres tracking — sourced from v1's static HISTORICAL_REVENUE array.
// totalOverallMade is the definitive combined net figure (Daniel+Vertus+DBCinema, bank-payout basis).
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

if (DRY_RUN) {
  const preTotal = PRE_TRACKING.reduce((s, r) => s + r.totalOverallMade, 0);
  log(`[backfill] Step 1b (DRY_RUN): would upsert ${PRE_TRACKING.length} pre-tracking months, totalOverallMade sum=£${preTotal}`);
} else {
  log(`[backfill] Step 1b: Upserting ${PRE_TRACKING.length} pre-tracking months (2022-08 → 2024-07)...`);
  let preOk = 0;
  for (const row of PRE_TRACKING) {
    const args = {
      month: row.month,
      total_revenue_gbp: row.totalRevenue,
      damage_costs_gbp: row.damageCosts,
      business_expenses_gbp: row.businessExpenses,
      total_overall_made_gbp: row.totalOverallMade,
      source: 'v1-historical-static',
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
        process.stderr.write(`[backfill] WARN pre-tracking ${row.month} failed: ${raw.trim()}\n`);
      } else {
        preOk++;
        log(`[backfill]   ${res.value?.action ?? 'ok'}: ${row.month}  totalOverallMade=£${row.totalOverallMade}`);
      }
    } catch (e) {
      process.stderr.write(`[backfill] ERROR pre-tracking ${row.month}: ${e.message}\n`);
    }
  }
  log(`[backfill] Step 1b done: ${preOk}/${PRE_TRACKING.length} pre-tracking months upserted`);
}

// ── Step 2: Query v1 Postgres ────────────────────────────────────────────────
log('[backfill] Step 2: Querying v1 Postgres for 2024-08 → 2026-02...');
let rows;
try {
  // Mirrors v1 getRentalsWithRevenue() exactly:
  //  - statuses: completed + ongoing + upcoming + consolidated
  //  - exclude phantom completed (APPROVED but never paid)
  //  - exclude upcoming with no confirmed/completed bookings
  //  - dedup listing_id+renter_info+start_date → keep highest rental_price
  //  - effective_date = COALESCE(earliest confirmed booking pickup_date, rental.start_date)
  const sql = `
    WITH deduped AS (
      SELECT DISTINCT ON (r.listing_id, r.renter_info, r.start_date)
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
      WHERE r.start_date  >= '2024-08-01'
        AND r.start_date   < '2026-03-01'
        AND r.rental_price  > 0
        AND r.start_date   IS NOT NULL
        AND r.status IN ('completed', 'ongoing', 'upcoming', 'consolidated')
        -- exclude phantom completed (owner APPROVED but renter never paid)
        AND NOT (r.status = 'completed' AND r.order_step = 'APPROVED')
        -- exclude upcoming rentals that have no confirmed bookings
        AND NOT (
          r.status = 'upcoming'
          AND NOT EXISTS (
            SELECT 1 FROM booking b2
             WHERE b2.rental_id = r.id
               AND b2.status IN ('confirmed', 'completed')
          )
        )
      ORDER BY r.listing_id, r.renter_info, r.start_date, r.rental_price DESC
    )
    SELECT
      to_char(date_trunc('month', effective_date), 'YYYY-MM') AS month,
      account,
      ROUND(SUM(rental_price)::numeric, 2)          AS gross_total,
      ROUND((SUM(rental_price) * 0.64)::numeric, 2) AS net_total,
      COUNT(*)::int                                  AS cnt
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

  rows = psqlOut.trim().split('\n').filter(Boolean).map(line => {
    const [month, account, gross_total, net_total, cnt] = line.split('|');
    return {
      month,
      account,
      gross_total: parseFloat(gross_total),
      net_total: parseFloat(net_total),
      cnt: parseInt(cnt, 10),
    };
  });

  log(`[backfill] Got ${rows.length} month-account rows from v1`);
} catch (e) {
  process.stderr.write('[backfill] ERROR querying v1: ' + e.message + '\n');
  process.exit(1);
}

// ── Step 3: Aggregate by month (sum across accounts) ────────────────────────
// upsertMonth has no account_slug — one row per calendar month
const byMonth = new Map();
for (const r of rows) {
  const existing = byMonth.get(r.month) ?? { month: r.month, gross: 0, net: 0, cnt: 0, accounts: [] };
  existing.gross += r.gross_total;
  existing.net   += r.net_total;
  existing.cnt   += r.cnt;
  existing.accounts.push(`${r.account}=£${r.net_total.toFixed(2)}`);
  byMonth.set(r.month, existing);
}

// Build ordered payload
const payload = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
  month:                   m.month,
  total_revenue_gbp:       Math.round(m.net * 100) / 100,
  damage_costs_gbp:        DAMAGE_COSTS[m.month] ?? 0,
  business_expenses_gbp:   0,
  // sentinel 0 = "don't override live reservation data, only supply damage_costs_gbp"
  // (matches the pattern in v1's HISTORICAL_REVENUE for 2024-08+ sentinel rows)
  total_overall_made_gbp:  0,
  source:                  'v1-postgres-backfill',
  _gross:                  Math.round(m.gross * 100) / 100,
  _cnt:                    m.cnt,
  _accounts:               m.accounts.join(', '),
}));

const aggregateNet   = payload.reduce((s, r) => s + r.total_revenue_gbp, 0);
const aggregateGross = payload.reduce((s, r) => s + r._gross, 0);

log(`[backfill] Months: ${payload.length}`);
log(`[backfill] Aggregate gross: £${aggregateGross.toFixed(2)}`);
log(`[backfill] Aggregate net:   £${aggregateNet.toFixed(2)}`);

// ── Step 4: Dry-run output ───────────────────────────────────────────────────
if (DRY_RUN) {
  console.log(`DRY_RUN: would upsert ${payload.length} months`);
  console.log(`Aggregate gross: £${aggregateGross.toFixed(2)}`);
  console.log(`Aggregate net:   £${aggregateNet.toFixed(2)}`);
  console.log('\nPer-month preview:');
  for (const r of payload) {
    console.log(`  ${r.month}  net=£${r.total_revenue_gbp.toFixed(2)}  damage=£${r.damage_costs_gbp}  cnt=${r._cnt}  [${r._accounts}]`);
  }
  process.exit(0);
}

// ── Step 5: Upsert each month via Convex HTTP API ────────────────────────────
log('[backfill] Step 5: Upserting months via Convex HTTP API...');

let upserted = 0;
let errors   = 0;

for (const r of payload) {
  const args = {
    month:                  r.month,
    total_revenue_gbp:      r.total_revenue_gbp,
    damage_costs_gbp:       r.damage_costs_gbp,
    business_expenses_gbp:  r.business_expenses_gbp,
    total_overall_made_gbp: r.total_overall_made_gbp,
    source:                 r.source,
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
      log(`[backfill]   ${res.value?.action ?? 'ok'}: ${r.month}  net=£${r.total_revenue_gbp.toFixed(2)}  damage=£${r.damage_costs_gbp}`);
    }
  } catch (e) {
    process.stderr.write(`[backfill] ERROR ${r.month}: ${e.message}\n`);
    errors++;
  }
}

console.log(`\nUpserted ${upserted} / ${payload.length} months. Errors: ${errors}`);
if (errors > 0) process.exit(3);
