/**
 * Phase 3a diagnostic — verify whether reservations.hygglo_order_id
 * actually matches hygglo_messages.thread_id for obsolete rentals.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";

export const auditObsoleteThreadJoin = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 30 }) => {
    const obsoletes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .take(limit);

    const totalMessagesEver = (await ctx.db.query("hygglo_messages").take(5)).length;

    const results: any[] = [];
    let withMessages = 0;
    let withoutMessages = 0;
    let noHyggloOrderId = 0;

    for (const r of obsoletes) {
      const hid = r.hygglo_order_id ?? null;
      if (!hid) {
        noHyggloOrderId++;
        results.push({
          _id: r._id,
          hygglo_order_id: null,
          status: r.status,
          obsolete_reason: r.obsolete_reason,
          msgs: 0,
          note: "no hygglo_order_id",
        });
        continue;
      }
      const msgs = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", hid))
        .collect();
      if (msgs.length > 0) withMessages++;
      else withoutMessages++;
      results.push({
        _id: r._id,
        hygglo_order_id: hid,
        status: r.status,
        obsolete_reason: r.obsolete_reason,
        reclassified_class: r.demand_loss_class,
        last_message_sender_at_obsolete: r.last_message_sender_at_obsolete,
        msg_count: msgs.length,
      });
    }

    return {
      sampled: obsoletes.length,
      withMessages,
      withoutMessages,
      noHyggloOrderId,
      sample_has_messages_table: totalMessagesEver > 0,
      results,
    };
  },
});

/**
 * Reclassified outcome distribution — sense check vs Phase 3a report.
 * Counts last_message_sender_at_obsolete buckets across ALL reclassified rows.
 */
export const reclassifiedDistribution = query({
  args: {},
  handler: async (ctx) => {
    // Limit pull to obsolete (smaller subset).
    const obsoletes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    const rows = obsoletes; // include all obsoletes — show full picture

    const senderDist: Record<string, number> = {};
    const classDist: Record<string, number> = {};
    const outcomeDist: Record<string, number> = {};
    let totalWithHyggloOrderId = 0;
    let totalWithoutHyggloOrderId = 0;

    for (const r of rows) {
      const s = r.last_message_sender_at_obsolete ?? "<null>";
      senderDist[s] = (senderDist[s] ?? 0) + 1;
      const c = r.demand_loss_class ?? "<null>";
      classDist[c] = (classDist[c] ?? 0) + 1;
      const o = r.reclassified_outcome ?? "<null>";
      outcomeDist[o] = (outcomeDist[o] ?? 0) + 1;
      if (r.hygglo_order_id) totalWithHyggloOrderId++;
      else totalWithoutHyggloOrderId++;
    }

    let withReclassifiedAt = 0;
    let withoutReclassifiedAt = 0;
    for (const r of rows) {
      if (r.reclassified_at != null) withReclassifiedAt++;
      else withoutReclassifiedAt++;
    }

    return {
      total_obsoletes: rows.length,
      withReclassifiedAt,
      withoutReclassifiedAt,
      totalWithHyggloOrderId,
      totalWithoutHyggloOrderId,
      sender_distribution: senderDist,
      class_distribution: classDist,
      outcome_distribution: outcomeDist,
    };
  },
});

/** Sample 20 raw IDs from both tables to confirm shape match. */
export const compareIdShapes = query({
  args: {},
  handler: async (ctx) => {
    const msgs = await ctx.db.query("hygglo_messages").order("desc").take(10);
    const obsoletes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .take(10);

    return {
      sample_msg_thread_ids: msgs.map((m) => m.thread_id),
      sample_obsolete_order_ids: obsoletes.map((r) => r.hygglo_order_id),
    };
  },
});
