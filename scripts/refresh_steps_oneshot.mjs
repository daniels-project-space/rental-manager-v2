import { ConvexHttpClient } from 'convex/browser';
import { api } from '/home/ubuntu/rental-manager-v2/convex/_generated/api.js';

const VAULT_URL = 'https://fantastic-roadrunner-485.convex.cloud';
const API_BASE = 'https://api.hygglo.com/api';
const CLIENT_ID = 'ngHyggloApp';
const CLIENT_SECRET = 'lQVS05DGy9SQdAEInEPqTMK3aktEfSc7iupC7BYM4JY=';
const COUNTRY = 'GB';
const TARGETS = [
  ['https://hearty-oyster-600.convex.cloud', 'dev'],
  ['https://exciting-lion-29.convex.cloud',  'prod'],
];
async function vault(service) {
  const r = await fetch(VAULT_URL+'/api/query', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path:'secrets:listByService', args:{service}, format:'json'})});
  const d = await r.json();
  const out = {};
  for (const s of (d.value ?? [])) out[s.keyName] = s.value;
  return out;
}
const v = await vault('hygglo');
const ACCOUNTS = [
  { slug:'dbcinema', email: v.HYGGLO_DBCINEMA_EMAIL, password: v.HYGGLO_DBCINEMA_PASSWORD },
  { slug:'leo',      email: v.HYGGLO_LEO_EMAIL,      password: v.HYGGLO_LEO_PASSWORD },
];

async function tokenFor(acc) {
  const params = new URLSearchParams({grant_type:'password',username:acc.email,password:acc.password,client_id:CLIENT_ID,client_secret:CLIENT_SECRET});
  const tk = await fetch(API_BASE+'/token?country='+COUNTRY,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body: params.toString()});
  if (!tk.ok) throw new Error('login failed: '+tk.status);
  return (await tk.json()).access_token;
}

async function processAccount(acc, convex) {
  const access = await tokenFor(acc);
  const headers = { Authorization:'Bearer '+access, Accept:'application/json', Country:COUNTRY, 'User-Client':'Hygglo-web' };
  const all = [];
  for (const filter of ['pending','current','future','obsolete']) {
    const r = await fetch(API_BASE+'/v4/my/orders?role=owner&filter='+filter+'&sort=latest-activity&offset=0&limit=100', { headers });
    if (!r.ok) continue;
    const d = await r.json();
    const arr = Array.isArray(d) ? d : (d.items ?? []);
    all.push(...arr.map(o => ({ ...o, sourceFilter: filter })));
  }
  const seen = new Set();
  const orders = all.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });
  console.log(' ', acc.slug, '->', orders.length, 'orders');
  let upserted = 0;
  for (const o of orders) {
    const r = await fetch(API_BASE+'/v4/my/orders/'+o.id+'?timezone=Europe/London',{ headers });
    if (!r.ok) continue;
    const detail = await r.json();
    const orderItems = (detail.items ?? []).map(it => ({ item_name: it.name ?? 'Item', qty: 1 }));
    if (orderItems.length === 0) continue;
    const start = detail.booking?.startsAt ? detail.booking.startsAt.slice(0,10) : null;
    const end   = detail.booking?.endsAt   ? detail.booking.endsAt.slice(0,10)   : null;
    if (!start || !end) continue;
    const bookingStatus = detail.booking?.status ?? undefined;
    const grossPaid = (detail.booking?.totalPrice?.amount ?? 0) / 100;
    const netToOwner = (detail.booking?.lenderEarnings?.amount ?? 0) / 100;
    const dur = Math.round((Date.parse(detail.booking?.endsAt) - Date.parse(detail.booking?.startsAt)) / 86400000) + 1;
    const otherName = detail.users?.otherPart?.name ?? detail.labels?.otherPart ?? 'Renter';
    const status = o.sourceFilter === 'obsolete' ? 'cancelled' : (o.sourceFilter === 'pending' ? 'pending_review' : 'confirmed');
    const photos = [];
    for (const item of (detail.items ?? [])) {
      if (item?.image?.fullSizeUrl) photos.push(item.image.fullSizeUrl);
    }
    try {
      const res = await convex.mutation(api.hygglo.upsertOrderAsReservation, {
        account_slug: acc.slug,
        hygglo_order_id: String(o.id),
        status,
        start_date: start,
        end_date: end,
        gross_paid_gbp: grossPaid > 0 ? grossPaid : undefined,
        net_to_owner_gbp: netToOwner > 0 ? netToOwner : undefined,
        currency: 'GBP',
        items: orderItems,
        duration_days: dur > 0 ? dur : undefined,
        sourceFilter: o.sourceFilter,
        renter_name: otherName,
        booking_status: bookingStatus,
        photos_urls: photos.length ? photos : undefined,
        order: detail,
      });
      if (res.action !== 'skipped') upserted++;
    } catch (e) { console.error('  upsert err', o.id, e.message); }
  }
  console.log(' ', acc.slug, '->', upserted, 'upserted');
}

for (const [url, label] of TARGETS) {
  console.log('=== '+label+' ('+url+') ===');
  const convex = new ConvexHttpClient(url);
  for (const acc of ACCOUNTS) {
    try { await processAccount(acc, convex); }
    catch (e) { console.error('account error', acc.slug, e.message); }
  }
}
