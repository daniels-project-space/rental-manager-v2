#!/usr/bin/env node
/**
 * Phase 1 audit ground-truth fetcher.
 * Pulls active/upcoming Hygglo orders for dbcinema + leo accounts,
 * captures renter, items, photo URLs for downstream RM-v2 reconciliation.
 *
 * Output: /tmp/rm-v2-audit/ground-truth.json
 *
 * Auth: copies the OAuth password-grant pattern from
 * scripts/historical/hygglo-ground-truth.mjs (avoids .ts ESM import friction).
 */
import { writeFileSync, mkdirSync } from "node:fs";

const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";

const ACCOUNTS = [
  { slug: "dbcinema", email: "daniel.malai1999@gmail.com", password: "Mountainfatllama1999" },
  { slug: "leo",      email: "leo.adams.hygglo@gmail.com", password: "Theheavenweknow" },
];

const FILTERS = ["pending", "current", "future"];
const NOW = Date.now();
const WINDOW_END = NOW + 30 * 24 * 60 * 60 * 1000; // +30 days

async function auth(email, password, slug) {
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
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`Auth failed for ${slug}: ${res.status} ${text}`);
  }
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

async function fetchOrdersList(token, filter) {
  const url =
    `${API_BASE}/v4/my/orders?role=owner&filter=${filter}` +
    `&sort=latest-activity&offset=0&limit=100&timezone=Europe/London`;
  const res = await fetch(url, { headers: hdrs(token) });
  if (!res.ok) {
    console.warn(`  orders?filter=${filter} -> ${res.status}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

async function fetchOrderDetail(token, orderId) {
  const res = await fetch(
    `${API_BASE}/v4/my/orders/${orderId}?timezone=Europe/London`,
    { headers: hdrs(token) },
  );
  if (!res.ok) return null;
  return res.json();
}

function inWindow(detail) {
  const startStr = detail.rentalPeriod?.startDateUTC;
  const endStr = detail.rentalPeriod?.endDateUTC;
  if (!startStr || !endStr) return false;
  const start = Date.parse(startStr);
  const end = Date.parse(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  // Overlap [now, now+30d] OR currently active
  if (end < NOW) return false;
  if (start > WINDOW_END) return false;
  return true;
}

function extractItemImageUrls(img) {
  // Hygglo image objects use keys like url, thumbnailUrl, mediumUrl, largeUrl
  if (!img || typeof img !== "object") return [];
  const urls = [];
  for (const k of ["url", "originalUrl", "largeUrl", "mediumUrl", "thumbnailUrl"]) {
    if (typeof img[k] === "string") urls.push(img[k]);
  }
  return urls;
}

function summarise(account, detail) {
  const items = (detail.items ?? [])
    .filter((i) => i.type !== "INSURANCE")
    .map((i) => ({
      name: i.name ?? null,
      type: i.type ?? null,
      productId: i.productId ?? null,
      slug: i.slug ?? null,
      image_urls: extractItemImageUrls(i.image),
    }));
  // Aggregate all item image URLs as the "photos" Hygglo shows for the order
  const photos_urls = items.flatMap((it) => it.image_urls);
  return {
    account,
    order_id: detail.id,
    status: detail.status ?? null,
    renter_name: detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? null,
    start: detail.rentalPeriod?.startDateUTC ?? null,
    end: detail.rentalPeriod?.endDateUTC ?? null,
    items,
    photos_urls,
  };
}

async function processAccount(acct) {
  const result = {
    slug: acct.slug,
    success: false,
    error: null,
    orders_seen: 0,
    orders_kept: 0,
    orders: [],
  };
  try {
    console.log(`[${acct.slug}] auth...`);
    const token = await auth(acct.email, acct.password, acct.slug);
    const seen = new Map();
    for (const f of FILTERS) {
      const list = await fetchOrdersList(token, f);
      console.log(`[${acct.slug}] filter=${f} -> ${list.length}`);
      for (const o of list) if (o?.id != null) seen.set(o.id, o);
    }
    result.orders_seen = seen.size;

    for (const id of seen.keys()) {
      const detail = await fetchOrderDetail(token, id);
      if (!detail) continue;
      if (!inWindow(detail)) continue;
      result.orders.push(summarise(acct.slug, detail));
    }
    result.orders_kept = result.orders.length;
    result.success = true;
    console.log(`[${acct.slug}] kept ${result.orders_kept}/${result.orders_seen}`);
  } catch (e) {
    result.error = String(e?.message ?? e);
    console.error(`[${acct.slug}] FAILED: ${result.error}`);
  }
  return result;
}

mkdirSync("/tmp/rm-v2-audit", { recursive: true });

const accountResults = [];
for (const acct of ACCOUNTS) {
  // sequential to avoid rate-limiting
  // eslint-disable-next-line no-await-in-loop
  accountResults.push(await processAccount(acct));
}

const allOrders = accountResults.flatMap((r) => r.orders);
const out = {
  generated_at: new Date().toISOString(),
  window: { now: new Date(NOW).toISOString(), end: new Date(WINDOW_END).toISOString() },
  per_account: accountResults.map((r) => ({
    slug: r.slug,
    success: r.success,
    error: r.error,
    orders_seen: r.orders_seen,
    orders_kept: r.orders_kept,
  })),
  orders: allOrders,
};

writeFileSync("/tmp/rm-v2-audit/ground-truth.json", JSON.stringify(out, null, 2));
console.log(`\nWrote /tmp/rm-v2-audit/ground-truth.json (${allOrders.length} orders)`);
