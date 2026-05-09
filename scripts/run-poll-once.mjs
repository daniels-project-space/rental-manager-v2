import { ConvexHttpClient } from "convex/browser";
import { api } from "/home/ubuntu/rental-manager-v2/convex/_generated/api.js";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL = "https://hearty-oyster-600.convex.cloud";
const API_BASE = "https://api.hygglo.com/api";
const CLIENT_ID = "ngHyggloApp";
const CLIENT_SECRET = "lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=";
const COUNTRY = "GB";

async function vault(service) {
  const r = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({path:"secrets:listByService", args:{service}, format:"json"}),
  });
  const d = await r.json();
  const out = {};
  for (const s of (d.value ?? [])) out[s.keyName] = s.value;
  return out;
}

async function pollAccount(slug, email, password, convex) {
  console.log(`[${slug}] login...`);
  const params = new URLSearchParams({grant_type:"password", username:email, password, client_id:CLIENT_ID, client_secret:CLIENT_SECRET});
  const tk = await fetch(`${API_BASE}/token?country=${COUNTRY}`, {
    method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body: params.toString(),
  });
  if (!tk.ok) { console.error(`[${slug}] login failed:`, tk.status); return 0; }
  const {access_token} = await tk.json();

  const headers = {Authorization: `Bearer ${access_token}`, Accept:"application/json", Country:COUNTRY, "User-Client":"Hygglo-web"};

  const allOrders = [];
  for (const filter of ["pending","current","future"]) {
    const r = await fetch(`${API_BASE}/v4/my/orders?role=owner&filter=${filter}&sort=latest-activity&offset=0&limit=50`, {headers});
    if (!r.ok) continue;
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.items ?? []);
    allOrders.push(...arr);
  }
  const seen = new Set();
  const orders = allOrders.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });
  console.log(`[${slug}] ${orders.length} orders`);

  const messages = [];
  const fetchedAt = Date.now();
  for (const order of orders) {
    const r = await fetch(`${API_BASE}/v4/my/orders/${order.id}?timezone=Europe/London`, {headers});
    if (!r.ok) continue;
    const detail = await r.json();
    const otherName = detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? "Renter";
    for (const a of (detail.activities ?? [])) {
      if (!a.chatMessage) continue;
      const text = a.chatMessage.text?.content ?? "";
      if (!text.trim()) continue;
      messages.push({
        thread_id: String(order.id),
        message_id: a.key,
        sender: a.chatMessage.byMe ? "owner" : "renter",
        sender_name: a.chatMessage.byMe ? "Owner" : otherName,
        body_text: text,
        hygglo_sent_at: undefined,
        fetched_at: fetchedAt,
      });
    }
  }
  console.log(`[${slug}] ${messages.length} messages`);
  if (messages.length > 0) {
    let totalIns = 0; for (let i = 0; i < messages.length; i += 50) { const batch = messages.slice(i, i + 50); const r = await convex.mutation(api.hygglo.upsertMessages, { account_slug: slug, messages: batch }); totalIns += (r?.inserted ?? 0); } console.log(`[${slug}] inserted ${totalIns}`);
    console.log(`[${slug}] upsert:`, JSON.stringify(r));
  }
  return messages.length;
}

async function main() {
  const sec = await vault("hygglo");
  const convex = new ConvexHttpClient(CONVEX_URL);
  let total = 0;
  for (const [slug, e, p] of [
    ["dbcinema", "HYGGLO_DBCINEMA_EMAIL", "HYGGLO_DBCINEMA_PASSWORD"],
    ["leo", "HYGGLO_LEO_EMAIL", "HYGGLO_LEO_PASSWORD"],
  ]) {
    if (!sec[e] || !sec[p]) { console.log(`[${slug}] missing creds, skip`); continue; }
    try { total += await pollAccount(slug, sec[e], sec[p], convex); }
    catch (err) { console.error(`[${slug}] error:`, err.message); }
  }
  console.log(`TOTAL: ${total} messages`);
}

main().catch(e => { console.error(e); process.exit(1); });
