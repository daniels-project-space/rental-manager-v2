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
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

type RichItem = { name: string; qty: number; image_url: string | null };

/**
 * Per-item name + qty + thumbnail for the reply tile / draft context. Image
 * source priority: hygglo_items[] (authoritative per-item imagery) →
 * image_hints[] matched by normalised name → items[] (name/qty only, no image).
 */
function buildRichItems(reservation: Doc<"reservations"> | null): RichItem[] {
  if (!reservation) return [];
  const hints = reservation.image_hints ?? [];
  const hintFor = (name: string): string | null =>
    hints.find((h) => h.item_name_normalised === name.trim().toLowerCase())
      ?.image_url ?? null;
  const hItems = reservation.hygglo_items ?? [];
  if (hItems.length > 0) {
    return hItems.map((h) => ({
      name: h.name,
      qty: h.qty ?? 1,
      image_url: h.image_url ?? hintFor(h.name ?? ""),
    }));
  }
  return (reservation.items ?? []).map((i) => ({
    name: i.item_name,
    qty: i.qty ?? 1,
    image_url: hintFor(i.item_name ?? ""),
  }));
}

// ── Queue ────────────────────────────────────────────────────────

/**
 * Every conversation whose latest message is from the renter (i.e. awaiting my
 * reply), joined with renter profile + reservation context + the latest message
 * preview, sorted most-urgent-first (oldest unanswered renter message on top).
 */
/**
 * Build one reply-queue tile from a conversation and/or reservation. Shared by
 * the renter-last pass and the always-include REQUEST pass so both emit an
 * identical shape (item thumbnails, booking/request context, urgency driver).
 */
async function assembleTile(
  ctx: QueryCtx,
  conv: Doc<"conversations"> | null,
  reservation: Doc<"reservations"> | null,
  threadId: string,
) {
  let slug = reservation?.account_slug ?? conv?.account_slug ?? undefined;
  if (!slug && conv?.account_id) slug = (await ctx.db.get(conv.account_id))?.slug;
  if (!slug && reservation?.account_id)
    slug = (await ctx.db.get(reservation.account_id))?.slug;

  const renterId = reservation?.renter_id ?? conv?.renter_id ?? undefined;
  const renter = renterId ? await ctx.db.get(renterId) : null;

  const latestMsg = await ctx.db
    .query("hygglo_messages")
    .withIndex("by_thread", (q) => q.eq("thread_id", threadId))
    .order("desc")
    .first();

  const richItems = buildRichItems(reservation);
  const primaryImage =
    richItems.find((i) => i.image_url)?.image_url ??
    reservation?.photos_urls?.[0] ??
    null;

  const step = reservation?.order_step ?? null;
  // Authoritative: Hygglo's `actions` map (awaiting_owner_action) — the literal
  // accept/deny trigger. Fall back to the active order step for rows not yet
  // re-polled with the actions signal.
  const isRequest = reservation?.awaiting_owner_action ?? step === "REQUEST";
  const lastRenterAt =
    conv?.last_renter_msg_at ??
    conv?.last_msg_at ??
    latestMsg?.hygglo_sent_at ??
    latestMsg?.fetched_at ??
    0;

  return {
    thread_id: threadId,
    account_slug: slug ?? null,
    renter_name:
      renter?.display_name ??
      reservation?.renter_name ??
      latestMsg?.sender_name ??
      "Renter",
    renter_rating: renter?.hygglo_rating ?? null,
    renter_review_count: renter?.hygglo_review_count ?? null,
    renter_blacklisted: renter?.blacklisted ?? false,
    renter_flagged: renter?.flag_on_request ?? false,
    has_reservation: !!reservation,
    start_date: reservation?.start_date ?? null,
    end_date: reservation?.end_date ?? null,
    return_date: reservation?.return_date ?? null,
    pickup_method: reservation?.pickup_method ?? null,
    status: reservation?.status ?? null,
    booking_status: reservation?.booking_status ?? null,
    order_step: step,
    is_request: isRequest,
    can_decide: isRequest,
    gross_paid_gbp: reservation?.gross_paid_gbp ?? null,
    net_to_owner_gbp: reservation?.net_to_owner_gbp ?? null,
    delivery_fee_gbp: reservation?.delivery_fee_gbp ?? null,
    currency: reservation?.currency ?? "GBP",
    items: richItems.slice(0, 6),
    item_count: richItems.length,
    image_url: primaryImage,
    last_renter_msg_at: lastRenterAt,
    last_msg_at: conv?.last_msg_at ?? lastRenterAt,
    preview: latestMsg?.body_text ?? "",
    has_draft: !!conv?.ai_draft_text,
    ai_draft_text: conv?.ai_draft_text ?? null,
  };
}

export const getReplyQueue = query({
  args: {
    accountSlug: v.optional(v.string()),
    limit: v.optional(v.number()),
    // Recency floor for the renter-last pass (REQUESTs ignore this — see below).
    withinDays: v.optional(v.number()),
    // When false (default) hide threads whose rental is already finished.
    includeFinished: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { accountSlug, limit = 60, withinDays = 5, includeFinished = false },
  ) => {
    const cutoff = Date.now() - withinDays * 86_400_000;
    const FINISHED_STATUS = new Set(["completed", "cancelled", "declined"]);
    const FINISHED_STEP = new Set([
      "RETURNED",
      "REVIEWED",
      "CANCELED",
      "VERIFICATION_FAILED",
    ]);
    const accountOk = (slug: string | null) =>
      !accountSlug || slug === accountSlug;

    const byThread = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof assembleTile>>>
    >();

    // Pass 1 — conversations awaiting my reply (renter spoke last), windowed.
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_last_sender", (q) => q.eq("last_sender", "renter"))
      .collect();
    for (const conv of convos) {
      const recencyTs = conv.last_renter_msg_at ?? conv.last_msg_at;
      if (recencyTs < cutoff) continue;
      const reservation = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) =>
          q.eq("hygglo_order_id", conv.thread_id),
        )
        .first();
      if (!includeFinished && reservation) {
        const st = reservation.status;
        const step = reservation.order_step;
        if ((st && FINISHED_STATUS.has(st)) || (step && FINISHED_STEP.has(step)))
          continue;
      }
      const tile = await assembleTile(ctx, conv, reservation, conv.thread_id);
      if (accountOk(tile.account_slug)) byThread.set(conv.thread_id, tile);
    }

    // Pass 2 — ALWAYS surface rental REQUESTs awaiting my approve/decline, even
    // if I spoke last or it's outside the recency window. This is what makes the
    // Approve / Decline buttons reliably reachable.
    const [byStep, byAction] = await Promise.all([
      ctx.db
        .query("reservations")
        .withIndex("by_order_step", (q) => q.eq("order_step", "REQUEST"))
        .collect(),
      ctx.db
        .query("reservations")
        .withIndex("by_awaiting_owner_action", (q) =>
          q.eq("awaiting_owner_action", true),
        )
        .collect(),
    ]);
    const seenReq = new Set<string>();
    const requests: typeof byStep = [];
    for (const r of [...byStep, ...byAction]) {
      const k = r._id as unknown as string;
      if (seenReq.has(k)) continue;
      seenReq.add(k);
      requests.push(r);
    }
    for (const r of requests) {
      const threadId = r.hygglo_order_id;
      if (!threadId || byThread.has(threadId)) continue;
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_thread", (q) => q.eq("thread_id", threadId))
        .first();
      const tile = await assembleTile(ctx, conv, r, threadId);
      if (accountOk(tile.account_slug)) byThread.set(threadId, tile);
    }

    // Requests first, then most-urgent (oldest unanswered) first.
    const tiles = [...byThread.values()].sort(
      (a, b) =>
        Number(b.is_request) - Number(a.is_request) ||
        (a.last_renter_msg_at ?? 0) - (b.last_renter_msg_at ?? 0),
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

    const richItems = buildRichItems(reservation);
    return {
      account_slug: slug ?? null,
      persona_prompt: persona_prompt ?? null,
      discount_codes: discount_codes ?? null,
      renter_name:
        renter?.display_name ?? reservation?.renter_name ?? "the renter",
      renter_rating: renter?.hygglo_rating ?? null,
      has_reservation: !!reservation,
      items: richItems.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)),
      start_date: reservation?.start_date ?? null,
      end_date: reservation?.end_date ?? null,
      return_date: reservation?.return_date ?? null,
      pickup_method: reservation?.pickup_method ?? null,
      status: reservation?.status ?? null,
      order_step: reservation?.order_step ?? null,
      is_request: reservation?.order_step === "REQUEST",
      gross_paid_gbp: reservation?.gross_paid_gbp ?? null,
      net_to_owner_gbp: reservation?.net_to_owner_gbp ?? null,
      delivery_fee_gbp: reservation?.delivery_fee_gbp ?? null,
      currency: reservation?.currency ?? "GBP",
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

// ── One-time backfill ─────────────────────────────────────────────

/**
 * Stamp last_sender / last_renter_msg_at / account_slug on conversations that
 * predate the Reply Inbox (they were never touched by the updated
 * upsertMessages). Without this the queue is empty on day one because no
 * existing thread has last_sender set. Idempotent + batched: skips already
 * stamped rows, processes up to `limit` per call. Run via
 * `npx convex run replyInbox:backfillLastSender '{}'` until remaining === 0.
 */
export const backfillLastSender = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 400 }) => {
    const convos = await ctx.db.query("conversations").collect();
    let processed = 0;
    let stamped = 0;
    let remaining = 0;
    for (const conv of convos) {
      if (conv.last_sender) continue; // already backfilled
      if (processed >= limit) {
        remaining++;
        continue;
      }
      processed++;
      const latest = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", conv.thread_id))
        .order("desc")
        .first();
      if (!latest) continue;
      const sender: "owner" | "renter" =
        latest.sender === "owner" ? "owner" : "renter";
      const ts = latest.hygglo_sent_at ?? latest.fetched_at;
      const patch: Record<string, unknown> = {
        last_sender: sender,
        last_msg_at: Math.max(conv.last_msg_at ?? 0, ts),
      };
      if (sender === "renter") patch.last_renter_msg_at = ts;
      if (!conv.account_slug && latest.account_slug)
        patch.account_slug = latest.account_slug;
      await ctx.db.patch(conv._id, patch);
      stamped++;
    }
    return { total: convos.length, processed, stamped, remaining };
  },
});
