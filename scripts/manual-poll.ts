/**
 * Manual one-off Hygglo poll — emergency/standalone refresh that bypasses the
 * Trigger.dev schedule (poll-hygglo-inbox). Use when the scheduler is down
 * (paused prod env / usage cap) and the inbox + reservations need refreshing.
 *
 * Runs the SAME pipeline as the scheduled task: corePoll() per account, then
 * upserts messages / reservations (incl. awaiting_owner_action) / renters /
 * conversations, and records account_state success. Skips only the
 * newly-inserted-row listing-resolver + info-pool steps (those need Trigger).
 *
 *   npx tsx scripts/manual-poll.ts
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { corePoll } from "../src/hygglo-core/poll";

const CONVEX_URL = process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";
const ACCOUNTS = ["dbcinema", "leo", "diogo"];

async function pollAccount(convex: ConvexHttpClient, slug: string) {
  const core = await corePoll(slug, { fetchedAt: Date.now() });
  for (let i = 0; i < core.messages.length; i += 50) {
    await convex.mutation(api.hygglo.upsertMessages, {
      account_slug: slug,
      messages: core.messages.slice(i, i + 50),
    });
  }
  // corePoll reservation rows are batch-arg-shaped except for `detail_payload`
  // (never sent to the upsert); strip it and forward the rest verbatim.
  const orders = (core.reservations as any[]).map(({ detail_payload, ...rest }) => rest);
  for (let i = 0; i < orders.length; i += 50) {
    await convex.mutation(api.hygglo.upsertOrdersAsReservationsBatch, {
      orders: orders.slice(i, i + 50),
    });
  }
  if (core.renters.length > 0) {
    await convex.mutation(api.hygglo.upsertRentersBatch, {
      account_slug: slug,
      renters: core.renters as any,
    });
  }
  if (core.conversations.length > 0) {
    await convex.mutation(api.hygglo.upsertConversationsBatch, {
      account_slug: slug,
      conversations: core.conversations as any,
    });
  }
  await convex.mutation(api.account_state.upsert, { account: slug, succeeded: true });
  const awaiting = orders
    .filter((o: any) => o.awaiting_owner_action === true)
    .map((o: any) => o.hygglo_order_id);
  return {
    slug,
    reservations: orders.length,
    messages: core.messages.length,
    renters: core.renters.length,
    conversations: core.conversations.length,
    awaiting_owner_action: awaiting,
  };
}

async function main() {
  const convex = new ConvexHttpClient(CONVEX_URL);
  const out: any[] = [];
  for (const slug of ACCOUNTS) {
    try {
      out.push(await pollAccount(convex, slug));
    } catch (e: any) {
      out.push({ slug, error: String(e?.message || e) });
      console.error(slug, "ERR", e?.stack || e);
    }
  }
  console.log("RESULT " + JSON.stringify(out, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
