#!/usr/bin/env node
/**
 * backfill-leo-from-hygglo-direct.mjs
 *
 * v1's Postgres only imported 20 completed leo rentals (~£2.5k net) but
 * leo actually has many more completed rentals on Hygglo. This script
 * paginates Hygglo /v4/my/orders?filter=completed exhaustively, groups
 * by month, and PATCHes leo_revenue_gbp on historical_revenue rows
 * (preserves dbcinema/daniel/vertus values).
 *
 * Vault: HYGGLO_LEO_EMAIL / HYGGLO_LEO_PASSWORD from project-hub.
 * Convex prod: exciting-lion-29.
 *
 * Usage:
 *   node scripts/historical/backfill-leo-from-hygglo-direct.mjs [--dry-run]
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const VAULT_URL  = "https://fantastic-roadrunner-485.convex.cloud/api/query";
const CONVEX_URL = "https://exciting-lion-29.convex.cloud";
const API_BASE   = "https://api.hygglo.com/api";
const CLIENT_ID     = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";
const NET_FACTOR = 0.64; // v1 convention: gross × 0.64 = take-home
const SLEEP_MS = 50;
const DRY_RUN = process.argv.includes("--dry-run");

const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => (s ? s.slice(0, 8) + "***" : "(empty)");

// ── Step 1: Fetch HYGGLO_LEO_* + CONVEX_ACCESS_TOKEN from vault ─────────────
log("[backfill-leo] Step 1: Fetching secrets from vault...");

function vaultByService(service) {
  const raw = execSync(
    `curl -sS '${VAULT_URL}' -H 'Content-Type: application/json' ` +
      `-d '{"path":"secrets:listByService","args":{"service":"${service}"},"format":"json"}'`,
    { encoding: "utf8" }
  );
  const j = JSON.parse(raw);
  if (j.status !== "success") throw new Error(`Vault failed: ${raw}`);
  return j.value ?? [];
}

let leoEmail, leoPassword, convexPat;
try {
  // Try multiple service names — secrets vault uses tags not strict
  const services = ["hygglo", "rental-manager", "rental", "convex"];
  const collected = {};
  for (const svc of services) {
    try {
      const rows = vaultByService(svc);
      for (const r of rows) collected[r.keyName] = r.value;
    } catch {/* ignore */}
  }
  leoEmail    = collected["HYGGLO_LEO_EMAIL"];
  leoPassword = collected["HYGGLO_LEO_PASSWORD"];
  convexPat   = collected["CONVEX_ACCESS_TOKEN"];
  if (!leoEmail || !leoPassword) {
    // Fallback: listAll
    const raw = execSync(
      `curl -sS '${VAULT_URL}' -H 'Content-Type: application/json' ` +
        `-d '{"path":"secrets:listAll","args":{},"format":"json"}'`,
      { encoding: "utf8" }
    );
    const j = JSON.parse(raw);
    if (j.status === "success") {
      for (const r of j.value ?? []) {
        if (r.keyName === "HYGGLO_LEO_EMAIL") leoEmail = r.value;
        if (r.keyName === "HYGGLO_LEO_PASSWORD") leoPassword = r.value;
        if (r.keyName === "CONVEX_ACCESS_TOKEN") convexPat = r.value;
      }
    }
  }
  if (!leoEmail) throw new Error("HYGGLO_LEO_EMAIL not in vault");
  if (!leoPassword) throw new Error("HYGGLO_LEO_PASSWORD not in vault");
  if (!convexPat) throw new Error("CONVEX_ACCESS_TOKEN not in vault");
  log(`[backfill-leo] vault OK (email=${mask(leoEmail)}, pat.len=${convexPat.length})`);
} catch (e) {
  log("[backfill-leo] VAULT ERROR:", e.message);
  process.exit(1);
}

// ── Step 2: OAuth login ─────────────────────────────────────────────────────
log("[backfill-leo] Step 2: Hygglo OAuth login for leo...");
let leoToken;
try {
  const body = new URLSearchParams({
    grant_type: "password",
    username: leoEmail,
    password: leoPassword,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(`${API_BASE}/token?country=${COUNTRY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Client": "Hygglo-web",
      Origin: "https://www.hygglo.com",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Auth ${res.status}: ${await res.text()}`);
  const j = await res.json();
  leoToken = j.access_token;
  if (!leoToken) throw new Error("no access_token in response");
  log(`[backfill-leo] HYGGLO_LEO_LOGIN: success (token=${mask(leoToken)})`);
} catch (e) {
  log("[backfill-leo] HYGGLO_LEO_LOGIN: failed —", e.message);
  process.exit(2);
}

const hdrs = () => ({
  Authorization: `Bearer ${leoToken}`,
  Accept: "application/json",
  Country: COUNTRY,
  "User-Client": "Hygglo-web",
});

// ── Step 3: Probe earnings-style endpoints ─────────────────────────────────
log("[backfill-leo] Step 3: Probing earnings endpoints...");
const probeResults = {};
const probes = [
  "/v4/my/earnings",
  "/v4/my/payouts",
  "/v4/my/stats",
  "/v4/my/dashboard",
  "/v4/my/profile",
  "/v4/my/wallet",
  "/v4/my/summary",
];
for (const path of probes) {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: hdrs() });
    if (res.ok) {
      const txt = await res.text();
      probeResults[path] = { status: 200, len: txt.length, preview: txt.substring(0, 400) };
    } else {
      probeResults[path] = { status: res.status };
    }
  } catch (e) {
    probeResults[path] = { error: e.message };
  }
  await sleep(SLEEP_MS);
}

// ── Step 4: Paginate completed orders exhaustively ─────────────────────────
log("[backfill-leo] Step 4: Paginating filter=completed...");
const completedOrders = [];
let offset = 0;
const LIMIT = 50;
let pages = 0;
while (true) {
  const url = `${API_BASE}/v4/my/orders?role=owner&filter=completed&sort=latest-activity&offset=${offset}&limit=${LIMIT}`;
  const res = await fetch(url, { headers: hdrs() });
  if (!res.ok) {
    log(`  page offset=${offset} → ${res.status}, stopping`);
    break;
  }
  const data = await res.json();
  const list = Array.isArray(data) ? data : (data.items ?? data.results ?? data.data ?? []);
  pages++;
  completedOrders.push(...list);
  log(`  page ${pages} offset=${offset} → ${list.length} orders (cum=${completedOrders.length})`);
  if (list.length < LIMIT) break;
  offset += LIMIT;
  await sleep(SLEEP_MS);
  if (pages > 80) { log("  safety break at 80 pages"); break; }
}
log(`[backfill-leo] PAGINATION: ${pages} pages, ${completedOrders.length} completed orders`);

// ── Step 5: Fetch detail for each completed order ──────────────────────────
log("[backfill-leo] Step 5: Fetching order details...");
const details = [];
let i = 0;
for (const o of completedOrders) {
  i++;
  if (i % 25 === 0) log(`  detail ${i}/${completedOrders.length}`);
  try {
    const r = await fetch(`${API_BASE}/v4/my/orders/${o.id}?timezone=Europe/London`, { headers: hdrs() });
    if (r.ok) {
      const d = await r.json();
      // Identify active step
      const activeStep = (d.detail?.steps ?? d.steps ?? []).find((s) => s.active);
      const stepKey = activeStep?.key ?? null;
      // Dates
      const start = d.rentalPeriod?.startDateUTC?.slice(0, 10)
        ?? d.rentalPeriod?.start?.slice(0, 10)
        ?? d.start_date
        ?? null;
      const end = d.rentalPeriod?.endDateUTC?.slice(0, 10)
        ?? d.rentalPeriod?.end?.slice(0, 10)
        ?? d.end_date
        ?? null;
      const gross = d.price?.breakdown?.totalPrice?.amount
        ?? d.price?.total
        ?? d.price?.amount
        ?? d.rental_price
        ?? null;
      const lenderEarnings = d.price?.breakdown?.lenderEarnings?.amount
        ?? d.price?.ownerEarnings
        ?? null;
      const renter = d.users?.otherPart?.name
        ?? d.users?.otherPart?.displayName
        ?? d.renter?.display_name
        ?? null;
      details.push({
        order_id: o.id, step_key: stepKey, start, end, gross, lenderEarnings, renter,
      });
    }
  } catch (e) {
    log(`  err detail ${o.id}: ${e.message}`);
  }
  await sleep(SLEEP_MS);
}
log(`[backfill-leo] details fetched: ${details.length}`);

// ── Step 6: Filter to RETURNED/REVIEWED, aggregate by month ────────────────
const validSteps = new Set(["RETURNED", "REVIEWED", "COMPLETED", "RETURN_CONFIRMED"]);
const usable = details.filter((d) => {
  // Accept even if step_key missing — Hygglo's filter=completed already selects completed.
  // But prefer step in valid set if present.
  if (!d.start) return false;
  if (d.gross == null) return false;
  if (d.step_key && !validSteps.has(d.step_key.toUpperCase())) return false;
  return true;
});
log(`[backfill-leo] usable orders (have start+gross): ${usable.length}/${details.length}`);

const byMonth = new Map(); // YYYY-MM -> { count, gross, net }
for (const u of usable) {
  const month = u.start.slice(0, 7);
  const cur = byMonth.get(month) ?? { count: 0, gross: 0, net: 0, orders: [] };
  cur.count += 1;
  cur.gross += Number(u.gross);
  // Prefer authoritative lenderEarnings if present, else gross × 0.64
  if (u.lenderEarnings != null) {
    cur.net += Number(u.lenderEarnings);
  } else {
    cur.net += Number(u.gross) * NET_FACTOR;
  }
  cur.orders.push(u.order_id);
  byMonth.set(month, cur);
}

const sortedMonths = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
let totalGross = 0, totalNet = 0;
for (const [, v] of sortedMonths) { totalGross += v.gross; totalNet += v.net; }

const oldestStart = usable.map(u => u.start).sort()[0] ?? null;
const newestStart = usable.map(u => u.start).sort().reverse()[0] ?? null;

// Snapshot to /tmp for audit
const snapshotPath = `/tmp/leo-hygglo-direct-${new Date().toISOString().slice(0,10).replace(/-/g,"")}.json`;
writeFileSync(snapshotPath, JSON.stringify({
  fetched_at: new Date().toISOString(),
  pages, total_completed: completedOrders.length, usable: usable.length,
  date_range: { oldest: oldestStart, newest: newestStart },
  probe_results: probeResults,
  monthly: Object.fromEntries(sortedMonths.map(([m, v]) => [m, { count: v.count, gross: v.gross, net: v.net }])),
  totals: { gross: totalGross, net: totalNet },
}, null, 2));
log(`[backfill-leo] snapshot → ${snapshotPath}`);

// ── Step 7: Patch historical_revenue.leo_revenue_gbp per month ─────────────
if (DRY_RUN) {
  log("[backfill-leo] DRY-RUN — would patch:");
  for (const [m, v] of sortedMonths) {
    log(`  ${m}: count=${v.count} gross=£${v.gross.toFixed(2)} net=£${v.net.toFixed(2)}`);
  }
  process.exit(0);
}

log("[backfill-leo] Step 7: Patching historical_revenue.leo_revenue_gbp...");
let patched = 0, errors = 0;
for (const [month, v] of sortedMonths) {
  const body = JSON.stringify({
    path: "historical_revenue:patchLeoMonth",
    args: { month, leo_revenue_gbp: Number(v.net.toFixed(2)) },
    format: "json",
  });
  try {
    const raw = execSync(
      `curl -sS -X POST '${CONVEX_URL}/api/mutation' ` +
        `-H 'Content-Type: application/json' ` +
        `-H 'Authorization: Convex ${convexPat}' ` +
        `-d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: "utf8" }
    );
    const res = JSON.parse(raw);
    if (res.status !== "success") {
      log(`  WARN ${month}: ${raw.trim()}`);
      errors++;
    } else {
      patched++;
      log(`  ${res.value?.action ?? "ok"} ${month} → leo=£${v.net.toFixed(2)} (count=${v.count})`);
    }
  } catch (e) {
    log(`  ERROR ${month}: ${e.message}`);
    errors++;
  }
  await sleep(SLEEP_MS);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log("HYGGLO_LEO_LOGIN: success");
console.log(`TOKEN_MASKED: ${mask(leoToken)}`);
console.log("");
console.log("PAGINATION_RESULT:");
console.log(`  Pages fetched: ${pages}`);
console.log(`  Total completed leo orders: ${completedOrders.length}`);
console.log(`  Usable (returned/reviewed + dates + gross): ${usable.length}`);
console.log(`  Date range: ${oldestStart} → ${newestStart}`);
console.log("");
console.log("EARNINGS_ENDPOINT_PROBE:");
for (const [p, r] of Object.entries(probeResults)) {
  if (r.status === 200) console.log(`  ${p}: 200 (len=${r.len}) preview=${(r.preview ?? "").substring(0,160).replace(/\n/g," ")}`);
  else console.log(`  ${p}: ${r.status ?? r.error}`);
}
console.log("");
console.log("PER_MONTH_BREAKDOWN (top 10 by net):");
const top10 = [...sortedMonths].sort((a, b) => b[1].net - a[1].net).slice(0, 10);
for (const [m, v] of top10) console.log(`  ${m}: count=${v.count}, gross=£${v.gross.toFixed(2)}, net=£${v.net.toFixed(2)}`);
console.log("");
console.log("TOTAL_LEO_LIFETIME:");
console.log(`  Gross (with fees): £${totalGross.toFixed(2)}`);
console.log(`  Net (lenderEarnings or ×0.64): £${totalNet.toFixed(2)}`);
console.log("");
console.log("COMPARISON:");
console.log(`  v1 Postgres had: £2,577 net (only 20 orders)`);
console.log(`  Hygglo direct:   £${totalNet.toFixed(2)} net (${usable.length} usable)`);
console.log(`  Gap recovered:   £${(totalNet - 2577).toFixed(2)}`);
console.log("");
console.log("BACKFILL_RESULT:");
console.log(`  Months patched: ${patched}`);
console.log(`  Errors: ${errors}`);
console.log(`  Total leo added to historical_revenue: £${totalNet.toFixed(2)}`);
console.log("");
console.log(`SNAPSHOT: ${snapshotPath}`);
console.log(`VERDICT: ${errors === 0 ? "leo-recovered" : "partial"}`);
