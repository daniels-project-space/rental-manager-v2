/**
 * Stage 2.5 migration: import v1 HISTORICAL_REVENUE static into Convex historical_revenue table.
 * Idempotent — skips months already present.
 * Run: node scripts/historical/migrate-historical-revenue.mjs
 */
import { spawnSync } from 'node:child_process';

const REPO = '/home/ubuntu/rental-manager-v2';

// Source: verbatim from /home/ubuntu/rental-manager/src/data/historical-revenue.ts
// Copied here so v2 has zero runtime dependency on v1 source files.
const HISTORICAL_REVENUE = [
  // === 2022 Aug-Dec ===
  { month: '2022-08', totalRevenue: 172,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 172 },
  { month: '2022-09', totalRevenue: 105,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 105 },
  { month: '2022-10', totalRevenue: 152,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 152 },
  { month: '2022-11', totalRevenue: 423,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 423 },
  { month: '2022-12', totalRevenue: 272,  damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 272 },
  // === 2023 Jan-Dec ===
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
  // === 2024 Jan-Jul (full override: use totalRevenue from v1 static, not v1 Postgres) ===
  { month: '2024-01', totalRevenue: 3244, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 3244 },
  { month: '2024-02', totalRevenue: 2630, damageCosts: 0,    businessExpenses: 0,   totalOverallMade: 2630 },
  { month: '2024-03', totalRevenue: 3242, damageCosts: 330,  businessExpenses: 0,   totalOverallMade: 3572 },
  { month: '2024-04', totalRevenue: 2785, damageCosts: 100,  businessExpenses: 0,   totalOverallMade: 2885 },
  { month: '2024-05', totalRevenue: 2992, damageCosts: 282,  businessExpenses: 0,   totalOverallMade: 2992 },
  { month: '2024-06', totalRevenue: 3406, damageCosts: 419,  businessExpenses: 256, totalOverallMade: 3569 },
  { month: '2024-07', totalRevenue: 4414, damageCosts: 1464, businessExpenses: 0,   totalOverallMade: 5878 },
  // === 2024 Aug - 2026 Jan: damage-only overlay (totalRevenue=0 sentinel) ===
  // These months have tracked rental data in v1 Postgres / v2 reservations table.
  // Only the damage overlay needs to be applied; do NOT override reservation revenue.
  { month: '2024-08', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-09', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-10', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-11', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2024-12', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-01', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-02', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-03', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-04', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-05', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-06', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-07', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-08', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-09', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-10', totalRevenue: 0, damageCosts: 389, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-11', totalRevenue: 0, damageCosts: 388, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2025-12', totalRevenue: 0, damageCosts: 388, businessExpenses: 0, totalOverallMade: 0 },
  { month: '2026-01', totalRevenue: 0, damageCosts: 388, businessExpenses: 0, totalOverallMade: 0 },
];

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
    if (lines[i].trim().startsWith('{') || lines[i].trim().startsWith('[') || lines[i].trim().startsWith('null')) {
      jsonStart = i;
      break;
    }
  }
  const jsonText = jsonStart >= 0 ? lines.slice(jsonStart).join('\n') : out;
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    return null;
  }
}

console.log(`Migrating ${HISTORICAL_REVENUE.length} months to historical_revenue table...`);

let inserted = 0;
let skipped = 0;
let errors = 0;

for (const row of HISTORICAL_REVENUE) {
  try {
    const result = runConvex('historical_revenue:upsertMonth', {
      month: row.month,
      total_revenue_gbp: row.totalRevenue,
      damage_costs_gbp: row.damageCosts,
      business_expenses_gbp: row.businessExpenses,
      total_overall_made_gbp: row.totalOverallMade,
      source: 'v1-historical-static',
    });
    if (result && result.status === 'skipped') {
      skipped++;
    } else {
      inserted++;
    }
    process.stdout.write('.');
  } catch (err) {
    console.error(`\nError for ${row.month}:`, err.message);
    errors++;
  }
}

console.log(`\n\nDone. inserted=${inserted} skipped=${skipped} errors=${errors}`);

// Validate
const total = runConvex('historical_revenue:getAll', {});
console.log(`Validation: ${total ? total.length : 'null'} rows in historical_revenue table`);
