// BF-06: backfill reservations.pickup_date from v1 Postgres booking.pickup_date.
// Revenue attribution uses pickup_date ?? start_date; this populates the actual
// gear-handoff date (~227 bookings with it set; 29 differ from start_date by +-1 day).
// Run once: node scripts/backfill-pickup-dates.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import pg from "pg";
const { Client } = pg;

const PG_URL = "postgresql://ai:ai@localhost:5432/rental_manager";
const REPO = "/home/ubuntu/rental-manager-v2";
const BATCH = 100;

/** Run a Convex internal function and return parsed JSON result. */
function runConvex(fn, args) {
  const argJson = JSON.stringify(args);
  const r = spawnSync("npx", ["convex", "run", fn, argJson], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`convex ${fn} failed: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n");
  let jsonStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("{") || t.startsWith("[")) { jsonStart = i; break; }
  }
  const jsonText = jsonStart >= 0 ? lines.slice(jsonStart).join("\n") : r.stdout.trim();
  try { return JSON.parse(jsonText); }
  catch (e) { throw new Error(`parse failed for ${fn}: ${r.stdout.slice(0, 500)}`); }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  console.log("[BF-06] start");
  const pgc = new Client({ connectionString: PG_URL });
  await pgc.connect();

  // One pickup_date per rental: earliest confirmed/completed booking pickup_date.
  // Rentals in v1 can have multiple bookings (one per item) sharing the same pickup window.
  const { rows } = await pgc.query(`
    SELECT r.id AS rental_id,
           MIN(b.pickup_date)::date::text AS pickup_date
    FROM rental r
    JOIN booking b ON b.rental_id = r.id
    WHERE b.status IN ('confirmed', 'completed')
      AND b.pickup_date IS NOT NULL
    GROUP BY r.id
    ORDER BY r.id
  `);

  console.log(`[BF-06] v1 rentals with pickup_date: ${rows.length}`);
  await pgc.end();

  let totalUpdated = 0;
  let totalNotFound = 0;
  let totalAlreadySet = 0;
  let batchNum = 0;

  for (const batch of chunk(rows, BATCH)) {
    batchNum++;
    const payload = batch.map((row) => ({
      v1_rental_id: row.rental_id,
      pickup_date: row.pickup_date,
    }));
    const res = runConvex("seed/data:backfillPickupDatesBatch", { rows: payload });
    totalUpdated += res.updated;
    totalNotFound += res.skipped_not_found;
    totalAlreadySet += res.skipped_already_set;
    console.log(
      `[BF-06] batch ${batchNum}: updated=${res.updated} not_found=${res.skipped_not_found} already_set=${res.skipped_already_set}`
    );
  }

  const summary = {
    v1_rentals_with_pickup_date: rows.length,
    total_updated: totalUpdated,
    total_not_found: totalNotFound,
    total_already_set: totalAlreadySet,
  };
  writeFileSync("/tmp/bf06_pickup_dates_log.json", JSON.stringify(summary, null, 2));
  console.log("[BF-06] done", summary);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
