/**
 * import-missing-orders.mjs
 *
 * One-shot backfill for Hygglo orders that exist in the truth snapshot
 * (hygglo-truth-20260512.json) but are missing from v2 Convex.
 *
 * Root cause: the live poller has an `if (startUTC && endUTC)` guard that
 * silently skips orders where rentalPeriod dates are null (REQUEST-stage
 * inquiries where the renter hasn't sent a formal request with dates yet).
 *
 * This script fetches each order directly from Hygglo and upserts it via
 * api.hygglo.upsertOrderAsReservation, passing start_date/end_date as
 * undefined when null so Convex accepts them (schema already optional).
 *
 * Usage:
 *   node scripts/historical/import-missing-orders.mjs
 *
 * Auth: pulled automatically from the project-hub vault (same as poller).
 * No credentials are printed.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL = process.env.CONVEX_URL ?? "https://exciting-lion-29.convex.cloud";
const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";

// ── Missing order list (derived 2026-05-12, truth=39 vs v2=24) ──────────────
// 23 orders missing: 13 dbcinema + 10 leo
// Note: truth file had 18 "not in v2" at snapshot time; delta grew to 23 because
// the live poller continues to skip date-less orders as new ones come in.
const MISSING_ORDERS = [
  // dbcinema — REQUEST stage (no dates yet)
  { id: 3927811, account: "dbcinema" },
  { id: 3929545, account: "dbcinema" },
  { id: 3927962, account: "dbcinema" },
  { id: 3928563, account: "dbcinema" },
  { id: 3928993, account: "dbcinema" },
  { id: 3928925, account: "dbcinema" },
  { id: 3927384, account: "dbcinema" },
  { id: 3914445, account: "dbcinema" },
  { id: 3926573, account: "dbcinema" },
  { id: 3923455, account: "dbcinema" },
  { id: 3925225, account: "dbcinema" },
  { id: 3921575, account: "dbcinema" },
  { id: 3916814, account: "dbcinema" },
  // leo — REQUEST stage (no dates yet)
  { id: 3929551, account: "leo" },
  { id: 3928319, account: "leo" },
  { id: 3927785, account: "leo" },
  { id: 3916383, account: "leo" },
  { id: 3917153, account: "leo" },
  { id: 3922113, account: "leo" },
  { id: 3920524, account: "leo" },
  { id: 3921823, account: "leo" },
  { id: 3923452, account: "leo" },
  { id: 3910439, account: "leo" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Vault ──────────────────────────────────────────────────────────────────
async function getVaultSecrets(service) {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
  });
  if (!res.ok) throw new Error(`Vault fetch failed: ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const s of data.value ?? []) out[s.keyName] = s.value;
  return out;
}

// ── Hygglo auth ────────────────────────────────────────────────────────────
async function authHygglo(email, password) {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    username: email,
    password: password,
    scope: "read",
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
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Auth failed for ${email}: ${res.status} ${txt}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

// ── Hygglo order detail fetch ──────────────────────────────────────────────
async function fetchOrderDetail(orderId, token) {
  const res = await fetch(`${API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Country: COUNTRY,
      "User-Client": "Hygglo-web",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Order ${orderId} fetch failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ── Determine sourceFilter by scanning the 4 filter lists ─────────────────
async function buildOrderFilterMap(token) {
  const filters = ["pending", "current", "future", "obsolete"];
  const map = {}; // id -> sourceFilter (first-seen wins)
  for (const filter of filters) {
    const res = await fetch(
      `${API_BASE}/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=50`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Country: COUNTRY,
          "User-Client": "Hygglo-web",
        },
      }
    );
    if (!res.ok) { console.warn(`  filter=${filter} failed: ${res.status}`); continue; }
    const raw = await res.json();
    const arr = Array.isArray(raw) ? raw : (raw?.items ?? []);
    for (const o of arr) {
      if (map[o.id] === undefined) map[o.id] = filter;
    }
    await sleep(300);
  }
  return map;
}

// ── Extract active order step ──────────────────────────────────────────────
function extractActiveOrderStep(detail) {
  if (!detail?.steps) return undefined;
  const active = detail.steps.find((s) => s.active);
  return active?.key ?? undefined;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== import-missing-orders.mjs ===");
  console.log(`Target: ${MISSING_ORDERS.length} orders (dbcinema=${MISSING_ORDERS.filter(o=>o.account==="dbcinema").length}, leo=${MISSING_ORDERS.filter(o=>o.account==="leo").length})`);

  // Load secrets
  const secrets = await getVaultSecrets("hygglo");
  console.log("Vault secrets loaded.");

  // Auth both accounts
  const dbToken = await authHygglo(secrets["HYGGLO_DBCINEMA_EMAIL"], secrets["HYGGLO_DBCINEMA_PASSWORD"]);
  console.log("dbcinema authenticated.");
  const leoToken = await authHygglo(secrets["HYGGLO_LEO_EMAIL"], secrets["HYGGLO_LEO_PASSWORD"]);
  console.log("leo authenticated.");

  // Build filter maps for both accounts
  console.log("Scanning filter lists...");
  const dbFilterMap = await buildOrderFilterMap(dbToken);
  const leoFilterMap = await buildOrderFilterMap(leoToken);
  console.log(`dbcinema filter map: ${Object.keys(dbFilterMap).length} orders`);
  console.log(`leo filter map: ${Object.keys(leoFilterMap).length} orders`);

  const convex = new ConvexHttpClient(CONVEX_URL);

  let attempted = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const failures = [];

  for (const { id, account } of MISSING_ORDERS) {
    attempted++;
    const token = account === "dbcinema" ? dbToken : leoToken;
    const filterMap = account === "dbcinema" ? dbFilterMap : leoFilterMap;

    try {
      const detail = await fetchOrderDetail(id, token);
      const sourceFilter = filterMap[id] ?? "pending";

      const startUTC = detail.rentalPeriod?.startDateUTC ?? null;
      const endUTC = detail.rentalPeriod?.endDateUTC ?? null;

      // Map sourceFilter → reservation status
      const status =
        sourceFilter === "obsolete"
          ? "cancelled"
          : sourceFilter === "pending"
            ? "pending_review"
            : "confirmed";

      const grossPaid =
        detail.price?.breakdown?.totalPrice?.amount ??
        detail.price?.total ??
        undefined;
      const netToOwner =
        detail.price?.breakdown?.lenderEarnings?.amount ??
        detail.price?.ownerEarnings ??
        undefined;
      const currency = detail.price?.currency ?? "GBP";

      const orderItems = (detail.items ?? [])
        .filter((i) => i.type !== "INSURANCE")
        .map((i) => ({ item_name: i.name ?? "Unknown item" }));

      const renterName =
        detail.labels?.otherPart ||
        detail.users?.find((u) => u.role === "borrower")?.profile?.name ||
        undefined;

      const payload = {
        account_slug: account,
        hygglo_order_id: String(id),
        status,
        // start_date / end_date omitted when null — schema is v.optional(v.string())
        ...(startUTC ? { start_date: startUTC.slice(0, 10) } : {}),
        ...(endUTC ? { end_date: endUTC.slice(0, 10) } : {}),
        gross_paid_gbp: grossPaid,
        net_to_owner_gbp: netToOwner,
        currency,
        items: orderItems,
        sourceFilter,
        renter_name: renterName,
        order: detail,
      };

      const result = await convex.mutation(api.hygglo.upsertOrderAsReservation, payload);

      const step = extractActiveOrderStep(detail);
      const dateStr = startUTC ? `${startUTC.slice(0,10)}→${endUTC?.slice(0,10)}` : "no-dates";
      console.log(`  [${attempted}/${MISSING_ORDERS.length}] ${account}/${id} | filter=${sourceFilter} | step=${step} | dates=${dateStr} | → ${result.action}`);

      if (result.action === "inserted") imported++;
      else if (result.action === "updated") updated++;
      else skipped++;

    } catch (err) {
      console.error(`  [${attempted}/${MISSING_ORDERS.length}] FAILED ${account}/${id}: ${err.message}`);
      failures.push({ id, account, error: err.message });
    }

    await sleep(250); // rate-limit guard
  }

  console.log("\n=== Summary ===");
  console.log(`Attempted: ${attempted}`);
  console.log(`Inserted:  ${imported}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failures.length}`);
  if (failures.length > 0) {
    console.log("Failures:");
    failures.forEach((f) => console.log(`  ${f.account}/${f.id}: ${f.error}`));
  }

  // Final v2 pending count
  try {
    const r = await fetch(`${CONVEX_URL}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "reservations:listPending", args: {}, format: "json" }),
    });
    const d = await r.json();
    console.log(`\nlistPending after import: ${d.value?.count ?? "?"} (target: 39)`);
  } catch (e) {
    console.warn("Could not verify listPending:", e.message);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
