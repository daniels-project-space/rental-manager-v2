/**
 * Reply Inbox (2026-06-22) — cross-account "renter messages awaiting my reply"
 * queue for the dashboard widget.
 *
 * A thread is in the queue iff `conversations.last_sender === "renter"`
 * (stamped by hygglo.upsertMessages). Sending a reply flips it to "owner"
 * (recordSentReply) so the tile drops off until the renter messages again —
 * the whole "mirror chat into tiles that vanish once answered" behaviour is
 * pure data, no client-held dismissal state.
 *
 * Queries/mutations live here (Convex default runtime). The LLM draft + the
 * gated Hygglo send live in the sibling "use node" module
 * `replyInbox_actions.ts`.
 */
import { query, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// ── Queue ────────────────────────────────────────────────────────

/**
 * Every conversation whose latest message is from the renter (i.e. awaiting my
 * reply), joined with renter profile + reservation context + the latest message
 * preview, sorted most-urgent-first (oldest unanswered renter message on top).
 */
export const getReplyQueue = query({
  args: {
    accountSlug: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, limit = 50 }) => {
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_last_sender", (q) => q.eq("last_sender", "renter"))
      .collect();

    const tiles = [];
    for (const conv of convos) {
      // Reservation context (period / location / account / revenue). Inquiry
      // threads without an order yet simply have no reservation.
      const reservation = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) =>
          q.eq("hygglo_order_id", conv.thread_id),
        )
        .first();

      // Account slug: reservation → conversation → resolve via account_id.
      let slug = reservation?.account_slug ?? conv.account_slug ?? undefined;
      if (!slug && conv.account_id) {
        const acc = await ctx.db.get(conv.account_id);
        slug = acc?.slug;
      }
      if (accountSlug && slug !== accountSlug) continue;

      // Renter profile (rating / trust): prefer the reservation's FK.
      const renterId = reservation?.renter_id ?? conv.renter_id ?? undefined;
      const renter = renterId ? await ctx.db.get(renterId) : null;

      // Latest message in the thread — since last_sender === "renter" this is
      // the renter's unanswered message; use it for the tile preview.
      const latestMsg = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", conv.thread_id))
        .order("desc")
        .first();

      const renterName =
        renter?.display_name ??
        reservation?.renter_name ??
        latestMsg?.sender_name ??
        "Renter";

      tiles.push({
        thread_id: conv.thread_id,
        account_slug: slug ?? null,
        renter_name: renterName,
        renter_rating: renter?.hygglo_rating ?? null,
        renter_review_count: renter?.hygglo_review_count ?? null,
        renter_blacklisted: renter?.blacklisted ?? false,
        renter_flagged: renter?.flag_on_request ?? false,
        // Booking context (null for inquiry threads with no order).
        start_date: reservation?.start_date ?? null,
        end_date: reservation?.end_date ?? null,
        return_date: reservation?.return_date ?? null,
        pickup_method: reservation?.pickup_method ?? null,
        status: reservation?.status ?? null,
        order_step: reservation?.order_step ?? null,
        net_to_owner_gbp: reservation?.net_to_owner_gbp ?? null,
        items: (reservation?.items ?? [])
          .map((i) => i.item_name)
          .filter(Boolean)
          .slice(0, 3),
        // Urgency driver + preview.
        last_renter_msg_at: conv.last_renter_msg_at ?? conv.last_msg_at,
        last_msg_at: conv.last_msg_at,
        preview: latestMsg?.body_text ?? "",
        has_draft: !!conv.ai_draft_text,
        ai_draft_text: conv.ai_draft_text ?? null,
      });
    }

    // Oldest unanswered renter message first = most urgent at the top.
    tiles.sort(
      (a, b) => (a.last_renter_msg_at ?? 0) - (b.last_renter_msg_at ?? 0),
    );
    return tiles.slice(0, limit);
  },
});

// ── Draft context (consumed by replyInbox_actions.generateDraft) ──

export const getThreadContext = internalQuery({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();

    const reservation = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) =>
        q.eq("hygglo_order_id", thread_id),
      )
      .first();

    let slug = reservation?.account_slug ?? conv?.account_slug ?? undefined;
    let accountId = reservation?.account_id ?? conv?.account_id ?? undefined;
    if (!slug && accountId) {
      const acc = await ctx.db.get(accountId);
      slug = acc?.slug;
    }

    // Per-account persona / tone / discount codes for grounded drafting.
    let persona_prompt: string | undefined;
    let discount_codes: unknown;
    if (accountId) {
      const profile = await ctx.db
        .query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", accountId!))
        .first();
      persona_prompt = profile?.persona_prompt ?? profile?.persona ?? undefined;
      discount_codes = profile?.discount_codes;
    }

    const renterId = reservation?.renter_id ?? conv?.renter_id ?? undefined;
    const renter = renterId ? await ctx.db.get(renterId) : null;

    const msgs = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("asc")
      .take(40);
    const recent = msgs.slice(-15).map((m) => ({
      role: m.sender === "owner" ? "owner" : "renter",
      content: m.body_text,
    }));
    const latest = msgs[msgs.length - 1];

    return {
      account_slug: slug ?? null,
      persona_prompt: persona_prompt ?? null,
      discount_codes: discount_codes ?? null,
      renter_name:
        renter?.display_name ?? reservation?.renter_name ?? "the renter",
      items: (reservation?.items ?? []).map((i) => i.item_name).filter(Boolean),
      start_date: reservation?.start_date ?? null,
      end_date: reservation?.end_date ?? null,
      return_date: reservation?.return_date ?? null,
      pickup_method: reservation?.pickup_method ?? null,
      status: reservation?.status ?? null,
      messages: recent,
      last_message_id: latest?.message_id ?? null,
    };
  },
});

// ── Draft cache write (called by generateDraft action) ────────────

export const setDraft = internalMutation({
  args: {
    thread_id: v.string(),
    draft_text: v.string(),
    message_id: v.optional(v.string()),
  },
  handler: async (ctx, { thread_id, draft_text, message_id }) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    if (!conv) return { ok: false };
    await ctx.db.patch(conv._id, {
      ai_draft_text: draft_text,
      ai_draft_for_message_id: message_id,
      ai_draft_generated_at: Date.now(),
    });
    return { ok: true };
  },
});

// ── Post-send bookkeeping (called by sendRenterReply action) ──────

/**
 * After a reply is sent live to Hygglo, flip the conversation to owner-last so
 * the tile leaves the queue immediately, and clear any cached draft. We do NOT
 * insert a synthetic owner message — the real one lands on the next poll
 * (≤15 min), avoiding a duplicate bubble; the widget shows the just-sent text
 * optimistically in the open thread in the meantime.
 */
export const recordSentReply = internalMutation({
  args: { thread_id: v.string(), account_slug: v.optional(v.string()) },
  handler: async (ctx, { thread_id, account_slug }) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    const now = Date.now();
    if (conv) {
      await ctx.db.patch(conv._id, {
        last_sender: "owner",
        last_msg_at: now,
        ai_draft_text: undefined,
        ai_draft_for_message_id: undefined,
        ai_draft_generated_at: undefined,
      });
      return { ok: true };
    }
    // Defensive: thread with no conversation row yet — create one owner-last.
    await ctx.db.insert("conversations", {
      thread_id,
      account_slug,
      last_msg_at: now,
      last_sender: "owner",
      created_at: now,
    });
    return { ok: true };
  },
});
