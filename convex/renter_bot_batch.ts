/**
 * Helper queries for the renter-bot batch workflow.
 *
 * `listUnansweredThreads` finds threads whose latest hygglo_messages entry
 * is from the renter (not owner) AND has no pending renter_bot_drafts row.
 * The workflow then runs the agent for each result.
 *
 * READ-ONLY.
 *
 * Index discipline: we use `by_fetched` on hygglo_messages and walk
 * descending; we never `.collect()` the table. Phase 2+ can swap to a
 * dedicated per-thread "latest sender" materialised view.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";

export const listUnansweredThreads = query({
  args: {
    limit: v.optional(v.number()),
    thread_ids: v.optional(v.array(v.string())),
    maxScan: v.optional(v.number()),
  },
  handler: async (ctx, { limit, thread_ids, maxScan }) => {
    const cap = limit ?? 20;

    // Explicit thread_ids path: resolve those threads' latest inbound directly.
    if (thread_ids && thread_ids.length > 0) {
      const out: Array<{
        thread_id: string;
        account_slug: string;
        last_inbound_message_id: string;
        last_inbound_at: number;
        last_inbound_body: string;
      }> = [];
      for (const thread_id of thread_ids) {
        const latestRenter = await ctx.db
          .query("hygglo_messages")
          .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
          .order("desc")
          .filter((q) => q.neq(q.field("sender"), "owner"))
          .first();
        if (!latestRenter) continue;
        // Skip if a pending draft already exists for this exact trigger.
        const draft = await ctx.db
          .query("renter_bot_drafts")
          .withIndex("by_last_inbound", (q) =>
            q.eq("last_inbound_message_id", latestRenter.message_id),
          )
          .first();
        if (draft && draft.status === "pending") continue;
        out.push({
          thread_id,
          account_slug: latestRenter.account_slug,
          last_inbound_message_id: latestRenter.message_id,
          last_inbound_at: latestRenter.hygglo_sent_at ?? latestRenter.fetched_at,
          last_inbound_body: latestRenter.body_text,
        });
        if (out.length >= cap) break;
      }
      return out;
    }

    // Scan-mode: walk the most-recent N messages by fetched_at, pick the
    // first occurrence per thread, retain only renter-sent latest messages
    // without a pending draft.
    const recent = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_fetched")
      .order("desc")
      .take(maxScan ?? 200);

    const seenThreads = new Set<string>();
    const candidates: Array<{
      thread_id: string;
      account_slug: string;
      last_inbound_message_id: string;
      last_inbound_at: number;
      last_inbound_body: string;
    }> = [];

    for (const m of recent) {
      if (seenThreads.has(m.thread_id)) continue;
      seenThreads.add(m.thread_id);
      if (m.sender === "owner") continue; // last message was owner → already replied
      const draft = await ctx.db
        .query("renter_bot_drafts")
        .withIndex("by_last_inbound", (q) =>
          q.eq("last_inbound_message_id", m.message_id),
        )
        .first();
      if (draft && draft.status === "pending") continue;
      candidates.push({
        thread_id: m.thread_id,
        account_slug: m.account_slug,
        last_inbound_message_id: m.message_id,
        last_inbound_at: m.hygglo_sent_at ?? m.fetched_at,
        last_inbound_body: m.body_text,
      });
      if (candidates.length >= cap) break;
    }
    return candidates;
  },
});
