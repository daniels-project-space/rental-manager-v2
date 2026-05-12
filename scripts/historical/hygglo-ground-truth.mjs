#!/usr/bin/env node
/**
 * hygglo-ground-truth.mjs
 * Read-only snapshot of live Hygglo state for both accounts.
 * Outputs /tmp/hygglo-truth-YYYYMMDD.json
 */
import { writeFileSync } from "node:fs";

const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";

const ACCOUNTS = [
  { slug: "dbcinema", email: "daniel.malai1999@gmail.com", password: "Mountainfatllama1999" },
  { slug: "leo",      email: "leo.adams.hygglo@gmail.com", password: "Theheavenweknow" },
];

// Key listing IDs to fetch rates for (Sony FX3, GM 24-70, GoPro)
const LISTING_IDS_OF_INTEREST = {
  // will be populated from order data via item names matching
};

async function auth(email, password) {
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
  if (!res.ok) throw new Error(`Auth failed for ${email}: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
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

async function fetchOrders(token, filter, limit = 50) {
  const res = await fetch(
    `${API_BASE}/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=${limit}`,
    { headers: hdrs(token) }
  );
  if (!res.ok) {
    console.warn(`  orders?filter=${filter} → ${res.status}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

async function fetchOrderDetail(token, orderId) {
  const res = await fetch(
    `${API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`,
    { headers: hdrs(token) }
  );
  if (!res.ok) return null;
  return res.json();
}

async function fetchListingDetail(token, listingId) {
  const res = await fetch(`${API_BASE}/v4/products/${listingId}`, {
    headers: hdrs(token),
  });
  if (!res.ok) return null;
  return res.json();
}

function summariseOrder(detail, filter) {
  const items = (detail.items ?? [])
    .filter((i) => i.type !== "INSURANCE")
    .map((i) => i.name ?? "?");
  const start = detail.rentalPeriod?.startDateUTC?.slice(0, 10) ?? "?";
  const end   = detail.rentalPeriod?.endDateUTC?.slice(0, 10) ?? "?";
  const gross = detail.price?.breakdown?.totalPrice?.amount ?? detail.price?.total ?? null;
  const net   = detail.price?.breakdown?.lenderEarnings?.amount ?? detail.price?.ownerEarnings ?? null;
  const renter = detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? "Unknown";
  return {
    order_id: detail.id,
    filter,
    status: detail.status ?? filter,
    renter,
    items,
    start,
    end,
    gross_gbp: gross,
    net_gbp: net,
  };
}

// Today in London
function todayLondon() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Europe/London" }).slice(0, 10);
}

async function scrapeAccount(account) {
  console.log(`\n[${account.slug}] Authenticating...`);
  const token = await auth(account.email, account.password);
  console.log(`[${account.slug}] Auth OK`);

  const filters = ["pending", "current", "future", "completed"];
  const ordersByFilter = {};
  const allOrderIds = new Set();

  for (const filter of filters) {
    const orders = await fetchOrders(token, filter, filter === "completed" ? 20 : 50);
    ordersByFilter[filter] = orders;
    orders.forEach((o) => allOrderIds.add(o.id));
    console.log(`  ${filter}: ${orders.length} orders`);
  }

  // Deduplicated order IDs
  const uniqueIds = [...allOrderIds];
  console.log(`  Total unique order IDs: ${uniqueIds.length}`);

  // Fetch details for all pending + current + future (skip old completed)
  const priorityIds = new Set([
    ...ordersByFilter.pending.map((o) => o.id),
    ...ordersByFilter.current.map((o) => o.id),
    ...ordersByFilter.future.map((o) => o.id),
    // Only first 5 completed for context
    ...ordersByFilter.completed.slice(0, 5).map((o) => o.id),
  ]);

  const details = {};
  for (const id of priorityIds) {
    const d = await fetchOrderDetail(token, id);
    if (d) details[id] = d;
  }
  console.log(`  Fetched ${Object.keys(details).length} order details`);

  const today = todayLondon();
  const summaries = { pending: [], current: [], future: [], completed: [] };

  for (const filter of ["pending", "current", "future", "completed"]) {
    const ids = filter === "completed"
      ? ordersByFilter[filter].slice(0, 5).map((o) => o.id)
      : ordersByFilter[filter].map((o) => o.id);
    for (const id of ids) {
      if (details[id]) summaries[filter].push(summariseOrder(details[id], filter));
    }
  }

  const todaysPickups = summaries.current
    .concat(summaries.future)
    .concat(summaries.pending)
    .filter((o) => o.start === today);

  const todaysReturns = summaries.current
    .concat(summaries.future)
    .filter((o) => o.end === today);

  // Collect listing IDs from items for rate lookup
  const listingIds = new Set();
  for (const d of Object.values(details)) {
    for (const item of d.items ?? []) {
      if (item.productId) listingIds.add(item.productId);
    }
  }

  // Fetch listing details for pricing reference (first 8 to stay surgical)
  const listingRates = {};
  let fetched = 0;
  for (const lid of listingIds) {
    if (fetched >= 8) break;
    const listing = await fetchListingDetail(token, lid);
    if (listing) {
      const name = listing.title ?? listing.name ?? String(lid);
      const pricePerDay = listing.price?.perDay?.amount
        ?? listing.pricing?.perDay
        ?? listing.price?.amount
        ?? null;
      listingRates[lid] = { name, pricePerDay, currency: listing.price?.currency ?? "GBP" };
      fetched++;
    }
  }

  return {
    account: account.slug,
    fetched_at: new Date().toISOString(),
    today,
    counts: {
      pending: summaries.pending.length,
      current: summaries.current.length,
      future:  summaries.future.length,
      completed_sample: summaries.completed.length,
    },
    pending:         summaries.pending,
    current:         summaries.current,
    future:          summaries.future,
    completed_sample: summaries.completed,
    todays_pickups:  todaysPickups,
    todays_returns:  todaysReturns,
    listing_rates:   listingRates,
  };
}

const main = async () => {
  const results = [];
  for (const account of ACCOUNTS) {
    try {
      const r = await scrapeAccount(account);
      results.push(r);
    } catch (err) {
      console.error(`[${account.slug}] ERROR:`, err.message);
      results.push({ account: account.slug, error: err.message, fetched_at: new Date().toISOString() });
    }
  }

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outPath = `/tmp/hygglo-truth-${today}.json`;
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote ground truth to ${outPath}`);
  return outPath;
};

main().catch((e) => { console.error(e); process.exit(1); });
