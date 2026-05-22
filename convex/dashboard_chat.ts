import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ────────────────────────────────────────────────────

export const getMessages = query({
  args: {
    thread_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const limit = args.limit ?? 50;
    // Latest N messages, returned in ascending (oldest-first) order for the
    // UI. order("asc").take(N) silently returned the OLDEST 50 once the
    // thread exceeded 50 rows, so new turns never appeared in the chat.
    const rows = await ctx.db
      .query("dashboard_chat_messages")
      .withIndex("by_thread_and_time", (q) => q.eq("thread_id", thread_id))
      .order("desc")
      .take(limit);
    return rows.reverse();
  },
});

// ── Mutations ──────────────────────────────────────────────────

export const appendMessage = mutation({
  args: {
    thread_id: v.optional(v.string()),
    role: v.string(),
    content: v.string(),
    tool_name: v.optional(v.string()),
    tool_call_id: v.optional(v.string()),
    metadata: v.optional(v.string()),
    // Optional override for backfill/migration scripts that need to preserve
    // historical timestamps. New chat turns always omit this.
    created_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const id = await ctx.db.insert("dashboard_chat_messages", {
      thread_id,
      role: args.role,
      content: args.content,
      tool_name: args.tool_name,
      tool_call_id: args.tool_call_id,
      metadata: args.metadata,
      created_at: args.created_at ?? Date.now(),
    });
    return id;
  },
});

export const appendMessages = mutation({
  args: {
    thread_id: v.optional(v.string()),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        tool_name: v.optional(v.string()),
        tool_call_id: v.optional(v.string()),
        metadata: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < args.messages.length; i++) {
      const m = args.messages[i];
      const id = await ctx.db.insert("dashboard_chat_messages", {
        thread_id,
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        metadata: m.metadata,
        created_at: now + i,
      });
      ids.push(id);
    }
    return ids;
  },
});

export const clearThread = mutation({
  args: { thread_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const rows = await ctx.db
      .query("dashboard_chat_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .collect();
    await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
    return { deleted: rows.length };
  },
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3 — WallE assistant widget surface.
// `streamContext` builds the chat system prompt input: last N turns +
// a fresh live-signal snapshot. `appendTurn` writes user+assistant turns
// with a sessionId; old turns compact into a single summary on session
// reload (Phase 5 triggers the compaction). `getJokeQuota` + `recordJoke`
// enforce the 2-jokes-per-day-per-user cap.
// ─────────────────────────────────────────────────────────────────────

// Local helpers — duplicated from dashboard_insights to keep this file
// self-contained for downstream WallE chat-route imports (the route reads
// streamContext only; signal queries are referenced via api.* paths).
function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoNDaysAgoUtc(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function isLiveStatus(s: string | undefined | null): boolean {
  if (!s) return false;
  return s === "confirmed" || s === "completed";
}

/**
 * streamContext — returns last 10 chat turns for a thread plus a fresh
 * signal snapshot. Consumed by the WallE chat API route to assemble the
 * system prompt.
 *
 * Snapshot fields:
 *   pendingCount         — reservations awaiting owner review.
 *   conflictCount        — active (non-dismissed) double-bookings.
 *   mtdRevenue           — month-to-date gross_paid_gbp.
 *   topUtilizationDelta  — biggest mover (|deltaPct|) in last 7d vs prior 7d.
 */
export const streamContext = query({
  args: {
    thread_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const limit = args.limit ?? 10;

    // Last N turns (oldest-first for prompt-building).
    const turns = (
      await ctx.db
        .query("dashboard_chat_messages")
        .withIndex("by_thread_and_time", (q) => q.eq("thread_id", thread_id))
        .order("desc")
        .take(limit)
    ).reverse();

    // ── Fresh signal snapshot (inline, no cross-file calls) ──
    const allRes = await ctx.db.query("reservations").collect();

    // pendingCount: status = "pending_review".
    const pendingCount = allRes.filter((r) => r.status === "pending_review").length;

    // conflictCount: replicates getActiveConflicts but only the count.
    const dismissed = new Set<string>(
      (await ctx.db.query("conflict_dismissals").collect()).map((d) => d.conflict_key),
    );
    const lookback = isoNDaysAgoUtc(14);
    const live = allRes.filter(
      (r) =>
        isLiveStatus(r.status) &&
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.end_date >= lookback,
    );
    const buckets = new Map<string, { item_id: string; rows: typeof live }>();
    for (const r of live) {
      const items = r.expanded_items ?? r.resolved_items ?? [];
      for (const ei of items) {
        const k = ei.item_id as unknown as string;
        const cur = buckets.get(k);
        if (cur) cur.rows.push(r);
        else buckets.set(k, { item_id: k, rows: [r] });
      }
    }
    let conflictCount = 0;
    for (const b of buckets.values()) {
      if (b.rows.length < 2) continue;
      let hasOverlap = false;
      const seen = new Set<string>();
      for (let i = 0; i < b.rows.length && !hasOverlap; i++) {
        for (let j = i + 1; j < b.rows.length; j++) {
          if (b.rows[i].start_date! <= b.rows[j].end_date! && b.rows[j].start_date! <= b.rows[i].end_date!) {
            hasOverlap = true;
            for (const r of b.rows) seen.add(r._id as unknown as string);
            break;
          }
        }
      }
      if (!hasOverlap) continue;
      const key = `${b.item_id}|${[...seen].sort().join(",")}`;
      if (!dismissed.has(key)) conflictCount += 1;
    }

    // mtdRevenue.
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const curStart = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
    const curEnd = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
    let mtdRevenue = 0;
    for (const r of allRes) {
      if (!isLiveStatus(r.status)) continue;
      if (!r.start_date) continue;
      if (r.start_date >= curStart && r.start_date <= curEnd) {
        mtdRevenue += r.gross_paid_gbp ?? 0;
      }
    }
    mtdRevenue = Math.round(mtdRevenue * 100) / 100;

    // topUtilizationDelta — find biggest mover this week vs last.
    const today = todayIsoUtc();
    const start7 = isoNDaysAgoUtc(7);
    const start14 = isoNDaysAgoUtc(14);
    const dayMs = 86400000;
    const tToday = Date.parse(today + "T00:00:00Z");
    const t7 = Date.parse(start7 + "T00:00:00Z");
    const t14 = Date.parse(start14 + "T00:00:00Z");
    function overlapDays(sIso: string, eIso: string, ws: number, we: number): number {
      const s = Date.parse(sIso + "T00:00:00Z");
      const e = Date.parse(eIso + "T00:00:00Z");
      const lo = Math.max(s, ws);
      const hi = Math.min(e, we);
      if (hi < lo) return 0;
      return Math.max(1, Math.round((hi - lo) / dayMs) + 1);
    }
    const recent = allRes.filter(
      (r) =>
        isLiveStatus(r.status) &&
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.end_date >= start14,
    );
    type UAcc = { name: string; cur: number; prev: number };
    const uagg = new Map<string, UAcc>();
    for (const r of recent) {
      const items = r.expanded_items ?? r.resolved_items ?? [];
      for (const ei of items) {
        const k = ei.item_id as unknown as string;
        const qty = (ei as { qty?: number }).qty ?? 1;
        const dC = overlapDays(r.start_date!, r.end_date!, t7, tToday) * qty;
        const dP = overlapDays(r.start_date!, r.end_date!, t14, t7 - dayMs) * qty;
        const cur = uagg.get(k);
        if (cur) {
          cur.cur += dC;
          cur.prev += dP;
        } else {
          uagg.set(k, { name: ei.item_name_canonical, cur: dC, prev: dP });
        }
      }
    }
    let topUtilizationDelta: { name: string; deltaPct: number } | null = null;
    for (const a of uagg.values()) {
      const base = a.prev === 0 ? Math.max(a.cur, 1) : a.prev;
      const d = ((a.cur - a.prev) / base) * 100;
      if (!topUtilizationDelta || Math.abs(d) > Math.abs(topUtilizationDelta.deltaPct)) {
        topUtilizationDelta = { name: a.name, deltaPct: Math.round(d * 10) / 10 };
      }
    }

    return {
      turns: turns.map((t) => ({
        role: t.role,
        content: t.content,
        created_at: t.created_at,
      })),
      snapshot: {
        pendingCount,
        conflictCount,
        mtdRevenue,
        topUtilizationDelta,
      },
    };
  },
});

/**
 * appendTurn — write a user + assistant pair for a WallE session. Each
 * turn is tagged with a sessionId in `metadata` so a session-close
 * compaction can summarise them later.
 *
 * The dashboard_chat_messages table doesn't have a dedicated session_id
 * column to preserve schema-stability; we pack the WallE-specific fields
 * (sessionId, compactedAt) into the existing `metadata` JSON string.
 */
export const appendTurn = mutation({
  args: {
    thread_id: v.optional(v.string()),
    session_id: v.string(),
    user_content: v.string(),
    assistant_content: v.string(),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "walle";
    const now = Date.now();
    const meta = JSON.stringify({ sessionId: args.session_id, compactedAt: null });
    const uid = await ctx.db.insert("dashboard_chat_messages", {
      thread_id,
      role: "user",
      content: args.user_content,
      metadata: meta,
      created_at: now,
    });
    const aid = await ctx.db.insert("dashboard_chat_messages", {
      thread_id,
      role: "assistant",
      content: args.assistant_content,
      metadata: meta,
      created_at: now + 1,
    });
    return { user_id: uid, assistant_id: aid };
  },
});

/**
 * compactSession — Phase 5 trigger. Collapses all non-compacted turns
 * for a session into a single assistant "summary" turn, deletes the
 * originals, and stamps the summary's metadata with compactedAt.
 * Caller supplies the pre-generated summary string (built by the chat
 * route from the turns themselves; no LLM call inside Convex).
 */
export const compactSession = mutation({
  args: {
    thread_id: v.optional(v.string()),
    session_id: v.string(),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "walle";
    const all = await ctx.db
      .query("dashboard_chat_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .collect();
    const targets = all.filter((m) => {
      if (!m.metadata) return false;
      try {
        const parsed = JSON.parse(m.metadata) as { sessionId?: string; compactedAt?: number | null };
        return parsed.sessionId === args.session_id && !parsed.compactedAt;
      } catch {
        return false;
      }
    });
    if (targets.length === 0) return { compacted: 0 };
    const now = Date.now();
    await ctx.db.insert("dashboard_chat_messages", {
      thread_id,
      role: "assistant",
      content: args.summary,
      metadata: JSON.stringify({ sessionId: args.session_id, compactedAt: now, summary: true }),
      created_at: now,
    });
    await Promise.all(targets.map((t) => ctx.db.delete(t._id)));
    return { compacted: targets.length };
  },
});

// ── Joke quota ───────────────────────────────────────────────────────
// 2 jokes per user per day. Day is YYYY-MM-DD (UTC).

export const getJokeQuota = query({
  args: { user_id: v.string() },
  handler: async (ctx, args) => {
    const day = todayIsoUtc();
    const row = await ctx.db
      .query("walle_joke_log")
      .withIndex("by_user_day", (q) => q.eq("user_id", args.user_id).eq("day", day))
      .first();
    const used = row?.count ?? 0;
    const cap = 2;
    return {
      used,
      cap,
      remaining: Math.max(0, cap - used),
      day,
    };
  },
});

export const recordJoke = mutation({
  args: { user_id: v.string() },
  handler: async (ctx, args) => {
    const day = todayIsoUtc();
    const row = await ctx.db
      .query("walle_joke_log")
      .withIndex("by_user_day", (q) => q.eq("user_id", args.user_id).eq("day", day))
      .first();
    const cap = 2;
    if (row) {
      if (row.count >= cap) {
        return { ok: false, reason: "quota_exhausted", used: row.count, cap };
      }
      await ctx.db.patch(row._id, { count: row.count + 1, updated_at: Date.now() });
      return { ok: true, used: row.count + 1, cap };
    }
    await ctx.db.insert("walle_joke_log", {
      user_id: args.user_id,
      day,
      count: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    return { ok: true, used: 1, cap };
  },
});
