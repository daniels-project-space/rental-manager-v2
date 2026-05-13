#!/usr/bin/env node
/**
 * backfill-dbcinema-from-hygglo-direct.mjs
 *
 * Mirrors backfill-leo-from-hygglo-direct.mjs for the dbcinema account.
 * Adds extra probes for obscure filters + payout-style endpoints, and dumps
 * shape info for any 200-OK endpoint so we can find Hygglo's CANONICAL
 * lifetime earnings figure (closest to Daniel's truth = ~£180k).
 *
 * Vault: HYGGLO_DBCINEMA_EMAIL / HYGGLO_DBCINEMA_PASSWORD from project-hub.
 * Convex prod: exciting-lion-29.
 *
 * Usage:
 *   node scripts/historical/backfill-dbcinema-from-hygglo-direct.mjs [--dry-run]
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const VAULT_URL  = "https://fantastic-roadrunner-485.convex.cloud/api/query";
const CONVEX_URL = "https://exciting-lion-29.convex.cloud";
const API_BASE   = "https://api.hygglo.com/api";
const CLIENT_ID     = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";
const NET_FACTOR = 0.64;
const SLEEP_MS = 40;
const DRY_RUN = process.argv.includes("--dry-run");
const INCLUDE_LEO_RESCRAPE = !process.argv.includes("--skip-leo");

const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mask = (s) => (s ? s.slice(0, 8) + "***" : "(empty)");

// ── Vault ─────────────────────────────────────────────────────
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

log("[backfill-dbc] Step 1: Fetching secrets from vault...");
let dbcEmail, dbcPassword, leoEmail, leoPassword, convexPat;
try {
  const services = ["hygglo", "rental-manager", "rental", "convex"];
  const collected = {};
  for (const svc of services) {
    try {
      const rows = vaultByService(svc);
      for (const r of rows) collected[r.keyName] = r.value;
    } catch {/* ignore */}
  }
  dbcEmail    = collected["HYGGLO_DBCINEMA_EMAIL"];
  dbcPassword = collected["HYGGLO_DBCINEMA_PASSWORD"];
  leoEmail    = collected["HYGGLO_LEO_EMAIL"];
  leoPassword = collected["HYGGLO_LEO_PASSWORD"];
  convexPat   = collected["CONVEX_ACCESS_TOKEN"];
  if (!dbcEmail || !dbcPassword || !convexPat) {
    const raw = execSync(
      `curl -sS '${VAULT_URL}' -H 'Content-Type: application/json' ` +
        `-d '{"path":"secrets:listAll","args":{},"format":"json"}'`,
      { encoding: "utf8" }
    );
    const j = JSON.parse(raw);
    if (j.status === "success") {
      for (const r of j.value ?? []) {
        if (r.keyName === "HYGGLO_DBCINEMA_EMAIL") dbcEmail = r.value;
        if (r.keyName === "HYGGLO_DBCINEMA_PASSWORD") dbcPassword = r.value;
        if (r.keyName === "HYGGLO_LEO_EMAIL") leoEmail = r.value;
        if (r.keyName === "HYGGLO_LEO_PASSWORD") leoPassword = r.value;
        if (r.keyName === "CONVEX_ACCESS_TOKEN") convexPat = r.value;
      }
    }
  }
  if (!dbcEmail) throw new Error("HYGGLO_DBCINEMA_EMAIL not in vault");
  if (!dbcPassword) throw new Error("HYGGLO_DBCINEMA_PASSWORD not in vault");
  if (!convexPat) throw new Error("CONVEX_ACCESS_TOKEN not in vault");
  log(`[backfill-dbc] vault OK (dbc=${mask(dbcEmail)}, leo=${mask(leoEmail||"")}, pat.len=${convexPat.length})`);
} catch (e) {
  log("[backfill-dbc] VAULT ERROR:", e.message);
  process.exit(1);
}

async function hyggloLogin(email, password) {
  const body = new URLSearchParams({
    grant_type: "password",
    username: email,
    password,
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
  if (!j.access_token) throw new Error("no access_token");
  return j.access_token;
}

const hdrs = (tok) => ({
  Authorization: `Bearer ${tok}`,
  Accept: "application/json",
  Country: COUNTRY,
  "User-Client": "Hygglo-web",
});

log("[backfill-dbc] Step 2: OAuth login (dbcinema)...");
let dbcToken;
try {
  dbcToken = await hyggloLogin(dbcEmail, dbcPassword);
  log(`[backfill-dbc] dbcinema token=${mask(dbcToken)}`);
} catch (e) {
  log("[backfill-dbc] dbcinema login failed:", e.message);
  process.exit(2);
}

let leoToken = null;
if (INCLUDE_LEO_RESCRAPE && leoEmail && leoPassword) {
  try {
    leoToken = await hyggloLogin(leoEmail, leoPassword);
    log(`[backfill-dbc] leo token=${mask(leoToken)}`);
  } catch (e) {
    log("[backfill-dbc] leo login failed (continuing without):", e.message);
  }
}

// ── Probe ALL endpoints + obscure filters ─────────────────────────────
async function probeEndpoints(tok, label) {
  log(`[backfill-dbc] Probing endpoints for ${label}...`);
  const probes = [
    "/v4/my/earnings",
    "/v4/my/payouts",
    "/v4/my/stats",
    "/v4/my/dashboard",
    "/v4/my/profile",
    "/v4/my/wallet",
    "/v4/my/summary",
    "/v4/my/transactions",
    "/v4/my/balance",
    "/v4/my/income",
    "/v4/my/reports",
    "/v4/payouts",
    "/v4/payouts?role=owner",
    "/v4/my/payouts?limit=200",
    "/v4/my/payouts?offset=0&limit=100",
  ];
  const out = {};
  for (const path of probes) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers: hdrs(tok) });
      if (res.ok) {
        const txt = await res.text();
        out[path] = { status: 200, len: txt.length, preview: txt.slice(0, 800) };
      } else {
        out[path] = { status: res.status };
      }
    } catch (e) {
      out[path] = { error: e.message };
    }
    await sleep(SLEEP_MS);
  }
  return out;
}

const dbcProbe = await probeEndpoints(dbcToken, "dbcinema");
const leoProbe = leoToken ? await probeEndpoints(leoToken, "leo") : {};

async function probeFilters(tok, label) {
  log(`[backfill-dbc] Probing obscure filters for ${label}...`);
  const filters = ["completed", "archived", "reviewed", "all", "delivered", "returned", "paid", "finished"];
  const out = {};
  for (const f of filters) {
    try {
      const res = await fetch(
        `${API_BASE}/v4/my/orders?role=owner&filter=${f}&sort=latest-activity&offset=0&limit=5`,
        { headers: hdrs(tok) }
      );
      if (res.ok) {
        const j = await res.json();
        const list = Array.isArray(j) ? j : (j.items ?? j.results ?? j.data ?? []);
        out[f] = { status: 200, count_first_page: list.length, sample_id: list[0]?.id ?? null };
      } else {
        out[f] = { status: res.status };
      }
    } catch (e) {
      out[f] = { error: e.message };
    }
    await sleep(SLEEP_MS);
  }
  return out;
}

const dbcFilters = await probeFilters(dbcToken, "dbcinema");
const leoFilters = leoToken ? await probeFilters(leoToken, "leo") : {};

// ── Fetch full payouts pagination if /v4/my/payouts 200s ─────────────────
async function fetchAllPayouts(tok, label) {
  log(`[backfill-dbc] Fetching ALL payouts for ${label}...`);
  const out = [];
  let offset = 0;
  const LIMIT = 100;
  let pages = 0;
  while (true) {
    const url = `${API_BASE}/v4/my/payouts?offset=${offset}&limit=${LIMIT}`;
    const res = await fetch(url, { headers: hdrs(tok) });
    if (!res.ok) { log(`  payouts ${label} offset=${offset} -> ${res.status}, stopping`); break; }
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.items ?? j.results ?? j.data ?? j.payouts ?? j.transactions ?? []);
    pages++;
    out.push(...list);
    log(`  payouts ${label} page ${pages} offset=${offset} → ${list.length} (cum=${out.length})`);
    if (list.length < LIMIT) break;
    offset += LIMIT;
    await sleep(SLEEP_MS);
    if (pages > 100) { log("  safety break"); break; }
  }
  return out;
}

const dbcPayouts = await fetchAllPayouts(dbcToken, "dbcinema");
const leoPayouts = leoToken ? await fetchAllPayouts(leoToken, "leo") : [];

function sumPayouts(payouts, label) {
  if (payouts.length === 0) return { sum: 0, count: 0, fields: [] };
  const fieldsSet = new Set();
  for (const p of payouts.slice(0, 5)) Object.keys(p ?? {}).forEach(k => fieldsSet.add(k));
  let sum = 0, count = 0;
  for (const p of payouts) {
    const v = p?.amount?.amount ?? p?.amount ?? p?.value ?? p?.total ?? p?.credit ?? p?.payout?.amount ?? null;
    if (v != null && !Number.isNaN(Number(v))) {
      const n = Number(v);
      if (n > 0) { sum += n; count++; }
    }
  }
  log(`[backfill-dbc] payouts ${label}: ${payouts.length} rows, sum_positive=${sum.toFixed(2)} (count=${count}), fields=${[...fieldsSet].join(",")}`);
  return { sum, count, fields: [...fieldsSet], sample: payouts[0] ?? null };
}
const dbcPayoutSummary = sumPayouts(dbcPayouts, "dbcinema");
const leoPayoutSummary = sumPayouts(leoPayouts, "leo");

// ── Paginate completed orders (dbcinema) ─────────────────────────────────
log("[backfill-dbc] Step 4: Paginating dbcinema filter=completed...");
async function paginateCompleted(tok, label) {
  const out = [];
  let offset = 0;
  const LIMIT = 50;
  let pages = 0;
  while (true) {
    const url = `${API_BASE}/v4/my/orders?role=owner&filter=completed&sort=latest-activity&offset=${offset}&limit=${LIMIT}`;
    const res = await fetch(url, { headers: hdrs(tok) });
    if (!res.ok) { log(`  page ${label} offset=${offset} -> ${res.status}, stopping`); break; }
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.items ?? j.results ?? j.data ?? []);
    pages++;
    out.push(...list);
    log(`  ${label} page ${pages} offset=${offset} → ${list.length} (cum=${out.length})`);
    if (list.length < LIMIT) break;
    offset += LIMIT;
    await sleep(SLEEP_MS);
    if (pages > 120) { log("  safety break"); break; }
  }
  return { pages, list: out };
}
const dbcPage = await paginateCompleted(dbcToken, "dbcinema");
const leoPage = leoToken ? await paginateCompleted(leoToken, "leo") : { pages: 0, list: [] };
log(`[backfill-dbc] dbcinema completed: ${dbcPage.list.length} orders in ${dbcPage.pages} pages`);
log(`[backfill-dbc] leo completed (rescrape): ${leoPage.list.length} orders in ${leoPage.pages} pages`);

// ── Fetch order details (dbcinema only — leo already done) ────────────────
log("[backfill-dbc] Step 5: Fetching order details (dbcinema)...");
async function fetchDetails(orders, tok, label) {
  const details = [];
  let i = 0;
  for (const o of orders) {
    i++;
    if (i % 50 === 0) log(`  ${label} detail ${i}/${orders.length}`);
    try {
      const r = await fetch(`${API_BASE}/v4/my/orders/${o.id}?timezone=Europe/London`, { headers: hdrs(tok) });
      if (r.ok) {
        const d = await r.json();
        const activeStep = (d.detail?.steps ?? d.steps ?? []).find((s) => s.active);
        const stepKey = activeStep?.key ?? null;
        const start = d.rentalPeriod?.startDateUTC?.slice(0, 10)
          ?? d.rentalPeriod?.start?.slice(0, 10)
          ?? d.start_date ?? null;
        const end = d.rentalPeriod?.endDateUTC?.slice(0, 10)
          ?? d.rentalPeriod?.end?.slice(0, 10)
          ?? d.end_date ?? null;
        const gross = d.price?.breakdown?.totalPrice?.amount
          ?? d.price?.total ?? d.price?.amount ?? d.rental_price ?? null;
        const lenderEarnings = d.price?.breakdown?.lenderEarnings?.amount
          ?? d.price?.ownerEarnings ?? null;
        details.push({ order_id: o.id, step_key: stepKey, start, end, gross, lenderEarnings });
      }
    } catch (e) {
      log(`  err ${label} detail ${o.id}: ${e.message}`);
    }
    await sleep(SLEEP_MS);
  }
  return details;
}
const dbcDetails = await fetchDetails(dbcPage.list, dbcToken, "dbcinema");
log(`[backfill-dbc] dbcinema details fetched: ${dbcDetails.length}`);

const validSteps = new Set(["RETURNED", "REVIEWED", "COMPLETED", "RETURN_CONFIRMED"]);
function aggregateByMonth(details) {
  const usable = details.filter((d) => {
    if (!d.start) return false;
    if (d.gross == null) return false;
    if (d.step_key && !validSteps.has(d.step_key.toUpperCase())) return false;
    return true;
  });
  const byMonth = new Map();
  for (const u of usable) {
    const month = u.start.slice(0, 7);
    const cur = byMonth.get(month) ?? { count: 0, gross: 0, net: 0, orders: [] };
    cur.count += 1;
    cur.gross += Number(u.gross);
    if (u.lenderEarnings != null) cur.net += Number(u.lenderEarnings);
    else cur.net += Number(u.gross) * NET_FACTOR;
    cur.orders.push(u.order_id);
    byMonth.set(month, cur);
  }
  return { usable, byMonth };
}
const dbcAgg = aggregateByMonth(dbcDetails);
const dbcSortedMonths = [...dbcAgg.byMonth.entries()].sort(([a],[b]) => a.localeCompare(b));
let dbcGross = 0, dbcNet = 0;
for (const [,v] of dbcSortedMonths) { dbcGross += v.gross; dbcNet += v.net; }
log(`[backfill-dbc] dbcinema usable=${dbcAgg.usable.length}/${dbcDetails.length} gross=£${dbcGross.toFixed(2)} net=£${dbcNet.toFixed(2)}`);

// ── Snapshot ───────────────────────────────────────────────────────────
const snapshotPath = `/tmp/dbcinema-hygglo-direct-${new Date().toISOString().slice(0,10).replace(/-/g,"")}.json`;
writeFileSync(snapshotPath, JSON.stringify({
  fetched_at: new Date().toISOString(),
  dbcinema: {
    pages: dbcPage.pages, total_completed: dbcPage.list.length,
    usable: dbcAgg.usable.length, gross: dbcGross, net: dbcNet,
    monthly: Object.fromEntries(dbcSortedMonths.map(([m,v]) => [m,{count:v.count,gross:v.gross,net:v.net}])),
  },
  leo_rescrape: leoToken ? {
    pages: leoPage.pages, total_completed: leoPage.list.length,
    sample_ids: leoPage.list.slice(0,5).map(o => o.id),
  } : null,
  probes_dbcinema: dbcProbe,
  probes_leo: leoProbe,
  filters_dbcinema: dbcFilters,
  filters_leo: leoFilters,
  payouts_dbcinema: dbcPayoutSummary,
  payouts_leo: leoPayoutSummary,
}, null, 2));
log(`[backfill-dbc] snapshot → ${snapshotPath}`);

// ── Patch dbcinema_revenue_gbp per month ──────────────────────────────────
let patched = 0, errors = 0;
if (DRY_RUN) {
  log("[backfill-dbc] DRY-RUN — would patch:");
  for (const [m, v] of dbcSortedMonths) log(`  ${m}: count=${v.count} gross=£${v.gross.toFixed(2)} net=£${v.net.toFixed(2)}`);
} else {
  log("[backfill-dbc] Step 7: Patching historical_revenue.dbcinema_revenue_gbp...");
  for (const [month, v] of dbcSortedMonths) {
    const body = JSON.stringify({
      path: "historical_revenue:patchDbcinemaMonth",
      args: { month, dbcinema_revenue_gbp: Number(v.net.toFixed(2)), source: "hygglo-direct-dbcinema-rescrape" },
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
      if (res.status !== "success") { log(`  WARN ${month}: ${raw.trim()}`); errors++; }
      else { patched++; log(`  ${res.value?.action ?? "ok"} ${month} → dbc=£${v.net.toFixed(2)} (count=${v.count})`); }
    } catch (e) { log(`  ERROR ${month}: ${e.message}`); errors++; }
    await sleep(SLEEP_MS);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log("");
console.log("DBCINEMA_SCRAPE:");
console.log(`  Pages: ${dbcPage.pages}`);
console.log(`  Total completed orders: ${dbcPage.list.length}`);
console.log(`  Usable: ${dbcAgg.usable.length}`);
console.log(`  Sum gross: £${dbcGross.toFixed(2)}`);
console.log(`  Sum net:   £${dbcNet.toFixed(2)}`);
console.log("");
console.log("LEO_RESCRAPE_FRESH:");
if (leoToken) console.log(`  fresh token; completed=${leoPage.list.length}`);
else console.log("  skipped (no leo creds)");
console.log("");
console.log("OBSCURE_FILTERS_PROBED (dbcinema):");
for (const [f, r] of Object.entries(dbcFilters)) console.log(`  filter=${f}: ${r.status ?? r.error} count_first_page=${r.count_first_page ?? "-"}`);
console.log("");
console.log("HYGGLO_PAYOUTS_ENDPOINT:");
console.log(`  /v4/my/payouts dbcinema: ${dbcPayoutSummary.count} positive txns, sum=£${dbcPayoutSummary.sum.toFixed(2)} (rows=${dbcPayouts.length})`);
console.log(`  /v4/my/payouts leo:      ${leoPayoutSummary.count} positive txns, sum=£${leoPayoutSummary.sum.toFixed(2)} (rows=${leoPayouts.length})`);
console.log(`  Sample fields dbcinema: ${dbcPayoutSummary.fields.join(",")}`);
console.log(`  Sample row dbcinema: ${JSON.stringify(dbcPayoutSummary.sample).slice(0,300)}`);
console.log("");
console.log("OTHER_ENDPOINTS_PROBED (dbcinema):");
for (const [p, r] of Object.entries(dbcProbe)) {
  if (r.status === 200) console.log(`  ${p}: 200 (len=${r.len})`);
  else console.log(`  ${p}: ${r.status ?? r.error}`);
}
console.log("");
console.log("PER_MONTH_DBCINEMA (top 10 net):");
const top = [...dbcSortedMonths].sort((a,b) => b[1].net - a[1].net).slice(0, 10);
for (const [m, v] of top) console.log(`  ${m}: count=${v.count}, gross=£${v.gross.toFixed(2)}, net=£${v.net.toFixed(2)}`);
console.log("");
console.log("BACKFILL_APPLIED:");
console.log(`  dbcinema months patched: ${patched}`);
console.log(`  Errors: ${errors}`);
console.log(`  Total dbcinema net added: £${dbcNet.toFixed(2)}`);
console.log("");
console.log(`SNAPSHOT: ${snapshotPath}`);
console.log(`VERDICT: ${errors === 0 ? "dbcinema-recovered" : "partial"}`);
