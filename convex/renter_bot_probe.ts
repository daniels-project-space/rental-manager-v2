/**
 * renter_bot_probe (2026-07-03) — TEST-ONLY harness to run the REAL generateDraft
 * pipeline against synthetic dbcinema/leo inquiry threads, for the v1-vs-v2
 * question battery + validation. Threads use the `__probe__` prefix and are
 * removed by `cleanup`. Also used by Lab sessions; never used to send renter messages.
 */
import { action, internalMutation, mutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { DraftEvidence } from "./lib/renter_draft_evidence";
import { LAB_THREAD_PREFIX } from "./lib/renter_booking";
import { bestMatch } from "./lib/item_name_match";

// Exported so other modules (e.g. replyInbox.ts's getReplyQueue) can exclude
// probe/fixture threads from real UI surfaces without duplicating the string.
export const PREFIX = LAB_THREAD_PREFIX;

export const seed = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    stage: v.optional(v.string()),
    items: v.array(v.object({ name: v.string(), product_id: v.optional(v.number()) })),
    messages: v.array(v.object({ role: v.string(), text: v.string() })),
    /**
     * Seed isolated CONFIRMED booking facts for this test thread.
     *
     * Without one the bot always reads the thread as an enquiry, because
     * confirmation comes from authoritative booking status — not the conversation
     * stage. That made an arrival scenario ("I'm outside now") untestable:
     * the probe said CONFIRMED and the bot correctly answered "this request
     * hasn't been confirmed yet", so the test was measuring an incoherent
     * situation rather than a defect.
     */
    confirmed_booking: v.optional(
      v.object({ start_date: v.string(), end_date: v.string() }),
    ),
    /**
     * A booking at ANY lifecycle stage, not just confirmed.
     *
     * The whole point of stage-aware behaviour is that what the bot should say
     * changes as a rental moves: upsell while it is an enquiry, chase
     * verification while pending, only then hand over address and times, then
     * be useful during and after. Testing that needs pending_review, cancelled
     * and completed too — `confirmed_booking` could only ever express one
     * point on that line.
     */
    booking: v.optional(
      v.object({
        status: v.string(),
        start_date: v.string(),
        end_date: v.string(),
        gross_paid_gbp: v.optional(v.number()),
        is_obsolete: v.optional(v.boolean()),
        pickup_date: v.optional(v.string()),
        return_date: v.optional(v.string()),
        // The real Hygglo lifecycle, in order. Keeping the literal union
        // rather than a loose string means a probe cannot invent a stage that
        // production can never be in.
        order_step: v.optional(
          v.union(
            v.literal("REQUEST"),
            v.literal("APPROVED"),
            v.literal("FUNDS_RESERVED"),
            v.literal("VERIFIED"),
            v.literal("BOOKED_AFTER_VERIFIED"),
            v.literal("DELIVERED"),
            v.literal("RETURNED"),
            v.literal("REVIEWED"),
            v.literal("CANCELED"),
            v.literal("VERIFICATION_FAILED"),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx, { thread_id, account_slug, stage, items, messages, confirmed_booking, booking }) => {
    if (!thread_id.startsWith(PREFIX)) throw new Error("Probe seeding cannot touch a real conversation");
    const acc = (await ctx.db.query("accounts").collect()).find(
      (a) => a.slug === account_slug,
    );
    // wipe any prior probe rows for this thread
    for (const m of await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .collect())
      await ctx.db.delete(m._id);
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    if (existing) await ctx.db.delete(existing._id);

    const now = Date.now();
    const STAGES = ["INQUIRY", "INTERESTED", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "COMPLETED", "DEAD"] as const;
    const cs = stage && (STAGES as readonly string[]).includes(stage)
      ? (stage as (typeof STAGES)[number])
      : undefined;
    await ctx.db.insert("conversations", {
      thread_id,
      account_id: acc?._id,
      account_slug,
      last_msg_at: now,
      last_sender: "renter",
      last_renter_msg_at: now,
      created_at: now,
      conversation_stage: cs,
      inquiry_items: items.map((i) => ({ name: i.name, qty: 1, product_id: i.product_id })),
    });
    let i = 0;
    for (const msg of messages) {
      await ctx.db.insert("hygglo_messages", {
        account_slug,
        thread_id,
        message_id: `${thread_id}-m${i}`,
        sender: msg.role === "owner" ? "owner" : "renter",
        sender_name: msg.role === "owner" ? "Owner" : "DB Cinema Rentals",
        body_text: msg.text,
        hygglo_sent_at: now - (messages.length - i) * 60000,
        fetched_at: now,
      });
      i++;
    }
    // Simulation lifecycle facts never enter the production reservations table.
    for (const old of await ctx.db.query("renter_bot_lab_bookings")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id)).collect())
      await ctx.db.delete(old._id);
    const bk = booking ?? (confirmed_booking ? { status: "confirmed", ...confirmed_booking } : null);
    if (bk) {
      // expanded_items matter as much as the reservation itself: item
      // grounding is derived from them, and without it UNGROUNDED_PRICE fires
      // CRITICAL on any £ figure and the whole reply is withheld. A probe
      // reservation without them tests a broken booking, not a normal one.
      const owned = (await ctx.db.query("items").collect()).filter(
        (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
      );
      const expanded: Array<{
        item_id: Id<"items">;
        item_name_canonical: string;
        qty: number;
      }> = [];
      for (const i of items) {
        const m = bestMatch(
          i.name,
          owned,
          (x) => x.name_canonical,
          (x) => (x.aliases ?? []) as string[],
        );
        if (m.match && m.confident)
          expanded.push({
            item_id: m.match._id,
            item_name_canonical: m.match.name_canonical,
            qty: 1,
          });
      }
      await ctx.db.insert("renter_bot_lab_bookings", {
        hygglo_order_id: thread_id,
        account_slug,
        status: bk.status,
        ...("is_obsolete" in bk ? {is_obsolete: bk.is_obsolete} : {}),
        ...("pickup_date" in bk ? {pickup_date: bk.pickup_date} : {}),
        ...("return_date" in bk ? {return_date: bk.return_date} : {}),
        renter_name: "Probe Renter",
        start_date: bk.start_date,
        end_date: bk.end_date,
        ...(("gross_paid_gbp" in bk && bk.gross_paid_gbp != null)
          ? { gross_paid_gbp: bk.gross_paid_gbp }
          : {}),
        ...(("order_step" in bk && bk.order_step) ? { order_step: bk.order_step } : {}),
        items: items.map((i) => ({ item_name: i.name, qty: 1 })),
        hygglo_items: items.map((i) => ({ name: i.name, qty: 1, product_id: i.product_id, image_url: null, type: "listing" })),
        expanded_items: expanded,
        created_at: now,
      });
    }
    return { thread_id };
  },
});

export const run = action({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    stage: v.optional(v.string()),
    items: v.array(v.object({ name: v.string(), product_id: v.optional(v.number()) })),
    messages: v.array(v.object({ role: v.string(), text: v.string() })),
    confirmed_booking: v.optional(
      v.object({ start_date: v.string(), end_date: v.string() }),
    ),
    booking: v.optional(
      v.object({
        status: v.string(),
        start_date: v.string(),
        end_date: v.string(),
        gross_paid_gbp: v.optional(v.number()),
        order_step: v.optional(
          v.union(
            v.literal("REQUEST"),
            v.literal("APPROVED"),
            v.literal("FUNDS_RESERVED"),
            v.literal("VERIFIED"),
            v.literal("BOOKED_AFTER_VERIFIED"),
            v.literal("DELIVERED"),
            v.literal("RETURNED"),
            v.literal("REVIEWED"),
            v.literal("CANCELED"),
            v.literal("VERIFICATION_FAILED"),
          ),
        ),
      }),
    ),
    /** Model to run this probe on. Probe threads only. */
    model_override: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ status: "ok" | "skipped"; reason?: string; model_id?: string; evidence?: DraftEvidence; diagnostic_candidate?: string; draft?: string; confidence?: number; flags?: unknown }> => {
    // model_override belongs to the DRAFT call, not the seed — passing the
    // whole args object through made seed's validator reject the extra field
    // and every bake-off run returned no draft at all, which then scored as
    // "0 violations" for every model. A silent-looking pass built on nothing.
    const { model_override, ...seedArgs } = a;
    await ctx.runMutation(internal.renter_bot_probe.seed, seedArgs);
    const r = await ctx.runAction(api.replyInbox_actions.generateDraft, {
      thread_id: a.thread_id,
      ...(model_override ? { model_override } : {}),
    });
    return { status: r.status, reason: r.reason, model_id: r.model_id, evidence: r.evidence, diagnostic_candidate: r.diagnostic_candidate, draft: r.draft, confidence: r.confidence, flags: r.flags };
  },
});

/**
 * Lab sends deliberately cannot schedule production learning. Real manual-send
 * learning is exercised only on genuine conversations through its existing gate.
 */
export const simulateSend = action({
  args: {
    thread_id: v.string(),
    account_slug: v.optional(v.string()),
    sent_text: v.string(),
    draft_text: v.optional(v.string()),
  },
  handler: async (_ctx, a): Promise<{ scheduled: false; reason: string }> => {
    if (!a.thread_id.startsWith(PREFIX)) throw new Error("Lab learning simulation cannot target a real conversation");
    return { scheduled: false, reason: "Lab conversations cannot update production drafting lessons" };
  },
});

export const cleanup = mutation({
  args: { thread_id: v.optional(v.string()) },
  handler: async (ctx, { thread_id }) => {
    if (thread_id && !thread_id.startsWith(PREFIX)) throw new Error("Only Lab/probe sessions can be removed");
    const matches = (id: string) => id.startsWith(PREFIX) && (!thread_id || id === thread_id);
    let n = 0;
    const convs = await ctx.db.query("conversations").withIndex("by_thread", (q) => thread_id ? q.eq("thread_id", thread_id) : q.gte("thread_id", PREFIX).lt("thread_id", `${PREFIX}\uffff`)).collect();
    for (const c of convs) {
      for (const m of await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.thread_id))
        .collect())
        await ctx.db.delete(m._id);
      // generateDraft caches its output in renter_bot_drafts (keyed by
      // thread_id) — that must be swept too, or a probe run leaves a
      // phantom draft behind after its conversation/messages are gone.
      for (const d of await ctx.db
        .query("renter_bot_drafts")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.thread_id))
        .collect())
        await ctx.db.delete(d._id);
      await ctx.db.delete(c._id);
      n++;
    }
    for (const r of await ctx.db.query("renter_bot_lab_bookings").withIndex("by_hygglo_order_id", (q) => thread_id ? q.eq("hygglo_order_id", thread_id) : q.gte("hygglo_order_id", PREFIX).lt("hygglo_order_id", `${PREFIX}\uffff`)).collect())
      if (r.hygglo_order_id && matches(r.hygglo_order_id)) await ctx.db.delete(r._id);
    for (const order of await ctx.db.query("renter_bot_lab_orders").withIndex("by_thread", (q) => thread_id ? q.eq("thread_id", thread_id) : q.gte("thread_id", PREFIX).lt("thread_id", `${PREFIX}\uffff`)).collect())
      if (matches(order.thread_id)) await ctx.db.delete(order._id);
    for (const referral of await ctx.db.query("renter_bot_lab_referrals").withIndex("by_source", q => thread_id ? q.eq("source_thread_id", thread_id) : q.gte("source_thread_id", PREFIX).lt("source_thread_id", `${PREFIX}\uffff`)).collect())
      if (matches(referral.source_thread_id)) await ctx.db.delete(referral._id);
    return { removed: n };
  },
});

/** Atomic, prefix-bounded migration of old synthetic bookings; real rows are untouched. */
export const isolateLegacyBookings = internalMutation({
  args: {},
  handler: async (ctx) => {
    const legacy = await ctx.db.query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.gte("hygglo_order_id", PREFIX).lt("hygglo_order_id", `${PREFIX}\uffff`)).collect();
    let moved = 0;
    for (const row of legacy) {
      if (!row.hygglo_order_id?.startsWith(PREFIX)) throw new Error("Refusing to migrate a real booking");
      const existing = await ctx.db.query("renter_bot_lab_bookings")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", row.hygglo_order_id)).first();
      if (!existing) {
        const { _id, _creationTime, ...facts } = row;
        await ctx.db.insert("renter_bot_lab_bookings", facts);
      }
      await ctx.db.delete(row._id);
      moved++;
    }
    return { moved, real_reservations_changed: 0 };
  },
});
