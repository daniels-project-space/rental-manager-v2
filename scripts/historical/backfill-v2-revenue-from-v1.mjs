/**
 * backfill-v2-revenue-from-v1.mjs
 *
 * Backfills v2's historical_revenue table for 2024-08 → 2026-02 using v1's
 * Postgres `rental` table (completed + consolidated rentals, net = gross * 0.64).
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

// ── Step 2: Query v1 Postgres ────────────────────────────────────────────────
log('[backfill] Step 2: Querying v1 Postgres for 2024-08 → 2026-02...');
let rows;
try {
  const sql = `
    SELECT
      to_char(date_trunc('month', start_date), 'YYYY-MM') AS month,
      account,
      ROUND(SUM(rental_price)::numeric, 2)          AS gross_total,
      ROUND((SUM(rental_price) * 0.64)::numeric, 2) AS net_total,
      COUNT(*)::int                                  AS cnt
    FROM rental
    WHERE start_date >= '2024-08-01'
      AND start_date <  '2026-03-01'
      AND status IN ('completed', 'consolidated')
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
    `psql "${dbUrl}" -t -A -F '|' -c "${sql.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' }
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
  total_overall_made_gbp:  Math.round(m.net * 100) / 100,
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
