// convex/audit_reclassification.ts
// READ-ONLY queries for Phase 3 reclassification validation.
// Source: /tmp/audit_reclassification.md §3. No DB writes.
//
// Run:
//   npx convex run audit_reclassification:auditClassificationCoverage
//   npx convex run audit_reclassification:auditObsoleteSample '{"n":50}'
//   npx convex run audit_reclassification:auditChatKeywordHits
//   npx convex run audit_reclassification:auditGhostingCandidates
//   npx convex run audit_reclassification:auditPaidCancelledActorSplit

import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { classifyRow } from "./demand_loss";

const DAY_MS = 86_400_000;

// ─── Query 1: random obsolete sample with all joined signals ───
export const auditObsoleteSample = query({
  args: { n: v.optional(v.number()) },
  handler: async (ctx, { n }) => {
    const sampleSize = n ?? 50;
    const all = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    // Fisher-Yates partial shuffle for randomness
    const sample = all.slice();
    for (let i = sample.length - 1; i > sample.length - 1 - sampleSize && i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [sample[i], sample[j]] = [sample[j], sample[i]];
    }
    const picked = sample.slice(-sampleSize);

    const rows: Array<Record<string, unknown>> = [];
    for (const r of picked) {
      let lastMsg: Doc<"hygglo_messages"> | null = null;
      let msgCount = 0;
      if (r.hygglo_order_id) {
        const msgs = await ctx.db
          .query("hygglo_messages")
          .withIndex("by_thread", (q) => q.eq("thread_id", r.hygglo_order_id as string))
          .collect();
        msgCount = msgs.length;
        msgs.sort(
          (a, b) =>
            ((a.hygglo_sent_at ?? a.fetched_at) ?? 0) -
            ((b.hygglo_sent_at ?? b.fetched_at) ?? 0),
        );
        lastMsg = msgs[msgs.length - 1] ?? null;
      }
      const lastTs = lastMsg?.hygglo_sent_at ?? lastMsg?.fetched_at;
      const daysSince = lastTs ? Math.round((Date.now() - lastTs) / DAY_MS) : null;
      rows.push({
        _id: r._id,
        hygglo_order_id: r.hygglo_order_id,
        created: new Date(r._creationTime).toISOString().slice(0, 10),
        start_date: r.start_date,
        item: (r.items ?? [])
          .map((i: { item_name?: string }) => i.item_name ?? "")
          .join(" + ")
          .slice(0, 60),
        obsolete_reason: r.obsolete_reason,
        order_step: r.order_step,
        paid_gbp: r.gross_paid_gbp ?? 0,
        msg_count: msgCount,
        last_sender: lastMsg?.sender ?? null,
        last_msg_preview: (lastMsg?.body_text ?? "").slice(0, 120),
        days_since_last_msg: daysSince,
        current_class: classifyRow(r),
      });
    }
    return { sampled: rows.length, total_obsolete: all.length, rows };
  },
});

// ─── Query 2: classification coverage matrix ───
export const auditClassificationCoverage = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    const counts: Record<string, number> = {};
    for (const r of all) {
      const reason = r.obsolete_reason ?? "undefined";
      const step = r.order_step ?? "null";
      const paidBucket = (r.gross_paid_gbp ?? 0) > 0 ? "paid" : "unpaid";
      const key = `${reason}|${step}|${paidBucket}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const matrix = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, val]) => {
        const [obsolete_reason, order_step, paid] = k.split("|");
        return { obsolete_reason, order_step, paid, count: val };
      });
    return { total: all.length, matrix };
  },
});

// ─── Query 3: keyword hit counts on obsolete-row chat threads ───
export const auditChatKeywordHits = query({
  args: {},
  handler: async (ctx) => {
    const OWNER_CANCEL_RE =
      /\b(can(?:'|no)?t(?:\s+do|\s+rent|\s+make)|cannot|unable|not\s+available|unavailable|already\s+(?:booked|rented|out)|double[-\s]?book|broken|not\s+working|damaged|have\s+to\s+cancel|need\s+to\s+cancel|I[' ]?m?\s+cancel{1,2}ing|won't\s+work\s+for\s+me)\b/i;
    const RENTER_CANCEL_RE =
      /\b(don'?t\s+need|no\s+longer\s+need|cancel(?:l?ed|l?ing|l?ation)?|refund|changed\s+my\s+mind|found\s+(?:another|elsewhere|cheaper)|won'?t\s+need)\b/i;
    const OWNER_APPROVAL_RE =
      /\b(approved|go\s+ahead|confirmed|works\s+for\s+me|sounds\s+good|pick\s*up\s+(?:at|on))\b/i;

    const obsoletes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();

    let ownerCancelHits = 0,
      renterCancelHits = 0,
      ownerApprovalHits = 0;
    let threadsScanned = 0,
      threadsWithMessages = 0;
    const examples: { kind: string; text: string; thread: string }[] = [];

    for (const r of obsoletes) {
      if (!r.hygglo_order_id) continue;
      threadsScanned++;
      const msgs = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", r.hygglo_order_id as string))
        .collect();
      if (msgs.length === 0) continue;
      threadsWithMessages++;
      for (const m of msgs) {
        if (m.sender === "owner" && OWNER_CANCEL_RE.test(m.body_text)) {
          ownerCancelHits++;
          if (examples.filter((e) => e.kind === "owner_cancel").length < 5) {
            examples.push({
              kind: "owner_cancel",
              text: m.body_text.slice(0, 160),
              thread: r.hygglo_order_id as string,
            });
          }
        }
        if (m.sender === "renter" && RENTER_CANCEL_RE.test(m.body_text)) {
          renterCancelHits++;
          if (examples.filter((e) => e.kind === "renter_cancel").length < 5) {
            examples.push({
              kind: "renter_cancel",
              text: m.body_text.slice(0, 160),
              thread: r.hygglo_order_id as string,
            });
          }
        }
        if (m.sender === "owner" && OWNER_APPROVAL_RE.test(m.body_text)) {
          ownerApprovalHits++;
        }
      }
    }
    return {
      threadsScanned,
      threadsWithMessages,
      ownerCancelHits,
      renterCancelHits,
      ownerApprovalHits,
      examples,
    };
  },
});

// ─── Query 4: structural ghosting candidates ───
export const auditGhostingCandidates = query({
  args: {},
  handler: async (ctx) => {
    const NOW = Date.now();
    const obsoletes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    const candidates: Array<Record<string, unknown>> = [];
    for (const r of obsoletes) {
      const paid = r.gross_paid_gbp ?? 0;
      if (paid > 0) continue;
      const step = r.order_step;
      if (
        !(step === "APPROVED" || step === "REQUEST" || step === "FUNDS_RESERVED" || step === "CANCELED")
      )
        continue;
      if (!r.hygglo_order_id) continue;
      const msgs = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", r.hygglo_order_id as string))
        .collect();
      if (msgs.length === 0) continue;
      msgs.sort(
        (a, b) =>
          ((a.hygglo_sent_at ?? a.fetched_at) ?? 0) -
          ((b.hygglo_sent_at ?? b.fetched_at) ?? 0),
      );
      const last = msgs[msgs.length - 1];
      const lastTs = last.hygglo_sent_at ?? last.fetched_at ?? 0;
      const daysSince = (NOW - lastTs) / DAY_MS;
      if (last.sender === "owner" && daysSince >= 7) {
        candidates.push({
          _id: r._id,
          item: (r.items ?? [])
            .map((i: { item_name?: string }) => i.item_name ?? "")
            .join(" + ")
            .slice(0, 60),
          order_step: step,
          current_class: classifyRow(r),
          last_owner_msg: last.body_text.slice(0, 120),
          days_since: Math.round(daysSince),
        });
      }
    }
    return { count: candidates.length, candidates: candidates.slice(0, 100) };
  },
});

// ─── Query 5: paid-but-CANCELED actor split (highest-£ ambiguity) ───
export const auditPaidCancelledActorSplit = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    const targets = rows.filter(
      (r) => r.obsolete_reason === "renter_cancelled" && (r.gross_paid_gbp ?? 0) > 0,
    );
    const out: Array<Record<string, unknown>> = [];
    for (const r of targets) {
      let lastSender: string | null = null;
      let preview = "";
      if (r.hygglo_order_id) {
        const msgs = await ctx.db
          .query("hygglo_messages")
          .withIndex("by_thread", (q) => q.eq("thread_id", r.hygglo_order_id as string))
          .collect();
        msgs.sort(
          (a, b) =>
            ((a.hygglo_sent_at ?? a.fetched_at) ?? 0) -
            ((b.hygglo_sent_at ?? b.fetched_at) ?? 0),
        );
        const last = msgs[msgs.length - 1];
        lastSender = last?.sender ?? null;
        preview = (last?.body_text ?? "").slice(0, 160);
      }
      out.push({
        _id: r._id,
        item: (r.items ?? [])
          .map((i: { item_name?: string }) => i.item_name ?? "")
          .join(" + ")
          .slice(0, 60),
        paid_gbp: r.gross_paid_gbp,
        last_sender: lastSender,
        last_msg_preview: preview,
      });
    }
    return { total_paid_cancelled: targets.length, sample: out.slice(0, 100) };
  },
});
