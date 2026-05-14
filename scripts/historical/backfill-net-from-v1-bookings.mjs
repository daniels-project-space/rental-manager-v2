#!/usr/bin/env node
/**
 * Backfill V2 reservations' net_to_owner_gbp from V1's booking table
 * (sum-of-line-items per rental_id), correcting an earlier import that
 * sourced from V1's `rental` table (one price per rental).
 *
 * Usage:
 *   node scripts/historical/backfill-net-from-v1-bookings.mjs [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--dry-run]
 *
 * Defaults: --from=2025-10-01 --to=2026-05-01 (Oct 2025 → Apr 2026 inclusive).
 *
 * Pre-reqs:
 *   - V1 postgres reachable at $V1_DATABASE_URL (defaults to
 *     postgresql://ai:ai@localhost:5432/rental_manager)
 *   - $NEXT_PUBLIC_CONVEX_URL set (or read from .env.local)
 *   - $CONVEX_DEPLOY_KEY set OR you're already logged into `npx convex` from this repo
 *
 * The script:
 *   1. Reads V1 bookings status IN ('completed','confirmed') in date window.
 *   2. SUMs net_profit and revenue per rental_id (handles V1's per-item rows).
 *   3. For each rental_id, calls admin_backfill_net.patchNetByV1RentalId.
 *   4. Reports per-rental delta + monthly totals.
 *
 * Does NOT (yet) insert missing rentals — those are listed at the end with a
 * "--enable-insert" hint.
 */
import pg from "pg";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

function loadDotEnvLocal() {
  const path = resolve(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    if (process.env[key]) continue;
    let value = m[2].trim();
    // strip trailing # comments
    const hashIdx = value.indexOf(" #");
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnvLocal();

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const found = argv.find((a) => a.startsWith(`--${k}=`));
  return found ? found.split("=")[1] : d;
};
const FROM = arg("from", "2025-10-01");
const TO = arg("to", "2026-05-01");
const DRY = argv.includes("--dry-run");
const DO_INSERT = argv.includes("--enable-insert");

const V1_DSN = process.env.V1_DATABASE_URL ?? "postgresql://ai:ai@localhost:5432/rental_manager";
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!CONVEX_URL) throw new Error("NEXT_PUBLIC_CONVEX_URL not set (check .env.local)");

console.log(`→ V1 postgres: ${V1_DSN.replace(/:[^:@]+@/, ":***@")}`);
console.log(`→ V2 convex: ${CONVEX_URL}`);
console.log(`→ Date window: ${FROM} → ${TO} (pickup_date OR start_date)`);
console.log(`→ Dry run: ${DRY}`);
console.log(`→ Insert missing: ${DO_INSERT}`);

const pgClient = new pg.Client({ connectionString: V1_DSN });
await pgClient.connect();

const sql = `
  SELECT
    rental_id,
    LOWER(account)                                    AS account,
    MIN(COALESCE(pickup_date, start_date))::date::text AS pickup_date,
    MIN(start_date)::date::text                        AS start_date,
    MAX(end_date)::date::text                          AS end_date,
    MIN(renter_name)                                   AS renter_name,
    COUNT(*)                                           AS line_items,
    ROUND(SUM(COALESCE(net_profit, 0))::numeric, 2)    AS net_sum,
    ROUND(SUM(COALESCE(revenue, 0))::numeric, 2)       AS gross_sum,
    array_agg(DISTINCT item_name) FILTER (WHERE item_name IS NOT NULL) AS items
  FROM booking
  WHERE COALESCE(pickup_date, start_date) >= $1
    AND COALESCE(pickup_date, start_date) < $2
    AND status IN ('completed', 'confirmed')
  GROUP BY rental_id, LOWER(account)
  ORDER BY MIN(COALESCE(pickup_date, start_date))
`;
const { rows } = await pgClient.query(sql, [FROM, TO]);
console.log(`→ V1 rentals to process: ${rows.length}`);

const convex = new ConvexHttpClient(CONVEX_URL);

const byMonth = new Map();
let patched = 0;
let unchanged = 0;
let notFound = 0;
let inserted = 0;
let totalDelta = 0;
const missing = [];

for (const r of rows) {
  const month = r.pickup_date.slice(0, 7);
  const bucket = byMonth.get(month) ?? { net: 0, count: 0, delta: 0 };
  bucket.net += Number(r.net_sum);
  bucket.count += 1;
  byMonth.set(month, bucket);

  if (DRY) {
    console.log(`  DRY ${r.rental_id} ${r.account} ${r.pickup_date} £${r.net_sum} (lines=${r.line_items})`);
    continue;
  }

  try {
    const res = await convex.mutation(
      "admin_backfill_net:patchNetByV1RentalId",
      {
        v1_rental_id: r.rental_id,
        correct_net_to_owner_gbp: Number(r.net_sum),
        correct_gross_paid_gbp: Number(r.gross_sum),
      },
    );
    if (res.action === "patched") {
      patched++;
      totalDelta += res.delta;
      bucket.delta += res.delta;
      console.log(`  PATCH ${r.rental_id} ${r.pickup_date} £${res.oldNet.toFixed(2)} → £${res.newNet.toFixed(2)} (Δ +£${res.delta.toFixed(2)})`);
    } else if (res.action === "unchanged") {
      unchanged++;
    } else if (res.action === "refused_would_reduce") {
      console.log(`  KEEP  ${r.rental_id} ${r.pickup_date} V2=£${res.oldNet.toFixed(2)} > V1=£${res.newNet.toFixed(2)} (V2 is authoritative)`);
    } else if (res.action === "not_found") {
      notFound++;
      missing.push(r);
    }
  } catch (e) {
    console.error(`  ERROR ${r.rental_id}: ${e.message}`);
  }
}

// Optionally insert missing rentals.
if (DO_INSERT && missing.length > 0 && !DRY) {
  console.log(`\n→ Inserting ${missing.length} rentals V2 was missing...`);
  for (const r of missing) {
    try {
      const res = await convex.mutation(
        "admin_backfill_net:insertMissingFromV1",
        {
          v1_rental_id: r.rental_id,
          account_slug: r.account,
          start_date: r.start_date,
          end_date: r.end_date,
          pickup_date: r.pickup_date,
          net_to_owner_gbp: Number(r.net_sum),
          gross_paid_gbp: Number(r.gross_sum),
          item_names: r.items ?? [],
          renter_name: r.renter_name ?? undefined,
        },
      );
      if (res.action === "inserted") {
        inserted++;
        console.log(`  INSERT ${r.rental_id} ${r.pickup_date} £${r.net_sum}`);
      }
    } catch (e) {
      console.error(`  ERROR ${r.rental_id}: ${e.message}`);
    }
  }
}

console.log(`\n=== Summary ===`);
console.log(`Patched:   ${patched}`);
console.log(`Unchanged: ${unchanged}`);
console.log(`Inserted:  ${inserted}`);
console.log(`Missing in V2 (not inserted): ${missing.length - inserted}`);
console.log(`Total delta added to V2: £${totalDelta.toFixed(2)}`);
console.log(`\nPer-month V1 totals vs delta:`);
const sortedMonths = [...byMonth.keys()].sort();
for (const m of sortedMonths) {
  const b = byMonth.get(m);
  console.log(`  ${m}: V1 net £${b.net.toFixed(2)} across ${b.count} rentals, V2 patched by £${b.delta.toFixed(2)}`);
}
if (missing.length > 0 && !DO_INSERT) {
  console.log(`\nRe-run with --enable-insert to insert the ${missing.length} missing rentals.`);
}

await pgClient.end();
process.exit(0);
