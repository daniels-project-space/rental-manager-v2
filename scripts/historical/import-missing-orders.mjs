#!/usr/bin/env node
/**
 * import-missing-orders.mjs
 * Fetch 3 specific Hygglo order IDs that are absent from Convex prod and upsert them.
 * Orders: 3931643, 3931900, 3932017
 *
 * Run: node scripts/historical/import-missing-orders.mjs
 */

const CONVEX_URL   = "https://exciting-lion-29.convex.cloud";
const VAULT_URL    = "https://fantastic-roadrunner-485.convex.cloud";
const API_BASE     = "https://api.hygglo.com/api";
const CLIENT_ID    = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY      = "GB";

const TARGET_IDS = ["3931643", "3931900", "3932017"];

const ACCOUNTS = [
  { slug: "dbcinema", emailKey: "HYGGLO_DBCINEMA_EMAIL", passKey: "HYGGLO_DBCINEMA_PASSWORD" },
  { slug: "leo",      emailKey: "HYGGLO_LEO_EMAIL",      passKey: "HYGGLO_LEO_PASSWORD" },
];

async function vault(service) {
  const r = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
  });
  const d = await r.json();
  const out = {};
  for (const s of (d.value ?? [])) out[s.keyName] = s.value;
  return out;
}

async function hyggloAuth(email, password) {
  const body = new URLSearchParams({
    grant_type: "password", username: email, password,
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  });
  const r = await fetch(`${API_BASE}/token?country=${COUNTRY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Auth failed for ${email}: ${r.status}`);
  const { access_token } = await r.json();
  return access_token;
}

function hdrs(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Country: COUNTRY,
    "User-Client": "Hygglo-web",
  };
}

async function fetchOrderDetail(token, orderId) {
  const r = await fetch(`${API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`, {
    headers: hdrs(token),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    console.warn(`  fetchOrderDetail(${orderId}) → ${r.status}`);
    return null;
  }
  return r.json();
}

function parseDate(raw) {
  // Hygglo dates can be "YYYY-MM-DD" or ISO timestamps; normalise to YYYY-MM-DD
  if (!raw) return null;
  return String(raw).slice(0, 10);
}

async function convexMutation(path, args) {
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  return r.json();
}

async function main() {
  const sec = await vault("hygglo");

  const results = [];

  for (const acct of ACCOUNTS) {
    const email = sec[acct.emailKey];
    const pass  = sec[acct.passKey];
    if (!email || !pass) {
      console.log(`[${acct.slug}] missing creds, skipping`);
      continue;
    }

    let token;
    try {
      token = await hyggloAuth(email, pass);
      console.log(`[${acct.slug}] auth OK`);
    } catch (e) {
      console.error(`[${acct.slug}] auth error:`, e.message);
      continue;
    }

    for (const oid of TARGET_IDS) {
      // Check if already imported by a previous account iteration
      const alreadyDone = results.find(r => r.orderId === oid && r.action !== "not_found");
      if (alreadyDone) continue;

      console.log(`[${acct.slug}] fetching order ${oid}…`);
      const detail = await fetchOrderDetail(token, oid);

      if (!detail) {
        console.log(`[${acct.slug}] order ${oid} → not found (may belong to other account)`);
        results.push({ orderId: oid, account: acct.slug, action: "not_found" });
        continue;
      }

      // Extract fields from Hygglo order detail
      const booking = detail.booking ?? {};
      const startDate = parseDate(booking.startDate ?? detail.startDate);
      const endDate   = parseDate(booking.endDate   ?? detail.endDate);
      if (!startDate || !endDate) {
        console.warn(`[${acct.slug}] order ${oid} missing dates — skipping`);
        results.push({ orderId: oid, account: acct.slug, action: "error", error: "missing dates" });
        continue;
      }

      const grossRaw = detail.price?.totalPrice ?? detail.totalPrice;
      const netRaw   = detail.price?.earningPrice ?? detail.earningPrice ?? detail.earnings;
      const gross    = grossRaw != null ? Number(grossRaw) : undefined;
      const net      = netRaw   != null ? Number(netRaw)   : undefined;

      // items array
      const productName = detail.product?.name ?? detail.productName ?? detail.title ?? "Unknown item";
      const items = [{ item_name: String(productName) }];

      // duration
      const durationDays = booking.duration ?? detail.duration ?? undefined;

      // renter name
      const renterName = detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? undefined;

      // status (will be overridden by order_step inside the mutation, but we need a value)
      const sourceFilter = "current";
      const status = "confirmed";

      const payload = {
        account_slug:      acct.slug,
        hygglo_order_id:   String(oid),
        status,
        start_date:        startDate,
        end_date:          endDate,
        gross_paid_gbp:    gross,
        net_to_owner_gbp:  net,
        currency:          "GBP",
        items,
        duration_days:     durationDays != null ? Number(durationDays) : undefined,
        order:             detail,       // raw — mutation extracts order_step from this
        sourceFilter,
        renter_name:       renterName,
        booking_status:    detail.status ?? undefined,
        pickup_time:       booking.pickup_time   ?? booking.pickupTime   ?? undefined,
        return_time:       booking.return_time   ?? booking.returnTime   ?? undefined,
        pickup_method:     booking.pickup_method ?? booking.pickupMethod ?? undefined,
        return_method:     booking.return_method ?? booking.returnMethod ?? undefined,
      };

      console.log(`[${acct.slug}] upserting ${oid} (${startDate}→${endDate}, gross=${gross})…`);
      const res = await convexMutation("hygglo:upsertOrderAsReservation", payload);

      if (res.status === "success") {
        console.log(`[${acct.slug}] order ${oid} → ${res.value?.action}`);
        results.push({ orderId: oid, account: acct.slug, action: res.value?.action });
      } else {
        console.error(`[${acct.slug}] order ${oid} → ERROR:`, res.errorMessage ?? JSON.stringify(res));
        results.push({ orderId: oid, account: acct.slug, action: "error", error: res.errorMessage });
      }
    }
  }

  console.log("\n── IMPORT SUMMARY ──");
  for (const r of results) {
    // Deduplicate: if same orderId appears multiple times keep first non-not_found
    console.log(`  ${r.orderId} [${r.account}]: ${r.action}${r.error ? " — " + r.error : ""}`);
  }
  const imported = results.filter(r => r.action === "inserted").length;
  const updated  = results.filter(r => r.action === "updated").length;
  const notFound = new Set(results.filter(r => r.action === "not_found").map(r => r.orderId));
  const unresolved = TARGET_IDS.filter(id => notFound.has(id) &&
    !results.find(r => r.orderId === id && r.action !== "not_found"));
  console.log(`  Inserted: ${imported}, Updated: ${updated}, Not found on either account: ${unresolved.length}`);
  if (unresolved.length) console.log(`  Unresolved: ${unresolved.join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
