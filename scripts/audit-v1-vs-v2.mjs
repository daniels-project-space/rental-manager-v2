// Phase 2.A audit: pick 20 random eligible v1 rentals; assert v2 reservation
// matches on gross/net/dates/duration/items_count and has calendar_holds.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
const { Client } = pg;

const PG_URL = 'postgresql://ai:ai@localhost:5432/rental_manager';
const REPO = '/home/ubuntu/rental-manager-v2';

function runConvex(fn, args) {
  const r = spawnSync('npx', ['convex', 'run', fn, JSON.stringify(args)], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`convex ${fn} failed: ${r.stderr}`);
  const out = r.stdout.trim();
  // Find first '{' or '[' that begins balanced JSON to end of output
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '{' || c === '[') {
      const candidate = out.slice(i);
      try { return JSON.parse(candidate); } catch (_) { /* try next */ }
    }
  }
  throw new Error(`could not parse convex output: ${out.slice(0, 300)}`);
}

function durDays(s, e) {
  return Math.max(1, Math.round((new Date(e).getTime() - new Date(s).getTime()) / 86400000) + 1);
}
function isoD(d) { return new Date(d).toISOString().slice(0, 10); }

const main = async () => {
  const pgc = new Client({ connectionString: PG_URL });
  await pgc.connect();
  // Pick 20 random eligible rentals (stable random via SETSEED)
  await pgc.query("SELECT setseed(0.42)");
  const rows = (await pgc.query(`
    SELECT r.id, r.account, r.status, r.start_date, r.end_date,
           r.renter_price, r.rental_price, l.renter_profile_id
    FROM rental r
    LEFT JOIN rental_renter_link l ON l.rental_id = r.id
    WHERE r.status IN ('confirmed','completed')
      AND r.renter_price IS NOT NULL
      AND r.start_date IS NOT NULL AND r.end_date IS NOT NULL
    ORDER BY random()
    LIMIT 20
  `)).rows;

  const v1RentalIds = rows.map((r) => r.id);
  const v2 = runConvex('seed/data:fetchReservationsByV1Ids', { v1_rental_ids: v1RentalIds });
  const v2By = new Map(v2.map((x) => [x.v1_rental_id, x]));

  // Pre-load extracteditem counts
  const extCount = (await pgc.query(`
    SELECT rental_id, COUNT(*)::int AS n FROM extracteditem
    WHERE rental_id = ANY($1::text[]) GROUP BY rental_id
  `, [v1RentalIds])).rows.reduce((acc, r) => (acc[r.rental_id] = r.n, acc), {});

  let pass = 0;
  const failures = [];
  const details = [];
  for (const r of rows) {
    const v2r = v2By.get(r.id);
    if (!v2r || !v2r.found) {
      failures.push({ v1_rental_id: r.id, reason: 'v2_not_found' });
      continue;
    }
    const expected = {
      account_slug: r.account,
      start_date: isoD(r.start_date),
      end_date: isoD(r.end_date),
      duration_days: durDays(r.start_date, r.end_date),
      gross_paid_gbp: Math.round(r.renter_price * 100) / 100,
      net_to_owner_gbp: Math.round(r.rental_price * 100) / 100,
      status: r.status,
      items_count: extCount[r.id] ?? 0,
    };
    const actual = {
      account_slug: v2r.account_slug,
      start_date: v2r.start_date,
      end_date: v2r.end_date,
      duration_days: v2r.duration_days,
      gross_paid_gbp: v2r.gross_paid_gbp,
      net_to_owner_gbp: v2r.net_to_owner_gbp,
      status: v2r.status,
      items_count: v2r.items_count,
    };
    const diffs = {};
    for (const k of Object.keys(expected)) {
      if (expected[k] !== actual[k]) diffs[k] = { v1: expected[k], v2: actual[k] };
    }
    // Renter link check
    if (r.renter_profile_id) {
      const renter = runConvex('seed/data:fetchRenterByV1Id', { v1_renter_profile_id: r.renter_profile_id });
      if (!renter) diffs.renter_link = { v1: r.renter_profile_id, v2: 'not_found' };
      else if (v2r.renter_id !== renter._id) diffs.renter_link_mismatch = { expected: renter._id, actual: v2r.renter_id };
    }
    // Calendar hold check (only if items present)
    if (expected.items_count > 0 && (r.status === 'confirmed' || r.status === 'completed')) {
      // Expected holds = items_count * dates (best-effort; some items may unmatch)
      // Just assert >0 holds
      if (v2r.calendar_holds_count === 0) {
        diffs.calendar_holds = { v1_items: expected.items_count, v2_holds: 0 };
      }
    }
    if (Object.keys(diffs).length > 0) {
      failures.push({ v1_rental_id: r.id, diffs });
      details.push({ v1_rental_id: r.id, status: 'FAIL', expected, actual, diffs });
    } else {
      pass += 1;
      details.push({ v1_rental_id: r.id, status: 'PASS', expected, actual, calendar_holds: v2r.calendar_holds_count });
    }
  }

  await pgc.end();
  const result = {
    sample_count: rows.length,
    pass,
    fail: rows.length - pass,
    failures,
    details,
  };
  writeFileSync('/tmp/p2a_audit_result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass, fail: rows.length - pass, sample_count: rows.length }, null, 2));
  if (failures.length > 0) {
    console.log('FAILURES:', JSON.stringify(failures.slice(0, 5), null, 2));
    process.exit(3);
  }
};
main().catch((e) => { console.error(e); process.exit(2); });
