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
import type { Doc, Id } from "./_generated/dataModel";
import { bookedUnitsOnDate } from "./lib/availability";
import {
  reservationItemUnits,
  buildProductIndexMap,
  buildOverrideMap,
  type OverrideMap,
} from "./lib/reservations/itemUnits";

type RichItem = { name: string; qty: number; image_url: string | null };

/**
 * Per-item name + qty + thumbnail for the reply tile / draft context. Image
 * source priority: hygglo_items[] (authoritative per-item imagery) →
 * image_hints[] matched by normalised name → items[] (name/qty only, no image).
 *
 * When there is NO reservation (a date-less inquiry — renter asked "is this
 * available?" without picking dates), fall back to the conversation's
 * `inquiry_items` snapshot so the tile still shows the listing being asked
 * about. A reservation always wins when present; inquiry items are only the
 * no-reservation fallback.
 */
function buildRichItems(
  reservation: Doc<"reservations"> | null,
  conv?: Doc<"conversations"> | null,
): RichItem[] {
  if (!reservation) {
    return (conv?.inquiry_items ?? []).map((i) => ({
      name: i.name,
      qty: i.qty ?? 1,
      image_url: i.image_url ?? null,
    }));
  }
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

// ── Estimate (pricing_catalog × days) ────────────────────────────
// A rough quote for a requested set over a date range, shown CLEARLY labelled
// "Estimate" only when there's no confirmed price yet. Names are fuzzy-matched
// (normalised + token overlap) against pricing_catalog; unpriceable items are
// skipped and the estimate is omitted entirely if nothing matched.

const DAY_MS = 86_400_000;
// Squash to a case/space/punctuation-free key. The catalog stores camelCase,
// punctuation-smushed canonicals ("CanonR5", "SonyFX6", "Aputure300x"), so token
// overlap is hopeless — but substring containment on the squashed key is precise.
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

type PriceRow = { min: number; max: number; key: string };
type PriceIndex = PriceRow[];

async function loadPriceIndex(ctx: QueryCtx): Promise<PriceIndex> {
  const rows = await ctx.db.query("pricing_catalog").collect();
  const out: PriceIndex = [];
  for (const r of rows) {
    const key = squash(r.item_name_canonical);
    // Skip very short keys (would substring-match almost anything).
    if (key.length < 5) continue;
    out.push({ min: r.daily_price_min, max: r.daily_price_max, key });
  }
  return out;
}

/**
 * True if `key` occurs in `item` NOT immediately followed by another digit — so
 * a model key like "sonyfx3" won't match inside a longer model number
 * ("sonyfx30"). Prevents FX3 being priced as an FX30, A1 as an A10, etc.
 */
function keyMatches(item: string, key: string): boolean {
  let i = item.indexOf(key);
  while (i !== -1) {
    const after = item[i + key.length];
    if (after === undefined || after < "0" || after > "9") return true;
    i = item.indexOf(key, i + 1);
  }
  return false;
}

/**
 * Confident-or-nothing price match. A catalog canonical matches an item only
 * when its squashed key appears verbatim inside the item's squashed name
 * (e.g. "canonr5" ⊂ "canonr5cinemacamera"), with no trailing-digit collision.
 * The LONGEST such key wins (most specific). Items not in the catalog (e.g. an
 * FX30, which isn't listed) return null → no estimate, rather than a misleading
 * coincidental match.
 */
function priceFor(index: PriceIndex, name: string): PriceRow | null {
  const item = squash(name);
  if (item.length < 5) return null;
  let best: PriceRow | null = null;
  for (const row of index) {
    if (keyMatches(item, row.key) && (!best || row.key.length > best.key.length))
      best = row;
  }
  return best;
}

/** Sum mid daily-price × qty × days for the priceable items. null if none matched. */
function estimateForDays(
  index: PriceIndex,
  items: RichItem[],
  days: number,
): number | null {
  let total = 0;
  let priced = 0;
  for (const it of items) {
    const p = priceFor(index, it.name);
    if (!p) continue;
    total += ((p.min + p.max) / 2) * (it.qty || 1) * days;
    priced++;
  }
  return priced === 0 ? null : Math.round(total);
}

function computeEstimate(
  index: PriceIndex,
  items: RichItem[],
  start: string | null,
  end: string | null,
): { gbp: number | null; days: number | null } {
  if (!start || !end || items.length === 0) return { gbp: null, days: null };
  const s = new Date(`${start}T00:00:00`).getTime();
  const e = new Date(`${end}T00:00:00`).getTime();
  if (isNaN(s) || isNaN(e) || e < s) return { gbp: null, days: null };
  const days = Math.max(1, Math.round((e - s) / DAY_MS));
  return { gbp: estimateForDays(index, items, days), days };
}

/**
 * Best-effort: pull a rental length (in days) out of a free-text renter message,
 * for inquiries that mention a time frame but haven't formally requested dates
 * (e.g. "is this free this weekend?" / "for 3 days" / "26th-28th"). Returns null
 * when no time frame is detectable — the estimate is then simply not shown.
 * Heuristic by design; the UI labels the result "Estimate" so it's never taken
 * as a firm quote.
 */
function parseMentionedDays(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  let m = t.match(/(\d+)\s*(?:day|night)s?\b/);
  if (m) return Math.min(60, Math.max(1, parseInt(m[1], 10)));
  m = t.match(/(\d+)\s*weeks?\b/);
  if (m) return Math.min(60, Math.max(1, parseInt(m[1], 10) * 7));
  if (/\b(?:a|one)\s+week\b/.test(t)) return 7;
  if (/weekend/.test(t)) return 2;
  // numeric day-of-month range: "26-28", "26 to 28", "26th – 28th". Both numbers
  // must be plausible days (≤31) and span ≤31 — guards against focal lengths
  // like "24-70mm" (70 > 31 → rejected).
  m = t.match(
    /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})\s*(?:st|nd|rd|th)?\b/,
  );
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 31 && b >= a && b - a <= 31)
      return Math.max(1, b - a);
  }
  if (/\b(?:tomorrow|today|tonight|one day|a day|single day|for the day)\b/.test(t))
    return 1;
  return null;
}

// ── Availability / double-booking ────────────────────────────────
// For a reservation/request with dates, work out whether accepting it would be
// a double-booking: per resolved item, compare existing occupancy (CONFIRMED,
// and OPTIONALLY pending) over the window against owned units. Reuses the same
// occupancy maths as the calendar/overbooking (bookedUnitsOnDate + the canonical
// reservationItemUnits resolution), so the verdict matches the rest of the app.

type ItemAvail = {
  name: string;
  requested: number;
  total_units: number;
  booked: number; // peak confirmed units out over the window (excl. this res)
  pending: number; // peak pending units (only when include_pending)
  free: number; // total - occupancy
  available: boolean; // free >= requested
};
type TileAvailability = {
  status: "available" | "conflict";
  include_pending: boolean;
  items: ItemAvail[];
};

type AvailCtx = {
  confirmed: Doc<"reservations">[];
  pending: Doc<"reservations">[];
  productIndex: Map<string, string>;
  overrideMap: OverrideMap;
  itemQty: Map<string, number>;
  itemName: Map<string, string>;
  includePending: boolean;
};

/** Inclusive YYYY-MM-DD list from start→end, capped to bound query cost. */
function expandDates(start: string, end: string, cap = 45): string[] {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  if (isNaN(s) || isNaN(e) || e < s) return [start];
  const out: string[] = [];
  for (let t = s; t <= e && out.length < cap; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function loadAvailCtx(
  ctx: QueryCtx,
  includePending: boolean,
): Promise<AvailCtx> {
  const confirmed = await ctx.db
    .query("reservations")
    .withIndex("by_status", (q) => q.eq("status", "confirmed"))
    .collect();
  const pending = includePending
    ? (await ctx.db.query("reservations").collect()).filter(
        (r) =>
          r.status === "pending_review" &&
          r.order_step === "VERIFIED" &&
          !r.is_obsolete,
      )
    : [];
  const [pidx, ovr, items] = await Promise.all([
    ctx.db.query("hygglo_product_index").collect(),
    ctx.db.query("listing_resolution_override").collect(),
    ctx.db.query("items").collect(),
  ]);
  const itemQty = new Map<string, number>();
  const itemName = new Map<string, string>();
  for (const it of items) {
    const id = String(it._id);
    itemQty.set(id, it.is_marketing_only ? 0 : it.qty ?? 0);
    itemName.set(id, it.name_canonical ?? "item");
  }
  return {
    confirmed,
    pending,
    productIndex: buildProductIndexMap(
      pidx as Array<{ account_slug: string; product_id: number; item_id: Id<"items"> }>,
    ),
    overrideMap: buildOverrideMap(
      ovr as Array<{
        account_slug: string;
        product_id: number;
        components: Array<{ item_id: Id<"items"> | string; qty: number }>;
      }>,
    ),
    itemQty,
    itemName,
    includePending,
  };
}

function computeAvailability(
  reservation: Doc<"reservations"> | null,
  av?: AvailCtx,
): TileAvailability | null {
  if (!av || !reservation) return null;
  const start = reservation.pickup_date ?? reservation.start_date;
  const end = reservation.return_date ?? reservation.end_date;
  if (!start || !end) return null;
  const units = reservationItemUnits(
    reservation,
    av.productIndex,
    av.overrideMap,
  );
  if (units.size === 0) return null;

  const selfId = reservation._id;
  const confirmed = av.confirmed.filter((r) => r._id !== selfId);
  const pendingRows = av.includePending
    ? av.pending.filter((r) => r._id !== selfId)
    : [];
  const dates = expandDates(start, end);

  const out: ItemAvail[] = [];
  let anyConflict = false;
  for (const [itemIdStr, reqQty] of units) {
    const total = av.itemQty.get(itemIdStr) ?? 0;
    if (total <= 0) continue; // marketing-only / unknown — can't assess, skip
    const itemId = itemIdStr as Id<"items">;
    let booked = 0;
    let pending = 0;
    for (const d of dates) {
      const b = bookedUnitsOnDate(confirmed, itemId, d);
      if (b > booked) booked = b;
      if (av.includePending) {
        const p = bookedUnitsOnDate(pendingRows, itemId, d);
        if (p > pending) pending = p;
      }
    }
    const free = total - booked - pending;
    const available = free >= reqQty;
    if (!available) anyConflict = true;
    out.push({
      name: av.itemName.get(itemIdStr) ?? "item",
      requested: reqQty,
      total_units: total,
      booked,
      pending,
      free,
      available,
    });
  }
  if (out.length === 0) return null;
  return {
    status: anyConflict ? "conflict" : "available",
    include_pending: av.includePending,
    items: out,
  };
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
  priceIndex?: PriceIndex,
  availCtx?: AvailCtx,
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

  const richItems = buildRichItems(reservation, conv);
  const primaryImage =
    richItems.find((i) => i.image_url)?.image_url ??
    reservation?.photos_urls?.[0] ??
    // Date-less inquiry fallback (no reservation): the snapshot's own image, or
    // the first inquiry item's image.
    (reservation ? null : conv?.inquiry_image_url ?? null) ??
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

  // Estimate, always CLEARLY labelled "Estimate" in the UI and never shown when
  // a real price exists. Two sources:
  //  1. A reservation with dates but no confirmed gross yet (rare — Hygglo
  //     usually fills gross on request) → price the set over that date range.
  //  2. A date-less INQUIRY (no reservation) whose chat mentions a time frame
  //     ("this weekend", "for 3 days", "26-28") → parse the length and price the
  //     listing the renter is asking about. This is the common, useful case.
  let estimateGbp: number | null = null;
  let estimateDays: number | null = null;
  if (priceIndex && richItems.length > 0) {
    if (
      reservation?.gross_paid_gbp == null &&
      reservation?.start_date &&
      reservation?.end_date
    ) {
      const est = computeEstimate(
        priceIndex,
        richItems,
        reservation.start_date,
        reservation.end_date,
      );
      estimateGbp = est.gbp;
      estimateDays = est.days;
    } else if (!reservation) {
      const days = parseMentionedDays(latestMsg?.body_text);
      if (days) {
        estimateGbp = estimateForDays(priceIndex, richItems, days);
        estimateDays = estimateGbp != null ? days : null;
      }
    }
  }

  // Double-booking check for dated reservations/requests (null otherwise).
  const availability = computeAvailability(reservation, availCtx);

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
    // "request" = pending approve/decline; "message" = a normal chat thread.
    // Drives the Quick Reply filter (All / Requests / Messages).
    kind: (isRequest ? "request" : "message") as "request" | "message",
    last_sender: conv?.last_sender ?? null,
    // Granular owner actions (undefined → UI derives from is_request). Lets the
    // widget show only Decline once I've approved (accept gone, deny remains).
    can_accept: (reservation as { can_accept?: boolean } | null)?.can_accept ?? null,
    can_deny: (reservation as { can_deny?: boolean } | null)?.can_deny ?? null,
    gross_paid_gbp: reservation?.gross_paid_gbp ?? null,
    net_to_owner_gbp: reservation?.net_to_owner_gbp ?? null,
    delivery_fee_gbp: reservation?.delivery_fee_gbp ?? null,
    estimate_gbp: estimateGbp,
    estimate_days: estimateDays,
    availability,
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
    // Include ALL recent conversations (normal messages), not just ones awaiting
    // my reply. Lets the Quick Reply "Messages" filter browse any chat thread.
    includeMessages: v.optional(v.boolean()),
    // Recency floor for the normal-messages pass (wider than withinDays so older
    // chats are still browsable).
    messagesWithinDays: v.optional(v.number()),
    // Count pending (not-yet-confirmed) reservations as occupying stock in the
    // double-booking check. Omitted → reads the persisted setting.
    includePending: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    {
      accountSlug,
      limit = 60,
      withinDays = 5,
      includeFinished = false,
      includeMessages = true,
      messagesWithinDays = 30,
      includePending,
    },
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
    const priceIndex = await loadPriceIndex(ctx);
    const incPending =
      includePending ??
      (await ctx.db.query("settings").first())?.availability_include_pending ??
      false;
    const availCtx = await loadAvailCtx(ctx, incPending);

    // Pass 1 — conversations awaiting my reply (renter spoke last), windowed.
    // A renter who spoke last is waiting on me REGARDLESS of the order's
    // lifecycle state, so we do NOT drop finished reservations here. Live
    // inquiries land on cancelled/declined/expired Hygglo orders all the time
    // ("super interested in renting this lens", "looking to rent Saturday") —
    // excluding finished orders here was hiding ~88% of recent renter messages
    // from the widget (2026-06-26). The finished-exclusion still applies to the
    // browse-everything Pass 3 below (owner-last / no pending reply).
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
      const tile = await assembleTile(ctx, conv, reservation, conv.thread_id, priceIndex, availCtx);
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
      const tile = await assembleTile(ctx, conv, r, threadId, priceIndex, availCtx);
      if (accountOk(tile.account_slug)) byThread.set(threadId, tile);
    }

    // Pass 3 — NORMAL MESSAGES: every other recent conversation (owner spoke
    // last, or just chatter with no pending action), so the "Messages" filter
    // can browse any thread — not only ones awaiting my reply. Bounded by a
    // wider recency window; finished rentals still excluded unless asked.
    if (includeMessages) {
      const msgCutoff = Date.now() - messagesWithinDays * 86_400_000;
      const allConvos = await ctx.db.query("conversations").collect();
      for (const conv of allConvos) {
        if (byThread.has(conv.thread_id)) continue;
        const recencyTs = conv.last_msg_at ?? conv.last_renter_msg_at ?? 0;
        if (recencyTs < msgCutoff) continue;
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
        const tile = await assembleTile(ctx, conv, reservation, conv.thread_id, priceIndex, availCtx);
        if (accountOk(tile.account_slug)) byThread.set(conv.thread_id, tile);
      }
    }

    // Order: requests first → then awaiting-my-reply (oldest/most-urgent first)
    // → then normal chats (most-recent first).
    const tiles = [...byThread.values()].sort((a, b) => {
      if (a.is_request !== b.is_request) return Number(b.is_request) - Number(a.is_request);
      const aAwait = a.last_sender === "renter";
      const bAwait = b.last_sender === "renter";
      if (aAwait !== bAwait) return Number(bAwait) - Number(aAwait);
      if (aAwait) return (a.last_renter_msg_at ?? 0) - (b.last_renter_msg_at ?? 0);
      return (b.last_msg_at ?? 0) - (a.last_msg_at ?? 0);
    });
    return tiles.slice(0, limit);
  },
});

/**
 * Single-thread tile for the notification deep link (2026-06-23). Unlike
 * getReplyQueue this returns ANY thread by id — including confirmed bookings
 * that aren't "awaiting my reply" — so a tapped push (booking_confirmed or
 * new_request) can open the chat modal regardless of queue state. Returns null
 * when neither a conversation nor a reservation exists for the id.
 */
export const getThreadById = query({
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
    if (!conv && !reservation) return null;
    const priceIndex = await loadPriceIndex(ctx);
    const incPending =
      (await ctx.db.query("settings").first())?.availability_include_pending ??
      false;
    const availCtx = await loadAvailCtx(ctx, incPending);
    return await assembleTile(
      ctx,
      conv,
      reservation,
      thread_id,
      priceIndex,
      availCtx,
    );
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

    const richItems = buildRichItems(reservation, conv);
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

/**
 * Persist the owner-action state on a reservation after an approve/decline in
 * the widget, so the buttons immediately + persistently reflect it (approve →
 * accept gone, deny remains; decline → neither). Keyed by hygglo_order_id.
 */
export const setOwnerActionState = internalMutation({
  args: { thread_id: v.string(), can_accept: v.boolean(), can_deny: v.boolean() },
  handler: async (ctx, { thread_id, can_accept, can_deny }) => {
    const r = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    if (!r) return { ok: false };
    await ctx.db.patch(r._id, { can_accept, can_deny });
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
