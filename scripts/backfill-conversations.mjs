/**
 * backfill-conversations.mjs
 *
 * One-time script: reads all hygglo_messages from Convex,
 * extracts unique renters + one conversation per thread,
 * then calls upsertRentersBatch + upsertConversationsBatch.
 *
 * Note: hygglo_user_id is NOT available from stored messages
 * (the old scraper didn't capture it). Will deduplicate by display_name.
 * Future poll runs (Phase 6.1) will use the Hygglo API to get user IDs.
 *
 * Run from: /home/ubuntu/rental-manager-v2
 * Usage: node scripts/backfill-conversations.mjs
 */

const CONVEX_URL = 'https://hearty-oyster-600.convex.cloud';

async function convexMutation(path, args) {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  const data = await res.json();
  if (data.status !== 'success') {
    throw new Error(`Mutation ${path} failed: ${JSON.stringify(data)}`);
  }
  return data.value;
}

async function convexQuery(path, args) {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`Query ${path} failed: ${JSON.stringify(data)}`);
  return data.value;
}

// Fetch all messages via getRecentMessages with large limit
// We need a way to get ALL messages — use account slugs
const accounts = ['dbcinema', 'leo'];

const threadRenterMap = new Map(); // thread_id -> {account_slug, display_name, msgs: [{ts}]}

for (const slug of accounts) {
  // Use a large limit to get all messages for this account
  const msgs = await convexQuery('hygglo:getRecentMessages', { accountSlug: slug, limit: 2000 });
  console.log(`[backfill-convs] ${slug}: ${msgs.length} messages loaded`);

  for (const m of msgs) {
    if (!threadRenterMap.has(m.thread_id)) {
      // Prefer non-"Owner" sender_name for the renter name
      const renterName = m.sender === 'renter'
        ? (m.sender_name ?? 'Renter')
        : 'Renter';
      threadRenterMap.set(m.thread_id, {
        account_slug: m.account_slug,
        display_name: renterName,
        timestamps: [],
      });
    } else if (threadRenterMap.get(m.thread_id).display_name === 'Renter' && m.sender === 'renter' && m.sender_name) {
      // Upgrade from placeholder
      threadRenterMap.get(m.thread_id).display_name = m.sender_name;
    }

    const ts = m.hygglo_sent_at ?? m.fetched_at;
    if (ts) threadRenterMap.get(m.thread_id).timestamps.push(ts);
  }
}

console.log(`[backfill-convs] ${threadRenterMap.size} unique threads found`);

// Build per-account batches
const rentersByAccount = new Map();
const convsByAccount = new Map();

for (const [thread_id, info] of threadRenterMap.entries()) {
  const slug = info.account_slug;

  if (!rentersByAccount.has(slug)) rentersByAccount.set(slug, new Map());
  const rMap = rentersByAccount.get(slug);
  const rKey = info.display_name.trim().toLowerCase();
  if (!rMap.has(rKey)) {
    rMap.set(rKey, { display_name: info.display_name });
  }

  if (!convsByAccount.has(slug)) convsByAccount.set(slug, []);
  const ts = info.timestamps;
  const lastMsgAt = ts.length > 0 ? Math.max(...ts) : Date.now();
  const createdAt = ts.length > 0 ? Math.min(...ts) : lastMsgAt;
  convsByAccount.get(slug).push({
    thread_id,
    display_name: info.display_name,
    last_msg_at: lastMsgAt,
    created_at: createdAt,
  });
}

let totalRenters = 0;
let totalConvs = 0;

for (const slug of accounts) {
  const rentersMap = rentersByAccount.get(slug) ?? new Map();
  const renters = Array.from(rentersMap.values());
  const convs = convsByAccount.get(slug) ?? [];

  console.log(`[backfill-convs] ${slug}: ${renters.length} unique renters, ${convs.length} conversations`);

  if (renters.length > 0) {
    const rr = await convexMutation('hygglo:upsertRentersBatch', {
      account_slug: slug,
      renters,
    });
    console.log(`[backfill-convs] ${slug} renters: upserted=${rr.upserted}, skipped=${rr.skipped}`);
    totalRenters += rr.upserted;
  }

  // Batch conversations 50 at a time
  for (let i = 0; i < convs.length; i += 50) {
    const batch = convs.slice(i, i + 50);
    const cr = await convexMutation('hygglo:upsertConversationsBatch', {
      account_slug: slug,
      conversations: batch,
    });
    totalConvs += cr.upserted;
  }
  console.log(`[backfill-convs] ${slug} conversations: upserted=${convsByAccount.get(slug)?.length ?? 0} attempted`);
}

console.log(`\n[backfill-convs] Done. Total renters upserted: ${totalRenters}, total conversations upserted: ${totalConvs}`);
