import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v, type Infer } from "convex/values";
import { STEP_PRIORITY } from "./order_step_semantics";
import {
  queueNotificationEvents,
  type NotifEventInput,
  type NotifType,
} from "./notifications";

// ── order_step helpers ────────────────────────────────────────

/** All recognised Hygglo order step keys. */
const VALID_ORDER_STEPS = new Set([
  "REQUEST",
  "APPROVED",
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
  "CANCELED",
  "VERIFICATION_FAILED",
]);

/**
 * Steps where the renter has already paid. Re-exported from semantics module.
 * FUNDS_RESERVED is NOT here: order_step stores the ACTIVE (next-to-do) step,
 * so order_step=FUNDS_RESERVED means renter still needs to pay.
 * See: convex/order_step_semantics.ts for full table.
 */
export { PAID_ORDER_STEPS } from "./order_step_semantics";

/**
 * Extract the active order step from a raw Hygglo order object.
 * Looks at:
 *   - `order.steps[]`          — direct detail response from /v4/my/orders/:id
 *   - `order.detail.steps[]`   — v1 wrapper shape (detail nested under .detail)
 *   - `order._detail.steps[]`  — v1 wrapper shape (detail nested under ._detail)
 * Returns null when the step array is absent or no step is active.
 * Logs a warning and returns undefined for unrecognised step keys.
 * NOTE: "active" = the NEXT-TO-DO step (renter's current action). This is
 * intentional because downstream logic (deriveStatusFromStep, ongoing/upcoming
 * filters) all assume active-step semantics. For "have they reached step X?"
 * questions, look at step-priority predecessors of order_step.
 */
function extractActiveOrderStep(order: any): string | null | undefined {
  const steps = order?.steps ?? order?.detail?.steps ?? order?._detail?.steps;
  if (!Array.isArray(steps)) return null;
  const active = steps.find((s: any) => s?.active === true);
  if (!active) return null;
  const key: string = active?.key;
  if (!VALID_ORDER_STEPS.has(key)) {
    console.warn(`[hygglo] Unrecognised order_step key: "${key}" — storing undefined`);
    return undefined;
  }
  return key;
}



/**
 * Returns true when `incomingStep` is a regression vs. `storedStep`
 * and is NOT a terminal cancellation — meaning we should skip the update.
 */
function isStepRegression(stored: string | null | undefined, incoming: string | null | undefined): boolean {
  if (!stored || !incoming) return false;
  // CANCELED is always allowed through (terminal)
  if (incoming === "CANCELED") return false;
  const storedPriority = (STEP_PRIORITY as Record<string, number>)[stored] ?? -1;
  const incomingPriority = (STEP_PRIORITY as Record<string, number>)[incoming] ?? -1;
  return incomingPriority < storedPriority;
}

const messageArgs = v.array(
  v.object({
    thread_id: v.string(),
    message_id: v.string(),
    sender: v.string(),
    sender_name: v.optional(v.string()),
    body_text: v.string(),
    hygglo_sent_at: v.optional(v.number()),
    fetched_at: v.number(),
    raw: v.optional(v.string()),
  })
);

// ── Status derivation helper ──────────────────────────────────

/**
 * Derives canonical status from order_step (primary) or sourceFilter (fallback).
 * Fixes the v2 bug where Hygglo's filter=pending contains PAID orders with future
 * start dates — those must be "confirmed", not "pending_review".
 */
function deriveStatusFromStep(
  step: string | null | undefined,
  sourceFilter: string | null | undefined
): "confirmed" | "pending_review" | "completed" | "cancelled" {
  // Hygglo's API filter is THE ground-truth bucket — verified by direct
  // /v4/my/orders inspection. filter=pending always includes any unpaid step
  // (REQUEST, APPROVED, and FUNDS_RESERVED — Stripe pre-auth is NOT capture).
  // Mapping the step locally was wrong: it disagreed with Hygglo whenever a
  // FUNDS_RESERVED row was awaiting verification.
  if (sourceFilter === "obsolete") return "cancelled";
  if (sourceFilter === "pending") return "pending_review";
  if (sourceFilter === "current") {
    // Per order_step_semantics: RETURNED is the renter's NEXT-TO-DO step,
    // meaning gear is still with the renter and the rental is ongoing.
    // Only REVIEWED truly signals "rental wrapped up, awaiting review". The
    // previous mapping eagerly marked RETURNED as completed, which hid
    // in-window rentals from the active widget when their owner hadn't yet
    // ticked the return on Hygglo (2026-05-21 fix).
    return step === "REVIEWED" ? "completed" : "confirmed";
  }
  if (sourceFilter === "future") return "confirmed";
  // Unknown source — fall back to step-based heuristic.
  switch (step) {
    case "REQUEST":
    case "APPROVED":
    case "FUNDS_RESERVED":
      return "pending_review";
    case "VERIFIED":
    case "BOOKED_AFTER_VERIFIED":
    case "DELIVERED":
    case "RETURNED":
      return "confirmed";
    case "REVIEWED":
      return "completed";
    case "CANCELED":
    case "VERIFICATION_FAILED":
      return "cancelled";
    default:
      return "pending_review";
  }
}

// ── Mutations ─────────────────────────────────────────────────

/**
 * A renter message that's just a polite closer ("thanks", "ok", "no worries") —
 * no reply needed, so we skip pre-generating an AI draft for it. Conservative:
 * only matches obvious closers / very short fragments so real questions still
 * get a draft.
 */
function isCloserMessage(body?: string): boolean {
  const t = (body ?? "").trim().toLowerCase().replace(/[!.…\s]+$/g, "");
  if (t.length < 4) return true;
  return /^(thanks|thank you|thank u|thx|ty|cheers|no worries|no problem|np|ok|okay|kk|great|perfect|awesome|brilliant|lovely|got it|sounds good|will do|see you|see ya|noted|understood|👍|🙏|❤️|😊)\b/.test(
    t,
  );
}

/**
 * Public mutation called by Trigger.dev via ConvexHttpClient.
 * Deduplicates by (thread_id, message_id) — safe to call repeatedly.
 */
export const upsertMessages = mutation({
  args: {
    account_slug: v.string(),
    messages: messageArgs,
  },
  handler: async (ctx, { account_slug, messages }): Promise<{ inserted: number; skipped: number; scheduled_extractions: number }> => {
    let inserted = 0;
    let skipped = 0;
    const changedThreads = new Set<string>();
    // Reply Inbox: track the newest NEW message per thread so we can stamp the
    // conversation's last_sender / last_renter_msg_at after the insert loop.
    const latestByThread = new Map<
      string,
      { sender: string; ts: number; message_id: string; sender_name?: string; body_text?: string }
    >();
    for (const msg of messages) {
      const existing = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread_and_message", (q) =>
          q.eq("thread_id", msg.thread_id).eq("message_id", msg.message_id)
        )
        .first();
      if (existing) {
        skipped++;
        continue;
      }
      await ctx.db.insert("hygglo_messages", {
        account_slug,
        thread_id: msg.thread_id,
        message_id: msg.message_id,
        sender: msg.sender,
        sender_name: msg.sender_name,
        body_text: msg.body_text,
        hygglo_sent_at: msg.hygglo_sent_at,
        fetched_at: msg.fetched_at,
        raw: msg.raw,
      });
      inserted++;
      changedThreads.add(msg.thread_id);
      const ts = msg.hygglo_sent_at ?? msg.fetched_at;
      const prevLatest = latestByThread.get(msg.thread_id);
      if (!prevLatest || ts >= prevLatest.ts) {
        latestByThread.set(msg.thread_id, {
          sender: msg.sender,
          ts,
          message_id: msg.message_id,
          sender_name: msg.sender_name,
          body_text: msg.body_text,
        });
      }
    }

    // Schedule a booking-time extraction for each reservation whose thread
    // received new messages. The action runs in a separate Convex task —
    // doesn't block this mutation. Idempotent via transcript_hash inside
    // extract_booking_times.
    let scheduled = 0;
    for (const threadId of changedThreads) {
      const reservation = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", threadId))
        .first();
      if (!reservation) continue;
      if (reservation.is_obsolete) continue;
      if (!reservation.start_date || !reservation.end_date) continue;
      await ctx.scheduler.runAfter(0, api.extract_booking_times.extractForReservation, {
        reservation_id: reservation._id,
      });
      scheduled++;
    }

    // ── Reply Inbox: stamp conversation.last_sender / last_renter_msg_at ──
    // Makes the "needs my reply" queue a cheap by_last_sender index read and
    // implements the "tile disappears once I reply, reappears on their next
    // message" behaviour purely from data. Creates a minimal conversation row
    // for brand-new threads the conversations batch hasn't seen yet.
    let ownerReplyDetected = false;
    for (const [threadId, latest] of latestByThread) {
      const sender: "owner" | "renter" =
        latest.sender === "owner" ? "owner" : "renter";
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_thread", (q) => q.eq("thread_id", threadId))
        .first();
      if (conv) {
        const patch: Record<string, unknown> = {};
        if (!conv.last_msg_at || latest.ts >= conv.last_msg_at) {
          patch.last_msg_at = Math.max(conv.last_msg_at ?? 0, latest.ts);
          patch.last_sender = sender;
          if (sender === "owner") ownerReplyDetected = true;
        }
        if (sender === "renter") {
          patch.last_renter_msg_at = Math.max(
            conv.last_renter_msg_at ?? 0,
            latest.ts,
          );
          // A newer renter message invalidates any cached AI draft.
          if (conv.ai_draft_for_message_id !== latest.message_id) {
            patch.ai_draft_text = undefined;
            patch.ai_draft_for_message_id = undefined;
            patch.ai_draft_generated_at = undefined;
          }
        }
        if (!conv.account_slug) patch.account_slug = account_slug;
        if (Object.keys(patch).length > 0) await ctx.db.patch(conv._id, patch);
      } else {
        const account = await ctx.db
          .query("accounts")
          .withIndex("by_slug", (q) => q.eq("slug", account_slug))
          .first();
        let renter_id:
          | import("./_generated/dataModel").Id<"renters">
          | undefined;
        if (sender === "renter" && latest.sender_name) {
          const r = await ctx.db
            .query("renters")
            .withIndex("by_display_name", (q) =>
              q.eq("display_name", latest.sender_name!.trim()),
            )
            .first();
          renter_id = r?._id;
        }
        await ctx.db.insert("conversations", {
          thread_id: threadId,
          account_id: account?._id,
          account_slug,
          renter_id,
          last_msg_at: latest.ts,
          last_sender: sender,
          last_renter_msg_at: sender === "renter" ? latest.ts : undefined,
          created_at: latest.ts,
        });
      }
    }

    // App-reply reflected immediately: if the poller saw an OWNER message
    // (e.g. Daniel replied in the Hygglo app), refresh the reply-queue MV so
    // the tile drops NOW, not on the 5-min cron. (Daniel 2026-07-07)
    if (ownerReplyDetected) {
      await ctx.scheduler.runAfter(0, internal.mv.reply_queue.refresh, { force: true });
    }

    // ── Notify on a new RENTER message ────────────────────────────────────
    // The Quick Reply widget is for replying to renters, but pushes only fired
    // on new_request / booking_confirmed — a plain renter message or reply sent
    // nothing, so messages went unnoticed (2026-06-26). Fire a `renter_message`
    // push when a fresh message from a renter lands. Skipped when the order is a
    // pending request (new_request already covers it) so we never double-notify;
    // queueNotificationEvents dedupes per (thread, type) for 24h so a burst of
    // renter messages is at most one push per thread per day.
    const renterNotify: NotifEventInput[] = [];
    for (const [threadId, latest] of latestByThread) {
      if (latest.sender !== "renter") continue;
      const reservation = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", threadId))
        .first();

      // Pre-generate the AI draft the MOMENT a renter message lands, so it's
      // already waiting when I open the thread (no on-open spinner). This only
      // STORES a draft (setDraft) — it never sends anything. Skip obvious
      // closers ("thanks", "ok") so we don't burn a generation on a dead thread.
      if (!isCloserMessage(latest.body_text)) {
        try {
          await ctx.scheduler.runAfter(0, api.replyInbox_actions.generateDraft, {
            thread_id: threadId,
          });
        } catch (err) {
          console.warn("[hygglo.upsertMessages] draft pre-gen schedule failed", String(err));
        }
      }

      // NB: we used to `continue` here when the order was awaiting_owner_action,
      // assuming new_request covered it — but new_request fires only ONCE on the
      // awaiting transition, so follow-up messages on a pending request went
      // silent (the "didn't get notified for the 70-200 message" bug,
      // 2026-06-27). Now we always queue a renter_message; the per-(thread,type)
      // 24h dedup keeps it to at most one message push per thread per day.
      const label = notifyAccountLabel(account_slug);
      const renter =
        latest.sender_name?.trim() || reservation?.renter_name || "A renter";
      const preview = (latest.body_text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      renterNotify.push({
        type: "renter_message",
        thread_id: threadId,
        account_slug,
        title: `💬 ${renter} · ${label}`,
        body: preview || "sent a message",
        url: `/?thread=${encodeURIComponent(threadId)}&account=${encodeURIComponent(account_slug)}`,
      });
    }
    if (renterNotify.length > 0) {
      try {
        await queueNotificationEvents(ctx, renterNotify);
      } catch (err) {
        console.warn("[hygglo.upsertMessages] renter_message notify failed", String(err));
      }
    }

    return { inserted, skipped, scheduled_extractions: scheduled };
  },
});

// ── Queries ───────────────────────────────────────────────────

/**
 * Return the most recent N messages, optionally filtered by account.
 * Ordered by hygglo_sent_at desc (most recent first).
 */
export const getRecentMessages = query({
  args: {
    accountSlug: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, limit = 15 }) => {
    let rows;
    if (accountSlug) {
      rows = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
        .order("desc")
        .take(limit);
    } else {
      rows = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_fetched")
        .order("desc")
        .take(limit);
    }
    return rows.sort(
      (a, b) =>
        (b.hygglo_sent_at ?? b.fetched_at) - (a.hygglo_sent_at ?? a.fetched_at)
    );
  },
});

// ── Reservation upsert ────────────────────────────────────────

const orderItemArgs = v.object({
  item_name: v.string(),
  qty: v.optional(v.number()),
  /** Per-item image URLs from Hygglo detail.items[i].image.{*Url}.
   *  Wave-5: poller MUST forward this so we can write per-item image_hints. */
  image: v.optional(v.object({
    url: v.optional(v.string()),
    originalUrl: v.optional(v.string()),
    largeUrl: v.optional(v.string()),
    mediumUrl: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    // PASS-10: Hygglo's actual /v4/my/orders/{id}.items[].image schema.
    fullSizeUrl: v.optional(v.string()),
  })),
  /** PASS-9: extra raw Hygglo per-item fields forwarded for hygglo_items[]. */
  type: v.optional(v.string()),
  product_id: v.optional(v.number()),
  slug: v.optional(v.string()),
});

/** PASS-9: build authoritative per-rental items snapshot from incoming Hygglo items.
 *  This is the SOURCE OF TRUTH for dashboard tile imagery (never matches against
 *  the global items table for image purposes). Skips INSURANCE rows. */
function buildHyggloItems(
  items: Array<{
    item_name: string;
    qty?: number;
    image?: {
      url?: string;
      originalUrl?: string;
      largeUrl?: string;
      mediumUrl?: string;
      thumbnailUrl?: string;
      fullSizeUrl?: string;
    };
    type?: string;
    product_id?: number;
    slug?: string;
  }>,
): Array<{
  name: string;
  image_url: string | null;
  type: string;
  qty?: number;
  product_id?: number;
  slug?: string;
}> {
  return (items ?? [])
    .filter((i) => i?.type !== "INSURANCE")
    .map((i) => {
      const img = i.image ?? {};
      // PASS-10: Hygglo returns fullSizeUrl + thumbnailUrl on items[].image.
      // The other *Url keys are forwarded for forward-compat but in practice
      // are always undefined. Prefer fullSizeUrl > legacy keys > thumbnailUrl.
      const image_url =
        img.fullSizeUrl ??
        img.largeUrl ?? img.url ?? img.mediumUrl ?? img.originalUrl ??
        img.thumbnailUrl ?? null;
      return {
        name: String(i.item_name ?? ""),
        image_url: image_url as string | null,
        type: String(i.type ?? ""),
        qty: typeof i.qty === "number" ? i.qty : undefined,
        product_id: typeof i.product_id === "number" ? i.product_id : undefined,
        slug: i.slug ? String(i.slug) : undefined,
      };
    });
}

// ── Wave-5 image-hint helpers ──────────────────────────────────

/** Stable normalisation: lowercase, collapse whitespace, strip stock punctuation.
 *  Inlined here to avoid a cross-phase dep on convex/lib/imageResolution.ts
 *  (added in Phase 7). MUST stay in sync with the lib version. */
function normaliseItemNameLocal(s: string): string {
  return s.toLowerCase()
    .replace(/[\s\-_/]+/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, "")
    .trim();
}

type HyggloImageHint = {
  item_name: string;
  item_name_normalised: string;
  image_url: string;
  source: "hygglo_per_item" | "hygglo_order" | "manual_override";
  captured_at: number;
};

/**
 * Build per-item image hints from the incoming Hygglo items[].
 * Preference order per item: largeUrl > originalUrl > url > mediumUrl > thumbnailUrl.
 * If a per-item image is absent, falls back to the positional entry from the
 * order-level photos_urls and tags the hint as "hygglo_order" so the backfill
 * action can identify and re-process legacy rows.
 */
function buildImageHintsFromHyggloItems(
  items: Array<{
    item_name: string;
    image?: {
      url?: string;
      originalUrl?: string;
      largeUrl?: string;
      mediumUrl?: string;
      thumbnailUrl?: string;
      fullSizeUrl?: string;
    };
  }>,
  fallbackOrderPhotos: string[] | undefined,
  now: number,
): HyggloImageHint[] {
  const hints: HyggloImageHint[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.item_name) continue;
    const img = it.image ?? {};
    // PASS-10: fullSizeUrl is what Hygglo actually returns; legacy *Url keys
    // remain in the preference chain for forward-compat.
    const perItem =
      img.fullSizeUrl ?? img.largeUrl ?? img.originalUrl ?? img.url ??
      img.mediumUrl ?? img.thumbnailUrl ?? null;
    if (perItem) {
      hints.push({
        item_name: it.item_name,
        item_name_normalised: normaliseItemNameLocal(it.item_name),
        image_url: perItem,
        source: "hygglo_per_item",
        captured_at: now,
      });
      continue;
    }
    // Legacy fallback — order-level photo. Positional first, then any /products/ URL.
    const positional = fallbackOrderPhotos?.[i];
    const productLike = (fallbackOrderPhotos ?? []).find((u) => u.includes("/products/"));
    const fallback = positional ?? productLike ?? fallbackOrderPhotos?.[0];
    if (!fallback) continue;
    hints.push({
      item_name: it.item_name,
      item_name_normalised: normaliseItemNameLocal(it.item_name),
      image_url: fallback,
      source: "hygglo_order",
      captured_at: now,
    });
  }
  return hints;
}

// ── EQ-C: synchronous listing_resolver dispatch on owner denial ─────────
//
// When a Hygglo reservation transitions into the obsolete bucket
// (owner_denied / renter_cancelled / verification_failed), the gap-detector
// needs resolved_items[] on the listing_resolution row keyed by
// (account_slug, hygglo_order_id) to classify the loss. Phase 18.2 only
// fires the resolver for rows newly inserted in active filters, so a row
// that's denied between poll cycles (or first appears already obsolete)
// can sit with resolved_items=[] until the next listing_resolver pass.
//
// resolveListing's Tier 1 catalog short-circuit returns instantly when
// (account_slug, hygglo_order_id) already has a resolved row, so calling
// it on every denial is cheap. We deliberately fire-and-forget via the
// scheduler — mutations cannot call actions directly, and the resolver
// action handles its own idempotency.
async function scheduleListingResolutionOnDenial(
  ctx: MutationCtx,
  args: {
    account_slug: string;
    hygglo_order_id: string;
    items: Array<{ item_name: string }>;
    order: unknown;
    notes: string | undefined;
    photos_urls: string[] | undefined;
  },
): Promise<void> {
  const firstItem = (args.items ?? []).find((i) => i?.item_name)?.item_name
    ?? args.hygglo_order_id;
  const firstImg = (args.photos_urls ?? [])[0];
  try {
    await ctx.scheduler.runAfter(
      0,
      internal.listing_resolver.resolveListing,
      {
        hygglo_listing_id: args.hygglo_order_id,
        hygglo_account: args.account_slug,
        hygglo_title: firstItem,
        hygglo_description: args.notes,
        hygglo_detail_payload: args.order,
        image_url: firstImg,
      },
    );
  } catch (err) {
    console.warn(
      "[hygglo.upsertOrderImpl] scheduleListingResolutionOnDenial failed",
      String(err),
    );
  }
}

// 2026-05-24: listing_info_pool derivation now lives on Trigger.dev
// (src/trigger/derive-listing-info-pool.ts). The Hygglo poll task in
// src/trigger/poll-hygglo.ts fires `tasks.trigger("derive-listing-info-pool-
// on-demand", { targets })` after a fresh insert batch for low-latency
// fills; the half-hourly cron task is the backstop for anything missed +
// for forceReDerive (UI) rows. This mutation no longer schedules derivation
// itself — Convex actions are not allowed for LLM work (CLAUDE.md).

// Fire-and-forget short_name derivation for each Hygglo per-item product.
// Pass 14a (2026-05-26): collapsed from N scheduler.runAfter calls (one per
// item, each spawning a "use node" deriveOne action) to ONE scheduled V8
// mutation that processes the whole batch. Was ~750 actions per poll ×
// 288 polls/day = 216K function calls/day even though >99% were cache-hit
// no-ops. New path: 1 mutation per poll cycle = 288 calls/day.
async function scheduleShortNameDerivation(
  ctx: MutationCtx,
  account_slug: string,
  hyggloItems: Array<{ name: string; product_id?: number; type: string }>,
): Promise<void> {
  const seen = new Set<number>();
  const items: Array<{ account_slug: string; product_id: number; raw_title: string }> = [];
  for (const it of hyggloItems) {
    if (!it || it.type === "INSURANCE") continue;
    if (typeof it.product_id !== "number") continue;
    if (!it.name) continue;
    if (seen.has(it.product_id)) continue;
    seen.add(it.product_id);
    items.push({ account_slug, product_id: it.product_id, raw_title: it.name });
  }
  if (items.length === 0) return;
  try {
    await ctx.scheduler.runAfter(
      0,
      internal.listing_short_names.upsertShortNamesBatch,
      { items },
    );
  } catch (err) {
    console.warn("[hygglo.upsertOrderImpl] scheduleShortNameDerivation failed", String(err));
  }
}

// Shared arg shape for both the singleton and batch reservation upsert mutations.
const upsertOrderArgsFields = {
  account_slug: v.string(),
  hygglo_order_id: v.string(),
  status: v.string(),
  start_date: v.string(),
  end_date: v.string(),
  gross_paid_gbp: v.optional(v.number()),
  net_to_owner_gbp: v.optional(v.number()),
  currency: v.optional(v.string()),
  items: v.array(orderItemArgs),
  duration_days: v.optional(v.number()),
  /** Raw Hygglo order object. Pass 13b (2026-05-26): now OPTIONAL on the
   *  hot path — caller pre-extracts `order_step` and only sends `order`
   *  when the row needs listing-resolver context (denial transitions). The
   *  ~30KB Hygglo blob × ~250 rentals × 288 polls/day was the dominant
   *  upload-bandwidth cost on this mutation (~253 MB/day). */
  order: v.optional(v.any()),
  /** Pass 13b (2026-05-26): pre-extracted active order step. When set the
   *  server uses it verbatim; when absent the server falls back to
   *  extractActiveOrderStep(args.order). Eliminates the need to send the
   *  full `order` blob on the common (non-denial) update path. */
  order_step_extracted: v.optional(v.union(
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
  )),
  /** Filter label from the poll cycle (e.g. "obsolete", "active"). */
  sourceFilter: v.optional(v.string()),
  renter_name: v.optional(v.string()),
  /** 2026-05-19 — Hygglo renter user id (detail.users.otherPart.id). Stored
   *  on the row + used to resolve `renter_id` via renters by_hygglo_user_id. */
  hygglo_user_id: v.optional(v.string()),
  /** Raw Hygglo booking status (e.g. "pending_review", "confirmed"). */
  booking_status: v.optional(v.string()),
  /** Pickup/return time strings ("HH:MM") from booking detail. */
  pickup_time: v.optional(v.string()),
  return_time: v.optional(v.string()),
  /** Pickup/return method ("delivery" | "self_pickup" | etc). */
  pickup_method: v.optional(v.string()),
  return_method: v.optional(v.string()),
  /** Owner notes on the order. */
  notes: v.optional(v.string()),
  /** Raw CDN photo URLs from the order detail. */
  photos_urls: v.optional(v.array(v.string())),
  /** Phase 18.2 — monotonic activity timestamp from Hygglo list response.
   *  Stored verbatim so the next poll cycle can compare and skip the
   *  detail fetch when unchanged. */
  latest_activity: v.optional(v.union(v.number(), v.string())),
  /** Phase 3d — Hygglo system event signal derived from activity.event.content. */
  hygglo_system_signal: v.optional(v.union(
    v.literal("owner_denied"),
    v.literal("renter_cancelled"),
    v.literal("auto_cancelled"),
    v.literal("verification_failed"),
    v.literal("approved"),
    v.literal("none"),
  )),
  hygglo_system_signal_text: v.optional(v.string()),
  /** Reply Inbox: Hygglo `actions` map offers accept/deny (awaiting my approval). */
  awaiting_owner_action: v.optional(v.boolean()),
  /** Granular owner actions (2026-06-26) — accept available vs only deny. */
  can_accept: v.optional(v.boolean()),
  can_deny: v.optional(v.boolean()),
} as const;

const upsertOrderArgsValidator = v.object(upsertOrderArgsFields);
type UpsertOrderArgs = Infer<typeof upsertOrderArgsValidator>;

type BankItem = {
  name: string;
  image_url: string | null;
  type: string;
  qty?: number;
  product_id?: number;
  slug?: string;
};

type UpsertResult = {
  action: "inserted" | "updated" | "skipped";
  reservation_id?: string;
};

// Internal impl result shape — adds the obsolete-transition flag + bank items
// that the batch handler uses but never exposes to callers.
type UpsertImplResult = UpsertResult & {
  bankItems: BankItem[];
  transitionedToObsolete?: boolean;
  // Push-worthy transitions detected this upsert (confirmed booking / new
  // request). Collected by the batch handler → queueNotificationEvents.
  notify?: NotifEventInput[];
  // True when this order crossed the picked-up threshold (DELIVERED/RETURNED/
  // REVIEWED) — i.e. REALISED revenue changed. Drives a reactive refresh of the
  // lifetime-revenue + investment MVs (otherwise daily-only → up to 24h stale).
  revenueRealized?: boolean;
};

/** Short "2× Lens, Tripod +1" style item summary for a notification body. */
function summarizeNotifyItems(items: UpsertOrderArgs["items"]): string {
  const names = (items ?? []).map((i) =>
    i.qty && i.qty > 1 ? `${i.qty}× ${i.item_name}` : i.item_name,
  );
  if (names.length === 0) return "rental";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

const NOTIFY_ACCOUNT_LABELS: Record<string, string> = {
  dbcinema: "DB Cinema",
  leo: "Leo",
  diogo: "Diogo",
};
function notifyAccountLabel(slug?: string): string {
  return slug ? (NOTIFY_ACCOUNT_LABELS[slug] ?? slug) : "Unknown";
}

const NOTIFY_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
/** "24–26 Jun" / "30 Jun – 2 Jul" / "24 Jun" — compact, no Date/Intl. */
function compactDateRange(start?: string, end?: string): string {
  const parse = (iso?: string) => {
    if (!iso) return null;
    const [, m, d] = iso.split("-").map((n) => Number(n));
    if (!m || !d) return null;
    return { d, mon: NOTIFY_MONTHS[m - 1] ?? "" };
  };
  const s = parse(start);
  if (!s) return "";
  const e = parse(end);
  if (!e) return `${s.d} ${s.mon}`;
  if (s.mon === e.mon) return `${s.d}–${e.d} ${s.mon}`;
  return `${s.d} ${s.mon} – ${e.d} ${e.mon}`;
}

/**
 * Build a notification event from an order's args. Account is in the TITLE
 * (which account it's for, at a glance) and the body is a compact, useful
 * single line: renter · items · dates · £value · pickup.
 */
function buildNotifyEvent(
  args: UpsertOrderArgs,
  type: NotifType,
): NotifEventInput {
  const renter = args.renter_name?.trim() || "A renter";
  const items = summarizeNotifyItems(args.items);
  const dates = compactDateRange(args.start_date, args.end_date);
  const priceN = args.gross_paid_gbp ?? args.net_to_owner_gbp;
  const price =
    typeof priceN === "number" && priceN > 0 ? `£${Math.round(priceN)}` : "";
  const pickup =
    args.pickup_method && args.pickup_method !== "unknown"
      ? args.pickup_method.charAt(0).toUpperCase() + args.pickup_method.slice(1)
      : "";
  const acct = args.account_slug;
  const url = `/?thread=${encodeURIComponent(args.hygglo_order_id)}${
    acct ? `&account=${encodeURIComponent(acct)}` : ""
  }`;
  const label = notifyAccountLabel(acct);
  const title =
    type === "booking_confirmed"
      ? `🎉 Booking confirmed · ${label}`
      : `🔔 New request · ${label}`;
  const body = [renter, items, dates, price, pickup].filter(Boolean).join(" · ");
  return { type, thread_id: args.hygglo_order_id, account_slug: acct, title, body, url };
}

/**
 * Core per-order upsert. Returns the per-order result PLUS the hygglo_items
 * snapshot that should be flushed into the product_id-keyed image bank.
 * Callers are responsible for invoking internal.listing_images.upsertFromHyggloItems
 * with the returned bankItems — the batch mutation aggregates them across
 * orders so the bank flush is a single sub-mutation per cron run.
 */
async function upsertOrderImpl(
  ctx: MutationCtx,
  args: UpsertOrderArgs,
): Promise<UpsertImplResult> {
  const existing = await ctx.db
    .query("reservations")
    .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", args.hygglo_order_id))
    .first();

  const now = Date.now();

  const order = args.order;
  const pickup_time = args.pickup_time ?? order?.booking?.pickup_time ?? undefined;
  const return_time = args.return_time ?? order?.booking?.return_time ?? undefined;
  const pickup_method = args.pickup_method ?? order?.booking?.pickup_method ?? undefined;
  const return_method = args.return_method ?? order?.booking?.return_method ?? undefined;
  const notes = args.notes ?? order?.notes ?? order?.detail?.notes ?? undefined;
  const photos_urls_raw: string[] | undefined =
    args.photos_urls ?? order?.photos_urls ?? order?.detail?.photos_urls;
  const photos_urls = Array.isArray(photos_urls_raw)
    ? photos_urls_raw.filter((u): u is string => typeof u === "string")
    : undefined;

  // Pass 13b (2026-05-26): prefer pre-extracted step from caller; only fall
  // back to extracting from args.order when caller didn't send it (legacy
  // path / one-off invocations).
  // null = no active step found (treat as undefined); undefined = unrecognised key
  const incomingStep: "REQUEST" | "APPROVED" | "FUNDS_RESERVED" | "VERIFIED" | "BOOKED_AFTER_VERIFIED"
    | "DELIVERED" | "RETURNED" | "REVIEWED" | "CANCELED" | "VERIFICATION_FAILED" | undefined =
    args.order_step_extracted ?? (() => {
      const raw = extractActiveOrderStep(args.order);
      return raw === null ? undefined : (raw as
        | "REQUEST" | "APPROVED" | "FUNDS_RESERVED" | "VERIFIED" | "BOOKED_AFTER_VERIFIED"
        | "DELIVERED" | "RETURNED" | "REVIEWED" | "CANCELED" | "VERIFICATION_FAILED"
        | undefined);
    })();

  let obsoleteFields: {
    is_obsolete?: boolean;
    obsolete_reason?: "owner_denied" | "renter_cancelled" | "verification_failed" | "other";
  } = {};
  if (args.sourceFilter === "obsolete") {
    let reason: "owner_denied" | "renter_cancelled" | "verification_failed" | "other";
    if (incomingStep === "REQUEST") {
      reason = "owner_denied";
    } else if (incomingStep === "CANCELED") {
      reason = "renter_cancelled";
    } else if (
      incomingStep === "VERIFIED" ||
      incomingStep === "FUNDS_RESERVED"
    ) {
      reason = "verification_failed";
    } else {
      reason = "other";
    }
    obsoleteFields = { is_obsolete: true, obsolete_reason: reason };
  }

  const incomingStatus = deriveStatusFromStep(incomingStep, args.sourceFilter);

  // ── renter linkage (2026-05-19) ────────────────────────────
  // Resolve renter_id via hygglo_user_id (indexed). Falls back to undefined
  // when the renter row hasn't been inserted yet — renters are upserted in
  // the same poll cycle, so the link lands on the next poll. The denormalized
  // hygglo_user_id is still stored so backfill can re-link without refetching.
  let resolved_renter_id: import("./_generated/dataModel").Id<"renters"> | undefined;
  if (args.hygglo_user_id && args.hygglo_user_id.length > 0) {
    const renter = await ctx.db
      .query("renters")
      .withIndex("by_hygglo_user_id", (q) =>
        q.eq("hygglo_user_id", args.hygglo_user_id),
      )
      .first();
    resolved_renter_id = renter?._id;
  }

  const baseFields = {
    account_slug: args.account_slug,
    hygglo_order_id: args.hygglo_order_id,
    status: incomingStatus,
    source_filter: args.sourceFilter,
    last_polled_at: now,
    start_date: args.start_date,
    end_date: args.end_date,
    gross_paid_gbp: args.gross_paid_gbp,
    net_to_owner_gbp: args.net_to_owner_gbp,
    currency: args.currency,
    // Project to the minimal shape `reservations.items[]` is meant to store.
    // Rich Hygglo metadata (image, type, product_id, slug) lives in
    // `hygglo_items[]` instead — keeping that separation means a new Hygglo
    // API field cannot trigger a document-validator failure on this table.
    // (Incident 2026-05-16 → 2026-05-21: `image` started arriving from
    // Hygglo, the validator rejected it, and the poller auto-paused for six
    // days because of that single new field.)
    items: args.items.map((i) => ({
      item_name: i.item_name,
      ...(i.qty !== undefined && { qty: i.qty }),
    })),
    duration_days: args.duration_days,
    renter_name: args.renter_name,
    ...(args.hygglo_user_id !== undefined && { hygglo_user_id: args.hygglo_user_id }),
    ...(resolved_renter_id !== undefined && { renter_id: resolved_renter_id }),
    booking_status: args.booking_status,
    ...(pickup_time !== undefined && { pickup_time }),
    ...(return_time !== undefined && { return_time }),
    ...(pickup_method !== undefined && { pickup_method }),
    ...(return_method !== undefined && { return_method }),
    ...(notes !== undefined && { notes }),
    ...(photos_urls !== undefined && { photos_urls }),
    ...(args.latest_activity !== undefined && { latest_activity: args.latest_activity }),
    // Phase 3d: always write when present (even "none") so the denial
    // classifier can rely on field existence to know we've checked events.
    ...(args.hygglo_system_signal !== undefined && { hygglo_system_signal: args.hygglo_system_signal }),
    ...(args.hygglo_system_signal_text !== undefined && { hygglo_system_signal_text: args.hygglo_system_signal_text }),
    // Reply Inbox: drives the Approve/Decline buttons (insert + every baseFields patch).
    ...(args.awaiting_owner_action !== undefined && { awaiting_owner_action: args.awaiting_owner_action }),
    // Granular state — accept gone + deny left = already approved (show only Decline).
    ...(args.can_accept !== undefined && { can_accept: args.can_accept }),
    ...(args.can_deny !== undefined && { can_deny: args.can_deny }),
  };

  if (existing) {
    // Historical v1_rental_id rows used to be unconditionally skipped, which
    // locked in undercounted nets from `rental`-sourced imports. We now allow
    // ONLY the net/gross fields to be corrected when the live poller sees a
    // materially higher value (≥ £10 OR ≥ 10% increase).
    if (existing.v1_rental_id) {
      const storedNet = existing.net_to_owner_gbp ?? 0;
      const incomingNet = args.net_to_owner_gbp ?? 0;
      const diff = incomingNet - storedNet;
      const isMaterialIncrease =
        diff >= 10 || (storedNet > 0 && diff / storedNet >= 0.1);
      if (!isMaterialIncrease) return { action: "skipped", bankItems: [] };
      await ctx.db.patch(existing._id, {
        net_to_owner_gbp: incomingNet,
        ...(args.gross_paid_gbp !== undefined && {
          gross_paid_gbp: args.gross_paid_gbp,
        }),
      });
      console.info(
        `[hygglo] v1_rental_id ${existing.v1_rental_id}: net corrected £${storedNet.toFixed(2)} → £${incomingNet.toFixed(2)}`,
      );
      return { action: "updated", bankItems: [] };
    }

    const storedStep = (existing as { order_step?: string }).order_step ?? null;
    const isObsoleteUpsert = args.sourceFilter === "obsolete";

    // Completion-durability guard (2026-06-15). Never let a re-poll of a still-
    // active Hygglo order revert an operator's LOCAL completion back to
    // "confirmed". markReturned (Return Hub ✓) sets status="completed" locally;
    // while READ_ONLY_MODE keeps the Hygglo platform un-updated, Hygglo keeps
    // listing the order at step RETURNED, so deriveStatusFromStep re-derives
    // "confirmed" and the unconditional patch below would clobber the close —
    // the rental then reappears in the Return Hub and drops out of
    // pendingPlatformClose (James Burton, dbcinema, 2026-06-15). Preserve
    // "completed" whenever the fresh derivation is the active "confirmed" state.
    // Terminal transitions still apply normally: a genuine cancel arrives via the
    // obsolete bucket ("cancelled"), and a real Hygglo-side close arrives as
    // REVIEWED ("completed") — neither is "confirmed", so neither is blocked.
    const preserveLocalCompletion =
      existing.status === "completed" && incomingStatus === "confirmed";

    if (
      !isObsoleteUpsert &&
      incomingStep !== undefined &&
      isStepRegression(storedStep, incomingStep)
    ) {
      // Stale filter response — preserve order_step but apply non-step fields.
      console.info(
        `[hygglo] Step regression skipped for order ${args.hygglo_order_id}: ` +
          `stored="${storedStep}" incoming="${incomingStep}"`
      );
      await ctx.db.patch(existing._id, { ...baseFields, ...(preserveLocalCompletion ? { status: "completed" as const } : {}), ...obsoleteFields });
      const hintsRegression = buildImageHintsFromHyggloItems(args.items, photos_urls, now);
      const hyggloItemsRegression = buildHyggloItems(args.items);
      await ctx.db.patch(existing._id, { image_hints: hintsRegression, hygglo_items: hyggloItemsRegression });
      await scheduleShortNameDerivation(ctx, args.account_slug, hyggloItemsRegression);
      // listing_info_pool: one-time fill at insert only — no re-derive on update.
      return { action: "updated", bankItems: hyggloItemsRegression };
    }

    // sourceFilter is authoritative — the poller fetches all four buckets each
    // cycle, so the row is in exactly one. Trust the freshly-derived status,
    // EXCEPT never revert an operator's local completion (see guard above).
    const finalStatus = preserveLocalCompletion ? "completed" : incomingStatus;
    const stepPatch =
      incomingStep !== undefined ? { order_step: incomingStep } : {};
    // EQ-C: capture pre-patch obsolete state so a transition into the
    // obsolete bucket fires listing_resolver synchronously rather than
    // waiting up to 60 min for the next poll cycle (Anker power-station
    // incident, 2026-05-22).
    const wasObsolete = existing.is_obsolete === true;
    // Pass 15b (2026-05-26): un-obsolete path. Original logic only ever SET
    // is_obsolete=true (when sourceFilter==="obsolete") and never cleared
    // it. Result: rows that briefly appeared in Hygglo's obsolete bucket
    // (transient classification error / Hygglo system bug) got stuck with
    // is_obsolete=true forever, hidden from the dashboard, even when the
    // next poll cycle re-classified them to current/confirmed. Symptom:
    // "Matthew Holden" leo rental — status=confirmed, order_step=DELIVERED,
    // is_obsolete=true (wrong). Clear the flag when the row appears in a
    // non-obsolete bucket. obsolete_reason is preserved for audit; only
    // the boolean gate flips back.
    const clearObsolete = !isObsoleteUpsert && wasObsolete;
    await ctx.db.patch(existing._id, {
      ...baseFields,
      status: finalStatus,
      ...stepPatch,
      ...obsoleteFields,
      ...(clearObsolete && { is_obsolete: false }),
    });
    const hintsUpdate = buildImageHintsFromHyggloItems(args.items, photos_urls, now);
    const hyggloItemsUpdate = buildHyggloItems(args.items);
    await ctx.db.patch(existing._id, { image_hints: hintsUpdate, hygglo_items: hyggloItemsUpdate });
    await scheduleShortNameDerivation(ctx, args.account_slug, hyggloItemsUpdate);
    // listing_info_pool: one-time fill at insert only — no re-derive on update.
    // Transition signal feeds the batch handler's reactive MV refresh. Both
    // directions matter: a row newly-obsoleted needs to drop out of cached
    // active/upcoming lists; a row un-obsoleted (Matthew Holden case) needs
    // to re-appear in them. One scheduler call per batch covers both.
    //
    // Pass 16a (2026-05-26): also fire when order_step crosses the
    // "picked up" threshold. The Earnings Today widget is gated by
    // PICKED_UP_STEPS (BOOKED_AFTER_VERIFIED / DELIVERED / RETURNED /
    // REVIEWED) — when a row crosses INTO that set the number should
    // jump up; when it crosses OUT (rare — only via the un-obsolete path
    // re-syncing an older row) it should drop. Without this signal a
    // pickup at 09:00 wouldn't appear in the widget until the hourly
    // cron caught up.
    const PICKED_UP_STEPS_HOT = new Set([
      "BOOKED_AFTER_VERIFIED",
      "DELIVERED",
      "RETURNED",
      "REVIEWED",
    ]);
    const wasPickedUp =
      typeof storedStep === "string" && PICKED_UP_STEPS_HOT.has(storedStep);
    const nowPickedUp =
      typeof incomingStep === "string" && PICKED_UP_STEPS_HOT.has(incomingStep);
    const transitionedToObsolete = obsoleteFields.is_obsolete === true && !wasObsolete;
    const transitionedFromObsolete = clearObsolete;
    const pickupStateChanged = wasPickedUp !== nowPickedUp;
    if (transitionedToObsolete) {
      await scheduleListingResolutionOnDenial(ctx, {
        account_slug: args.account_slug,
        hygglo_order_id: args.hygglo_order_id,
        items: args.items,
        order: args.order,
        notes,
        photos_urls,
      });
    }
    // Push notifications (2026-06-23): fire on genuine TRANSITIONS only so a
    // re-poll of an unchanged order never re-notifies.
    //  • booking_confirmed ("wohoo") — status crossed INTO "confirmed".
    //  • new_request — Hygglo's actions map newly offers accept/deny.
    const notifyUpdate: NotifEventInput[] = [];
    if (existing.status !== "confirmed" && finalStatus === "confirmed") {
      notifyUpdate.push(buildNotifyEvent(args, "booking_confirmed"));
    }
    if (
      args.awaiting_owner_action === true &&
      existing.awaiting_owner_action !== true
    ) {
      notifyUpdate.push(buildNotifyEvent(args, "new_request"));
    }
    return {
      action: "updated",
      bankItems: hyggloItemsUpdate,
      // The field is conceptually "any dashboard-visible state change";
      // kept under its original name to avoid renaming the API. Covers
      // obsolete transitions (both directions) and pickup-step crossings.
      transitionedToObsolete: transitionedToObsolete || transitionedFromObsolete || pickupStateChanged,
      ...(notifyUpdate.length > 0 && { notify: notifyUpdate }),
      // Realised revenue changed iff the picked-up state flipped (either way).
      ...(pickupStateChanged && { revenueRealized: true }),
    };
  }

  // ── INSERT ────────────────────────────────────────────────
  const stepInsert =
    incomingStep !== undefined ? { order_step: incomingStep } : {};
  const hintsInsert = buildImageHintsFromHyggloItems(args.items, photos_urls, now);
  const hyggloItemsInsert = buildHyggloItems(args.items);
  const newId = await ctx.db.insert("reservations", {
    ...baseFields,
    ...stepInsert,
    ...obsoleteFields,
    ...(hintsInsert.length > 0 && { image_hints: hintsInsert }),
    ...(hyggloItemsInsert.length > 0 && { hygglo_items: hyggloItemsInsert }),
    created_at: now,
  });
  await scheduleShortNameDerivation(ctx, args.account_slug, hyggloItemsInsert);
  // listing_info_pool derivation: handled by Trigger.dev. poll-hygglo fires
  // `tasks.trigger("derive-listing-info-pool-on-demand", { targets })` after
  // the upsert batch completes — see src/trigger/poll-hygglo.ts. The
  // half-hourly cron in src/trigger/derive-listing-info-pool.ts is the
  // backstop for any rows missed by the on-demand path.

  // EQ-C: when an order first appears already in the obsolete bucket (renter
  // never made it past REQUEST → owner denied before we ever saw it in
  // pending/current), poll-hygglo's `newlyInserted` collector does NOT pick
  // it up for resolution. Fire the resolver here so the gap detector has
  // resolved_items to work with on the next sweep.
  if (obsoleteFields.is_obsolete === true) {
    await scheduleListingResolutionOnDenial(ctx, {
      account_slug: args.account_slug,
      hygglo_order_id: args.hygglo_order_id,
      items: args.items,
      order: args.order,
      notes,
      photos_urls,
    });
  }

  // Pass 16a (2026-05-26): newly-inserted rows that come in already-picked-up
  // (Hygglo's first poll picked up the order after it had already been
  // delivered) also count as a state change for MV-refresh purposes —
  // their gross will land in the Earnings Today widget.
  const NEWLY_PICKED_UP_STEPS = new Set([
    "BOOKED_AFTER_VERIFIED",
    "DELIVERED",
    "RETURNED",
    "REVIEWED",
  ]);
  const insertedAsPickedUp =
    typeof incomingStep === "string" && NEWLY_PICKED_UP_STEPS.has(incomingStep);
  // Push: a brand-new row already awaiting accept/deny is a new request.
  // We deliberately do NOT fire booking_confirmed on first insert — that would
  // spam every historical confirmed rental when a NEW account is first synced.
  // Real bookings are caught by the request→confirmed transition on the update
  // path above.
  const notifyInsert: NotifEventInput[] = [];
  if (args.awaiting_owner_action === true) {
    notifyInsert.push(buildNotifyEvent(args, "new_request"));
  } else if (
    incomingStatus === "confirmed" &&
    typeof args.start_date === "string" &&
    args.start_date >= new Date().toISOString().slice(0, 10)
  ) {
    // "wohoo" for a booking first SEEN already-confirmed (a fast request->confirm
    // that happened between polls). Guarded to current/upcoming rentals so a
    // first-time account sync of historical confirmed bookings can't flood.
    notifyInsert.push(buildNotifyEvent(args, "booking_confirmed"));
  }
  return {
    action: "inserted",
    reservation_id: newId as unknown as string,
    bankItems: hyggloItemsInsert,
    ...(notifyInsert.length > 0 && { notify: notifyInsert }),
    // Pass 15a (2026-05-26): newly-inserted rows that come in already-obsolete
    // (renter cancelled before we ever saw it active) count as a transition
    // for MV-refresh purposes. The mv_stats_drawer cached "active" list won't
    // know to exclude them otherwise.
    transitionedToObsolete:
      obsoleteFields.is_obsolete === true || insertedAsPickedUp,
    // A row inserted already picked-up adds realised revenue.
    ...(insertedAsPickedUp && { revenueRealized: true }),
  };
}

// upsertOrderAsReservation deleted 2026-05-25 (pass 9b). Was costing 386K
// call invocations on the Dev deployment (likely a stale test loop or
// orphaned backfill script — zero live callers in the codebase after
// pass 4 migrated the poller to upsertOrdersAsReservationsBatch). One-off
// callers can wrap a single order: `upsertOrdersAsReservationsBatch({orders:[x]})`.
//
// Restore from git history if needed.

/**
 * Batch upsert used by the poll-hygglo cron. Processes every order in a single
 * Convex mutation invocation, then flushes one internal listing_images upsert
 * containing the deduped union of bank items across the batch.
 *
 * Cost shape: ONE mutation call per cron run regardless of order count, vs.
 * the legacy per-order path which incurred one top-level mutation + one
 * internal sub-mutation per order. This enforces CLAUDE.md's "one mutation
 * per cron run, not per row" rule on the poller's hot path.
 *
 * Results are returned aligned with the input array (same length, same order).
 */
export const upsertOrdersAsReservationsBatch = mutation({
  args: { orders: v.array(upsertOrderArgsValidator) },
  handler: async (ctx, { orders }): Promise<UpsertResult[]> => {
    const results: UpsertResult[] = [];
    // account_slug -> aggregated bank items (one flush per account at the end).
    const perAccountBank = new Map<string, BankItem[]>();
    // Pass 15a (2026-05-26): track obsolete transitions so we can fire a
    // SINGLE reactive MV refresh at the end of the batch — converging the
    // dashboard's mv_stats_drawer (active/ongoing/upcoming/confirmed lists)
    // within seconds of a cancellation instead of waiting up to ~60 min for
    // the next refreshFast cron. One refresh per batch covers N transitions.
    let anyTransitionedToObsolete = false;
    // Realised-revenue change in this batch → reactively refresh the lifetime
    // revenue + investment MVs (otherwise daily-only, so a fresh pickup — e.g.
    // diogo's first delivered rental — wouldn't show on the chart for up to 24h).
    let anyRevenueRealized = false;
    // Push-worthy transitions (confirmed bookings / new requests) detected
    // across the batch — queued once at the end so a busy poll fans out a
    // single dispatch rather than one per order.
    const allNotify: NotifEventInput[] = [];

    for (const args of orders) {
      const { action, reservation_id, bankItems, transitionedToObsolete, notify, revenueRealized } =
        await upsertOrderImpl(ctx, args);
      results.push(reservation_id !== undefined ? { action, reservation_id } : { action });
      if (bankItems.length > 0) {
        const bucket = perAccountBank.get(args.account_slug);
        if (bucket) bucket.push(...bankItems);
        else perAccountBank.set(args.account_slug, [...bankItems]);
      }
      if (transitionedToObsolete) anyTransitionedToObsolete = true;
      if (revenueRealized) anyRevenueRealized = true;
      if (notify && notify.length > 0) allNotify.push(...notify);
    }

    if (allNotify.length > 0) {
      try {
        await queueNotificationEvents(ctx, allNotify);
      } catch (err) {
        console.warn(
          "[hygglo.upsertOrdersAsReservationsBatch] queueNotificationEvents failed",
          String(err),
        );
      }
    }

    for (const [account_slug, items] of perAccountBank) {
      await ctx.runMutation(internal.listing_images.upsertFromHyggloItems, {
        account_slug,
        items,
      });
    }

    // Reactively converge the dashboard the moment something changes, rather
    // than waiting for the periodic crons (stats hourly, lifetime DAILY). The
    // refreshers are skip-when-clean / cheap, and we don't await — the poller's
    // hot path must not block on MV rebuilds.
    //  • "active/pending" MVs: on any obsolete/pickup transition OR any new
    //    request/confirmed booking (so the pending lists never lag a poll).
    //  • revenue MVs: only when realised revenue actually changed (pickups) —
    //    sparse, so the daily-only staleness that hid diogo's £18 can't recur.
    const pendingChanged = anyTransitionedToObsolete || allNotify.length > 0;
    if (pendingChanged || anyRevenueRealized) {
      try {
        if (pendingChanged) {
          await ctx.scheduler.runAfter(0, internal.mv.stats_drawer.refresh, { force: true });
          await ctx.scheduler.runAfter(0, internal.mv.due_returns.refresh, {});
        }
        if (anyRevenueRealized) {
          await ctx.scheduler.runAfter(0, internal.mv.lifetime_revenue.refresh, {});
          await ctx.scheduler.runAfter(0, internal.mv.investment_scorecard.refresh, {});
        }
        // Monthly income chart (mv_earnings_by_period) sums gross_paid over all
        // LIVE reservations by month, so BOTH a new confirmed booking
        // (pendingChanged) AND a pickup (anyRevenueRealized) move the current
        // bucket. Was daily-only → up to 24h stale; refresh on either change.
        await ctx.scheduler.runAfter(0, internal.mv.earnings_by_period.refresh, {});
      } catch (err) {
        console.warn("[hygglo.upsertOrdersAsReservationsBatch] MV refresh schedule failed", String(err));
      }
    }

    return results;
  },
});

// ── Renter upsert (batch) ─────────────────────────────────────

/**
 * Upserts renters extracted from Hygglo order details.
 * Dedup by hygglo_user_id (indexed) when present, else by display_name (indexed).
 * Called by poll-hygglo-inbox and backfill scripts.
 */
export const upsertRentersBatch = mutation({
  args: {
    account_slug: v.string(),
    renters: v.array(
      v.object({
        hygglo_user_id: v.optional(v.string()),
        display_name: v.string(),
      })
    ),
  },
  handler: async (ctx, { account_slug: _account_slug, renters }): Promise<{ upserted: number; skipped: number }> => {
    let upserted = 0;
    let skipped = 0;
    const now = Date.now();

    for (const r of renters) {
      // 1. Try by hygglo_user_id (indexed, fast)
      if (r.hygglo_user_id) {
        const existing = await ctx.db
          .query("renters")
          .withIndex("by_hygglo_user_id", (q) => q.eq("hygglo_user_id", r.hygglo_user_id))
          .first();
        if (existing) {
          skipped++;
          continue;
        }
      }

      // 2. Fallback: by display_name (indexed)
      const displayNameTrimmed = r.display_name.trim();
      const existingByName = await ctx.db
        .query("renters")
        .withIndex("by_display_name", (q) => q.eq("display_name", displayNameTrimmed))
        .first();
      if (existingByName) {
        skipped++;
        continue;
      }

      await ctx.db.insert("renters", {
        hygglo_user_id: r.hygglo_user_id,
        display_name: displayNameTrimmed,
        created_at: now,
      });
      upserted++;
    }

    return { upserted, skipped };
  },
});

// ── Conversation upsert (batch) ───────────────────────────────

/**
 * Upserts one conversation row per Hygglo order that has chat messages.
 * Dedup by thread_id (= String(order.id)). Resolves renter_id by hygglo_user_id or name.
 * Called by poll-hygglo-inbox and backfill scripts.
 */
export const upsertConversationsBatch = mutation({
  args: {
    account_slug: v.string(),
    conversations: v.array(
      v.object({
        thread_id: v.string(),
        hygglo_user_id: v.optional(v.string()),
        display_name: v.string(),
        last_msg_at: v.number(),
        created_at: v.number(),
        // Date-less inquiry product snapshot (renter asked about a listing
        // without dates → no reservation). Lets the Reply Inbox tile show the
        // listing being asked about (assembleTile falls back to these).
        inquiry_items: v.optional(
          v.array(
            v.object({
              name: v.string(),
              qty: v.number(),
              image_url: v.optional(v.string()),
            })
          )
        ),
        inquiry_image_url: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { account_slug, conversations }): Promise<{ upserted: number; skipped: number }> => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_slug", (q) => q.eq("slug", account_slug))
      .first();
    const account_id = account?._id;

    let upserted = 0;
    let skipped = 0;

    for (const c of conversations) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.thread_id))
        .first();

      if (existing) {
        const patch: {
          last_msg_at?: number;
          inquiry_items?: typeof c.inquiry_items;
          inquiry_image_url?: string;
        } = {};
        if (c.last_msg_at > existing.last_msg_at) patch.last_msg_at = c.last_msg_at;
        // Backfill the date-less inquiry snapshot onto threads that already
        // exist (the common case: these inquiry conversations were created by
        // an earlier message poll before this field existed). Only write when
        // the poll carries one; never clear an existing snapshot.
        if (c.inquiry_items && c.inquiry_items.length > 0) {
          patch.inquiry_items = c.inquiry_items;
          if (c.inquiry_image_url) patch.inquiry_image_url = c.inquiry_image_url;
        }
        if (Object.keys(patch).length > 0) await ctx.db.patch(existing._id, patch);
        skipped++;
        continue;
      }

      // Resolve renter_id: prefer hygglo_user_id match, fall back to display_name (both indexed)
      let renter_id: import("./_generated/dataModel").Id<"renters"> | undefined;
      if (c.hygglo_user_id) {
        const renter = await ctx.db
          .query("renters")
          .withIndex("by_hygglo_user_id", (q) => q.eq("hygglo_user_id", c.hygglo_user_id))
          .first();
        renter_id = renter?._id;
      }
      if (!renter_id) {
        const renter = await ctx.db
          .query("renters")
          .withIndex("by_display_name", (q) => q.eq("display_name", c.display_name.trim()))
          .first();
        renter_id = renter?._id;
      }

      await ctx.db.insert("conversations", {
        thread_id: c.thread_id,
        account_id,
        renter_id,
        last_msg_at: c.last_msg_at,
        created_at: c.created_at,
        ...(c.inquiry_items && c.inquiry_items.length > 0
          ? {
              inquiry_items: c.inquiry_items,
              ...(c.inquiry_image_url ? { inquiry_image_url: c.inquiry_image_url } : {}),
            }
          : {}),
      });
      upserted++;
    }

    return { upserted, skipped };
  },
});



// B-3: list messages by thread_id for dashboard chat tool
export const listByThread = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const rows = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .order("desc")
      .take(50);
    // Newest 50 (so a long thread still includes the latest message the tile
    // previews), then back to chronological order for display.
    rows.reverse();
    return rows.map((m) => ({
      role: m.sender === "owner" ? "owner" : "renter",
      sender_name: m.sender_name ?? m.sender,
      content: m.body_text,
      timestamp: m.hygglo_sent_at ?? m.fetched_at,
    }));
  },
});

// ── Phase 18.2 — latest_activity skip-fetch optimisation ──────

/**
 * Returns the stored `latest_activity` value for each given hygglo_order_id.
 * Used by poll-hygglo to skip the per-order detail fetch when the list-endpoint
 * activity stamp matches the stored value (i.e. nothing changed since last poll).
 *
 * Missing rows / missing field → entry omitted from the returned map. Caller
 * must then proceed with the detail fetch.
 */
export const getLatestActivityBatch = query({
  args: { hygglo_order_ids: v.array(v.string()) },
  handler: async (ctx, { hygglo_order_ids }) => {
    // Returns { latest_activity, has_order_step } per id.
    // has_order_step lets the poller skip detail fetch ONLY when the row is
    // both unchanged AND already populated with order_step — otherwise we
    // must fetch to backfill order_step on legacy rows.
    const out: Record<
      string,
      { latest_activity: number | string; has_order_step: boolean }
    > = {};
    for (const id of hygglo_order_ids) {
      const row = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", id))
        .first();
      const la = (row as { latest_activity?: number | string } | null)
        ?.latest_activity;
      const step = (row as { order_step?: string } | null)?.order_step;
      if (la !== undefined) {
        out[id] = { latest_activity: la, has_order_step: step !== undefined };
      }
    }
    return out;
  },
});
