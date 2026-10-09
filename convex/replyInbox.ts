import { loadCanonicalListingAllocation } from "./lib/canonical_listing_allocation";
import {nativeInformationForText,nativeInformationClaimRequest} from "./lib/native_information_blocks";
import {ownedItemHirePriceReader} from "./lib/owned_item_hire_price";
import {currentKitEvidence} from "./lib/current_kit_evidence";
import {unsupportedKitClaims,kitClaimsNeedEvidence} from "./lib/kit_claims";
import {inquiryOffersForText} from "./lib/native_inquiry_offer";
import {sameRentalRequest} from "./lib/rental_request";
import {negotiationFromMessages} from "./lib/renter_bot_negotiation";
import { bookingRecord, hasSingleBookingRecord } from "./lib/booking_record";
import {claimsBookingConfirmation,claimsCurrentOwnerApproval,hasPickupDisclosure,pickupPrivacySources,unsupportedBookingDateClaims} from "./lib/booking_reply_claims";
import { renterPriceEvidence } from "../src/lib/renter-price-evidence";
import { unsupportedPriceClaims, type PriceEvidence } from "./lib/price_claims";
import { performJointStockCheck } from "./renter_bot_tools";
import { qualifyRecommendationBasket } from "./lib/recommendation_qualification";
import { equipmentClaimProfiles, equipmentClaimsNeedProfiles } from "./lib/equipment_claim_profiles";
import { unsupportedRenterCameraClaims } from "./lib/renter_camera_identity";
import { unsupportedLensFocusClaims } from "./lib/lens_focus_claims";
import { unsupportedCameraModeClaims, unsupportedBuiltInNDClaims } from "./lib/camera_mode_claims";
import { renterHistory } from "./lib/renter_history";
import { conversationStageValidator } from "./lib/conversation_stage_validator";
import type { ConversationStage } from "./lib/renter_bot_intents";
import { resolveBotRenter } from "./lib/renter_identity";
import { ownerCheckValidator } from "./lib/owner_checks";
import { persistOwnerChecks } from "./renter_bot_owner_checks";
import {recordSentRentalRequest,validateRentalRequest} from "./lib/sent_rental_request";
import { sentBookingProposals } from "./lib/renter_sent_proposal";
import { listingDisplayCatalog } from "./lib/listing_display_catalog";
import { shortListingTitle, shortItemName } from "./lib/item_display_name";
import { verifiedItemSpec } from "./lib/verified_item_spec";
import { getBotBooking, getLabOrder, requestedListingContext, type BotBooking } from "./lib/renter_booking";
import { rentalStage } from "./lib/rental_stage";
import { londonToday } from "./lib/effectiveDates";
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
import { query, mutation, internalQuery, internalMutation, internalQueryOf } from "./owner_functions";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { draftEvidenceValidator } from "./lib/renter_draft_evidence";
import { currentDraftApproval, currentDraftReview, draftContextKey, sameDraftApproval } from "./lib/draft_review";
import { loadStockSources, resolveStockItem, stockForRentalItem } from "./lib/renter_stock";
import { stockRequestForSeparateCheck, stockRequestForInquiryQuote, unsupportedStockClaims, type StockReceipt } from "./lib/stock_claims";
import { reviewFlagValidator } from "./lib/draft_review_validator";
import { inclusiveRentalDays } from "./lib/hygglo_pricing";
import { summarise } from "./lib/renter_order_quote";
import { chronologicalThreadMessages, recentThreadMessages } from "./lib/thread_messages";
import { filterImminentHandoffs, type ImminentHandoffCandidate } from "./lib/imminent_handoffs";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { PREFIX as PROBE_THREAD_PREFIX } from "./renter_bot_probe";
import { readWidgetMv } from "./lib/widget_mv";
import { exactListingProductIds } from "./lib/draft_listing_grounding";
import { bookedUnitsOnDate } from "./lib/availability";
import {
  reservationItemUnits,
  buildProductIndexMap,
  type OverrideMap,
} from "./lib/reservations/itemUnits";
import { profileRenter } from "./lib/renter_dna";
import { selectPlaybook, selectLessons, type MemoryRow, type LessonRow } from "./lib/draft_playbook";
import {
  haversineKm,
  tooHeavyForLocation,
  nameHeavy,
  type OrderWeight,
  type Vehicle,
} from "./lib/delivery_weight";

/** Settings hub config slice used to rate a tile's location. */
// Per-account hub book: each account's hub coords (from its account_profiles)
// plus the global heavy/max-km ranges (from settings). Built once per query.
type HubBook = {
  bySlug: Map<string, { lat: number | null; lng: number | null }>;
  heavyMaxKm: number | null;
  maxKm: number | null;
  draftEpoch: number;
};

async function loadHubBook(ctx: QueryCtx): Promise<HubBook> {
  const settings = await ctx.db.query("settings").first();
  const profiles = await ctx.db.query("account_profiles").collect();
  const bySlug = new Map<string, { lat: number | null; lng: number | null }>();
  for (const p of profiles) {
    const acc = await ctx.db.get(p.account_id);
    if (acc?.slug)
      bySlug.set(acc.slug, { lat: p.hub_lat ?? null, lng: p.hub_lng ?? null });
  }
  return {
    bySlug,
    heavyMaxKm: settings?.hub_heavy_max_km ?? null,
    maxKm: settings?.hub_max_km ?? null,
    draftEpoch: settings?.draft_epoch ?? 0,
  };
}

/**
 * Build the tile/thread location overlay from the cached listing location + the
 * order's OWN account hub. Distance + the too-heavy/out-of-range flags are
 * derived LIVE so they follow each account's hub without rewriting reservations.
 */
function computeLocation(
  reservation: BotBooking | null,
  slug: string | undefined,
  hubBook: HubBook | null,
) {
  if (!reservation || reservation.loc_lat == null || reservation.loc_lng == null)
    return null;
  const lat = reservation.loc_lat;
  const lng = reservation.loc_lng;
  const hub = slug ? hubBook?.bySlug.get(slug) : undefined;
  let distance_km: number | null = null;
  let too_heavy = false;
  let out_of_range = false;
  if (hub?.lat != null && hub?.lng != null) {
    distance_km =
      Math.round(haversineKm({ lat: hub.lat, lng: hub.lng }, { lat, lng }) * 10) / 10;
    const order: OrderWeight = {
      totalWeightKg: reservation.loc_total_weight_kg ?? 0,
      maxSizeScore: 0,
      bigItems: reservation.loc_big_items ?? 0,
      vehicle: (reservation.loc_vehicle as Vehicle) ?? "car",
      vehicleLabel: "",
      heaviestKg: reservation.loc_heaviest_kg ?? 0,
    };
    const heavyMaxKm = hubBook?.heavyMaxKm ?? 0.5;
    const r = tooHeavyForLocation(order, distance_km, heavyMaxKm, hubBook?.maxKm ?? 30);
    out_of_range = r.outOfRange;
    // Name-based heaviness catches gear whose inventory weight_kg is missing
    // (power stations, DJ decks, speakers, multiple cameras/lights).
    const heavyByName = nameHeavy(reservation.hygglo_items ?? []);
    too_heavy = r.tooHeavy || (heavyByName && distance_km > heavyMaxKm);
  }
  return {
    label: reservation.loc_label ?? reservation.loc_area ?? null,
    area: reservation.loc_area ?? null,
    zip: reservation.loc_zip ?? null,
    street: reservation.loc_street ?? null,
    public_url: reservation.loc_public_url ?? null,
    map_url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    // Keyless Google Maps embed (streets + stations) for the in-app overlay.
    map_embed_url: `https://maps.google.com/maps?q=${lat},${lng}&z=15&output=embed`,
    distance_km,
    vehicle: reservation.loc_vehicle ?? null,
    too_heavy,
    out_of_range,
  };
}

type RichItem = { name: string; product_id?: number; display_name?: string; qty: number; image_url: string | null };

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
  reservation: BotBooking | null,
  conv?: Doc<"conversations"> | null,
): RichItem[] {
  if (!reservation) {
    return (conv?.inquiry_items ?? []).map((i) => ({
      name: i.name,
      product_id: i.product_id,
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
      product_id: h.product_id,
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
// Owner's share of the rental after Hygglo's ~20% lender fee — used to estimate
// earnings when there's no confirmed payout yet. Verified on a live order:
// £176 lender earnings on a £220 rental (0.8). See feature_rmv2_order_edit_api.
const OWNER_SHARE = 0.8;
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
  const days = inclusiveRentalDays(start, end);
  if (days === null) return { gbp: null, days: null };
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
  itemRows: Doc<"items">[];
  includePending: boolean;
  // PERF (2026-07-12): every reservation row the confirmed/pending collects
  // already paid for, keyed by hygglo_order_id — built from the RAW collect
  // results (before the order_step/is_obsolete filters) so RETURNED/obsolete
  // rows are served too. getReplyQueue consults this before doing a per-thread
  // by_hygglo_order_id `.first()`, killing the N+1 fat-reservation re-reads.
  // Safe as a `.first()` substitute because hygglo_order_id is unique across
  // reservations: both writers (hygglo.upsertOrderImpl, sync_dbcinema_web)
  // `.first()`-then-patch on this index, and Convex mutations are serializable
  // so no duplicate insert can race in.
  byOrderId: Map<string, Doc<"reservations">>;
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
  // Confirmed rentals only — but EXCLUDE ones whose gear is already back
  // (step RETURNED/REVIEWED) or that were superseded (is_obsolete). Hygglo
  // leaves status="confirmed" after a return, so without this a returned rental
  // kept blocking its item for the old dates (the "anamorphic shows rented but
  // it has no live booking" bug, 2026-06-27).
  const confirmedRaw = await ctx.db
    .query("reservations")
    .withIndex("by_status", (q) => q.eq("status", "confirmed"))
    .collect();
  const confirmed = confirmedRaw.filter(
    (r) =>
      !r.is_obsolete &&
      r.order_step !== "RETURNED" &&
      r.order_step !== "REVIEWED",
  );
  // PERF: was a whole-table `.collect()` scan every fire. by_status narrows to
  // pending_review rows; the remaining order_step/is_obsolete filters are kept.
  const pendingRaw = includePending
    ? await ctx.db
        .query("reservations")
        .withIndex("by_status", (q) => q.eq("status", "pending_review"))
        .collect()
    : [];
  const pending = pendingRaw.filter(
    (r) => r.order_step === "VERIFIED" && !r.is_obsolete,
  );
  // Order-id map from the rows just read (see AvailCtx.byOrderId). Built from
  // the RAW (pre-filter) rows. On a (theoretical) duplicate order id, keep the
  // oldest _creationTime — exactly what `.first()` on by_hygglo_order_id returns.
  const byOrderId = new Map<string, Doc<"reservations">>();
  for (const r of [...confirmedRaw, ...pendingRaw]) {
    if (!r.hygglo_order_id) continue;
    const prev = byOrderId.get(r.hygglo_order_id);
    if (!prev || r._creationTime < prev._creationTime)
      byOrderId.set(r.hygglo_order_id, r);
  }
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
    overrideMap: await loadCanonicalListingAllocation(ctx,items,ovr),
    itemQty,
    itemName,
    itemRows: items,
    includePending,
    byOrderId,
  };
}

function computeAvailability(
  reservation: BotBooking | null,
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
    av.itemRows,
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
      const b = bookedUnitsOnDate(confirmed, itemId, d, {productIndex:av.productIndex,overrides:av.overrideMap,inventory:av.itemRows});
      if (b > booked) booked = b;
      if (av.includePending) {
        const p = bookedUnitsOnDate(pendingRows, itemId, d, {productIndex:av.productIndex,overrides:av.overrideMap,inventory:av.itemRows});
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
  reservation: BotBooking | null,
  threadId: string,
  priceIndex?: PriceIndex,
  availCtx?: AvailCtx,
  hub?: HubBook,
  display?: Awaited<ReturnType<typeof listingDisplayCatalog>>,
) {
  const simOrder = await getLabOrder(ctx, threadId);
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

  const sourceItems: RichItem[] = simOrder ? simOrder.items.map(i => ({ name: i.name, qty: i.qty, product_id: i.product_id, image_url: null })) : buildRichItems(reservation, conv);
  const richItems = sourceItems.map(i => ({ ...i, display_name: i.product_id != null && slug && display ? display.name(slug, i.product_id, i.name) : shortItemName(shortListingTitle(i.name)) }));
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
  // "Waiting since" timestamp driving the urgency timer. Prefer the ACTUAL latest
  // renter message so a follow-up RESETS the clock instead of still reading "3d
  // unreplied" off the first message (Daniel, 2026-06-28). When the renter spoke
  // last, latestMsg IS that message — read it straight from the thread rather
  // than trusting the cached conv field, which can lag. A booking REQUEST often
  // has NO chat messages (renter just submitted dates), so fall back to the
  // cached fields then the order-created time — without that this is 0 (epoch)
  // and the card shows a nonsense ~20,000-day age that reads as "over 10 days
  // old" (Daniel, 2026-06-27).
  const renterSpokeLast = !!latestMsg && latestMsg.sender !== "owner";
  const renterLatestTs = renterSpokeLast
    ? latestMsg!.hygglo_sent_at ?? latestMsg!.fetched_at
    : 0;
  const lastRenterAt =
    renterLatestTs ||
    conv?.last_renter_msg_at ||
    conv?.last_msg_at ||
    latestMsg?.hygglo_sent_at ||
    latestMsg?.fetched_at ||
    reservation?.created_at ||
    reservation?._creationTime ||
    Date.now();

  // Owner-dismissed ("× close") threads stay hidden until the renter speaks
  // again: dismissed when a dismissed_at stamp exists AND no renter message has
  // landed since (their newest message is older-or-equal to the stamp). A fresh
  // renter message (lastRenterAt > dismissed_at) un-hides it automatically.
  const dismissed =
    !!conv?.dismissed_at && lastRenterAt <= conv.dismissed_at;

  // REAL most-recent activity — NOT the cached conv.last_msg_at, which gets
  // stale-bumped by re-polls and lets year-old dead threads slip past the
  // recency window (Daniel, 2026-06-28 "still showing tiles older than 5 days").
  // Use the genuine latest message time, falling back to the request/reservation
  // creation time for a brand-new request that has no chat yet. The queue applies
  // a hard cutoff against this value so nothing truly old can leak through any
  // pass.
  const latestMsgTs = latestMsg
    ? latestMsg.hygglo_sent_at ?? latestMsg.fetched_at ?? 0
    : 0;
  const lastActivityAt = Math.max(
    latestMsgTs,
    reservation?.created_at ?? 0,
    reservation?._creationTime ?? 0,
  );

  // Estimate, always CLEARLY labelled "Estimate" in the UI and never shown when
  // a real price exists. Two sources:
  //  1. A reservation with dates but no confirmed gross yet (rare — Hygglo
  //     usually fills gross on request) → price the set over that date range.
  //  2. A date-less INQUIRY (no reservation) whose chat mentions a time frame
  //     ("this weekend", "for 3 days", "26-28") → parse the length and price the
  //     listing the renter is asking about. This is the common, useful case.
  // The rental length used for the estimate, in priority order:
  //   1. real requested/booked dates  → price over that range
  //   2. a time frame mentioned in the chat ("weekend", "3 days", "26-28")
  //   3. NOTHING said → assume ONE DAY (Daniel: "if no time is talked about or
  //      requested assume one day price for that item").
  let estimateGbp: number | null = null;
  let estimateDays: number | null = null;
  if (simOrder && reservation?.gross_paid_gbp == null) {
    estimateDays = inclusiveRentalDays(simOrder.start_date, simOrder.end_date);
    estimateGbp = estimateDays === null ? null : summarise(simOrder.items, simOrder.start_date, simOrder.end_date).total_gbp;
  } else if (priceIndex && richItems.length > 0 && reservation?.gross_paid_gbp == null) {
    if (reservation?.start_date && reservation?.end_date) {
      const est = computeEstimate(
        priceIndex,
        richItems,
        reservation.start_date,
        reservation.end_date,
      );
      estimateGbp = est.gbp;
      estimateDays = est.days;
    } else {
      const days = parseMentionedDays(latestMsg?.body_text) ?? 1;
      estimateGbp = estimateForDays(priceIndex, richItems, days);
      estimateDays = estimateGbp != null ? days : null;
    }
  }
  // Owner earnings for the headline: the real payout when known, else ~80% of
  // the estimated rental (Hygglo's lender fee).
  const estimateEarningsGbp =
    estimateGbp != null ? Math.round(estimateGbp * OWNER_SHARE) : null;

  // Double-booking check for dated reservations/requests (null otherwise).
  const availability = computeAvailability(reservation, availCtx);
  const draftApproval = currentDraftApproval(conv,{message_id:latestMsg?.message_id,epoch:hub?.draftEpoch??0,context_key:draftContextKey(reservation,conv?.inquiry_items,simOrder)});

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
    start_date: simOrder?.start_date ?? reservation?.start_date ?? null,
    end_date: simOrder?.end_date ?? reservation?.end_date ?? null,
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
    estimate_earnings_gbp: estimateEarningsGbp,
    availability,
    currency: reservation?.currency ?? "GBP",
    items: richItems.slice(0, 6),
    item_count: richItems.length,
    image_url: primaryImage,
    last_renter_msg_at: lastRenterAt,
    dismissed,
    last_activity_at: lastActivityAt,
    last_msg_at: conv?.last_msg_at ?? lastRenterAt,
    preview: latestMsg?.body_text ?? "",
    ai_draft_review: currentDraftReview(conv?.ai_draft_review, { message_id: latestMsg?.message_id,
      epoch: hub?.draftEpoch ?? 0, context_key: draftContextKey(reservation, conv?.inquiry_items, simOrder) }),
    has_draft: !!conv?.ai_draft_text,
    ai_draft_text: conv?.ai_draft_text ?? null,
    ai_draft_confidence: conv?.ai_draft_confidence ?? null,
    ai_draft_flags: conv?.ai_draft_flags ?? null,
    ai_draft_evidence: conv?.ai_draft_evidence ?? null,
    ai_draft_approval: draftApproval,
    // The preview belongs to an exact message, booking context and logic epoch.
    ai_draft_stale: !!conv?.ai_draft_text && !draftApproval,
    location: computeLocation(reservation, slug, hub ?? null),
  };
}

// Canonical config the reply-queue MV (mv_reply_queue) is precomputed under.
// MUST match the ReplyInbox.tsx call site AND mv/reply_queue.ts refresher, or the
// reader shim below won't hit the cache. limit is generous so the stored list is
// never truncated before the reader slices to the caller's limit.
export const REPLY_MV_WITHIN_DAYS = 5;
export const REPLY_MV_MESSAGES_WITHIN_DAYS = 5;
export const REPLY_MV_LIMIT = 1000;

type ReplyTile = NonNullable<Awaited<ReturnType<typeof assembleTile>>>;

/**
 * Project a full tile to its LIST shape for mv_reply_queue. The stored row is
 * re-pushed to every subscribed dashboard tab on every refresh, so it must carry
 * only what the collapsed list renders. Nulls the modal-only fat fields
 * (ai_draft_text / _confidence / _flags — the reply modal re-fetches the full
 * thread via getThreadById on open) and trims the rich `items` array to
 * {name, qty} (the list shows names via itemLine; the modal uses
 * availability.items + OrderEditor's own fetch, never tile.items). Keeps the
 * tile SHAPE identical (all keys present) so the query return type — and the
 * frontend's typed tile access — are unchanged.
 */
function leanTile(t: ReplyTile): ReplyTile {
  return {
    ...t,
    ai_draft_text: null,
    ai_draft_confidence: null,
    ai_draft_flags: null,
    ai_draft_evidence: null,
    ai_draft_approval: null,
    ai_draft_review: t.ai_draft_review ? { ...t.ai_draft_review, flags: [], evidence: undefined } : null,
    items: t.items.map((i) => ({ name: i.name, qty: i.qty })) as ReplyTile["items"],
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
    // Set ONLY by mv/reply_queue.ts:refreshAll to run the live assembly below
    // instead of reading the cache (avoids a reader→MV→reader loop).
    _bypassMv: v.optional(v.boolean()),
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
      _bypassMv,
    },
  ) => {
    // ── MV fast path ────────────────────────────────────────────────────────
    // For the canonical frontend config, read the precomputed tile list (one
    // indexed row) instead of running the full multi-pass assembly + N+1
    // fat-reservation reads + loadAvailCtx scan. Refreshed every ~5 min by the
    // mv_reply_queue cron (= poller cadence, so no reply freshness is lost). A
    // cold MV (first cron tick after deploy) falls through to the live assembly.
    if (
      !_bypassMv &&
      withinDays === REPLY_MV_WITHIN_DAYS &&
      messagesWithinDays === REPLY_MV_MESSAGES_WITHIN_DAYS &&
      includeFinished === false &&
      includeMessages === true
    ) {
      const settingsRow0 = await ctx.db.query("settings").first();
      const incPending0 =
        includePending ?? settingsRow0?.availability_include_pending ?? false;
      const mvRow = await ctx.db
        .query("mv_reply_queue")
        .withIndex("by_account", (q) =>
          q.eq("account", incPending0 ? "all:pending" : "all"),
        )
        .first();
      if (mvRow) {
        let tiles = mvRow.tiles as Array<
          NonNullable<Awaited<ReturnType<typeof assembleTile>>>
        >;
        if (accountSlug) {
          tiles = tiles.filter((t) => t.account_slug === accountSlug);
        }
        return tiles.slice(0, limit);
      }
    }

    const now = Date.now();
    const cutoff = now - withinDays * 86_400_000;
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
    const settingsRow = await ctx.db.query("settings").first();
    const incPending =
      includePending ?? settingsRow?.availability_include_pending ?? false;
    const hub = await loadHubBook(ctx);
    const display = await listingDisplayCatalog(ctx);
    const availCtx = await loadAvailCtx(ctx, incPending);

    // ── Shared reads (PERF, 2026-07-12) ─────────────────────────────────────
    // One windowed conversations collect serves BOTH Pass 1 and Pass 3 (on the
    // MV refresher path the two windows are the same 5 days, so this halves the
    // conversations read; the fat unbounded by_last_sender collect is gone).
    const msgCutoff = now - messagesWithinDays * 86_400_000;
    const windowStart = includeMessages ? Math.min(cutoff, msgCutoff) : cutoff;
    const windowConvos = (
      await ctx.db
        .query("conversations")
        .withIndex("by_last_msg_at", (q) => q.gte("last_msg_at", windowStart))
        .collect()
    ).filter((c) => !c.thread_id.startsWith(PROBE_THREAD_PREFIX));
    // thread_id → conversation, for Pass 2's per-request lookups. thread_id is
    // unique across conversations (every writer upserts via by_thread .first()),
    // so a map hit returns exactly what `.first()` would; misses fall through to
    // the indexed read. Oldest-first tie-break mirrors `.first()` regardless.
    const convByThread = new Map<string, Doc<"conversations">>();
    for (const c of windowConvos) {
      const prev = convByThread.get(c.thread_id);
      if (!prev || c._creationTime < prev._creationTime)
        convByThread.set(c.thread_id, c);
    }
    // Pass 2's request collects, hoisted above Pass 1 so their rows also feed
    // the reservation cache (a REQUEST thread in Pass 1 shouldn't re-read its
    // fat reservation doc). Pure reads — hoisting changes nothing semantically.
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
    // Reservation-by-order-id cache: loadAvailCtx's confirmed/pending rows plus
    // the request rows above — every reservation already read this execution.
    // See AvailCtx.byOrderId for why a hit is exactly `.first()`'s answer.
    const resByOrderId = availCtx.byOrderId;
    for (const r of [...byStep, ...byAction]) {
      if (!r.hygglo_order_id) continue;
      const prev = resByOrderId.get(r.hygglo_order_id);
      if (!prev || r._creationTime < prev._creationTime)
        resByOrderId.set(r.hygglo_order_id, r);
    }
    const resFor = async (
      threadId: string,
    ): Promise<Doc<"reservations"> | null> => {
      const cached = resByOrderId.get(threadId);
      if (cached) return cached;
      // Not in any collected status (e.g. completed/cancelled/declined orders
      // that live inquiries land on) — one indexed read, only for these.
      return await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) =>
          q.eq("hygglo_order_id", threadId),
        )
        .first();
    };

    // Pass 1 — conversations awaiting my reply (renter spoke last), windowed.
    // A renter who spoke last is waiting on me REGARDLESS of the order's
    // lifecycle state, so we do NOT drop finished reservations here. Live
    // inquiries land on cancelled/declined/expired Hygglo orders all the time
    // ("super interested in renting this lens", "looking to rent Saturday") —
    // excluding finished orders here was hiding ~88% of recent renter messages
    // from the widget (2026-06-26). The finished-exclusion still applies to the
    // browse-everything Pass 3 below (owner-last / no pending reply).
    //
    // PERF (2026-07-12): this used to `.collect()` EVERY renter-last
    // conversation ever (unbounded, fat docs carrying ai_draft_text) and drop
    // the old ones in JS. The kept per-row filter is
    // `(last_renter_msg_at ?? last_msg_at) >= cutoff`, and every writer keeps
    // `last_msg_at >= last_renter_msg_at` on renter-last rows:
    //   • hygglo.upsertMessages insert: both = latest.ts.
    //   • hygglo.upsertMessages patch: last_sender is only (re)stamped in the
    //     `ts >= last_msg_at` branch, which sets last_msg_at = max(prev, ts)
    //     and last_renter_msg_at = max(prev_lrma, ts) — both ≤ the new
    //     last_msg_at (prev_lrma ≤ prev last_msg_at inductively).
    //   • replyInbox.backfillLastSender: last_msg_at = max(prev, ts), lrma = ts.
    //   • renter_bot_probe: both = now. recordSentReply flips to OWNER-last,
    //     so it never produces a renter-last row.
    // So every row Pass 1 can keep has last_msg_at >= cutoff and is inside the
    // by_last_msg_at window scan above — identical output, bounded reads.
    // (Out-of-window REQUEST/awaiting-action threads were never Pass 1's job:
    // Pass 2 surfaces those from the reservations side, unchanged. The one
    // theoretical gap — a FUTURE-dated Hygglo renter stamp surviving across a
    // recordSentReply — could only stretch a tile's eligibility past the window
    // by the stamp skew, and such a tile is already dropped today by the hard
    // last_activity_at guard below, since its genuine newest message is older
    // than the window.)
    const convos = windowConvos
      .filter((c) => c.last_sender === "renter")
      // The old by_last_sender scan iterated [last_sender, _creationTime] asc;
      // keep that order so byThread insertion order — and therefore tie order
      // in the final stable sort — is byte-identical.
      .sort((a, b) => a._creationTime - b._creationTime);
    for (const conv of convos) {
      const recencyTs = conv.last_renter_msg_at ?? conv.last_msg_at;
      if (recencyTs < cutoff) continue;
      const reservation = await resFor(conv.thread_id);
      const tile = await assembleTile(ctx, conv, reservation, conv.thread_id, priceIndex, availCtx, hub, display);
      if (accountOk(tile.account_slug)) byThread.set(conv.thread_id, tile);
    }

    // Pass 2 — ALWAYS surface rental REQUESTs awaiting my approve/decline, even
    // if I spoke last or it's outside the recency window. This is what makes the
    // Approve / Decline buttons reliably reachable. (Collects hoisted above.)
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
      const conv =
        convByThread.get(threadId) ??
        (await ctx.db
          .query("conversations")
          .withIndex("by_thread", (q) => q.eq("thread_id", threadId))
          .first());
      // Respect the recency window even for requests. A request with no activity
      // in `withinDays` (no recent message AND created long ago) is stale —
      // Hygglo requests expire, so a 10-day-old "pending" one is almost always
      // dead and shouldn't sit at the top of the queue forever (Daniel,
      // 2026-06-27 "still showing messages over 10 days old"). Newest of: last
      // message / last renter message / when the order row was created.
      const reqTs = Math.max(
        conv?.last_msg_at ?? 0,
        conv?.last_renter_msg_at ?? 0,
        (r as { created_at?: number }).created_at ?? 0,
        r._creationTime ?? 0,
      );
      if (reqTs && reqTs < cutoff) continue;
      const tile = await assembleTile(ctx, conv, r, threadId, priceIndex, availCtx, hub, display);
      if (accountOk(tile.account_slug)) byThread.set(threadId, tile);
    }

    // Pass 3 — NORMAL MESSAGES: every other recent conversation (owner spoke
    // last, or just chatter with no pending action), so the "Messages" filter
    // can browse any thread — not only ones awaiting my reply. Bounded by a
    // wider recency window; finished rentals still excluded unless asked.
    if (includeMessages) {
      // PERF: reuses the shared by_last_msg_at window collect above (window ⊇
      // msgCutoff by construction; iteration order is the same index order).
      // last_msg_at is non-optional, so the per-row `recencyTs < msgCutoff` guard
      // below (kept) trims any wider window → identical result set.
      for (const conv of windowConvos) {
        if (byThread.has(conv.thread_id)) continue;
        const recencyTs = conv.last_msg_at ?? conv.last_renter_msg_at ?? 0;
        if (recencyTs < msgCutoff) continue;
        const reservation = await resFor(conv.thread_id);
        // Drop finished rentals from the wide (30-day) browse pass. Recent
        // renter-last threads on finished orders are already caught by Pass 1's
        // 5-day window; surfacing the FULL 30-day finished backlog here floods
        // "To reply" with hundreds of dead cancelled-order inquiries the renter
        // long moved on from — so keep excluding finished in this pass.
        if (!includeFinished && reservation) {
          const st = reservation.status;
          const step = reservation.order_step;
          if ((st && FINISHED_STATUS.has(st)) || (step && FINISHED_STEP.has(step)))
            continue;
        }
        const tile = await assembleTile(ctx, conv, reservation, conv.thread_id, priceIndex, availCtx, hub, display);
        if (accountOk(tile.account_slug)) byThread.set(conv.thread_id, tile);
      }
    }

    // HARD recency guard — the single source of truth. Every pass above
    // pre-filters on cached fields for speed, but those can be stale-bumped, so
    // the genuine last_activity_at (real latest message / request creation) is
    // re-checked here against the SAME `withinDays` window. Nothing older than the
    // window survives, regardless of which pass surfaced it or how stale its
    // cached timestamps are.
    const hardCutoff = Date.now() - withinDays * 86_400_000;
    // Owner-dismissed threads drop out of the whole widget until the renter
    // messages again (assembleTile re-clears `dismissed` once that happens).
    const tiles = [...byThread.values()]
      .filter((t) => !t.dismissed)
      .filter((t) => (t.last_activity_at ?? 0) >= hardCutoff)
      .sort((a, b) => {
      if (a.is_request !== b.is_request) return Number(b.is_request) - Number(a.is_request);
      const aAwait = a.last_sender === "renter";
      const bAwait = b.last_sender === "renter";
      if (aAwait !== bAwait) return Number(bAwait) - Number(aAwait);
      if (aAwait) return (a.last_renter_msg_at ?? 0) - (b.last_renter_msg_at ?? 0);
      return (b.last_msg_at ?? 0) - (a.last_msg_at ?? 0);
    });
    // Lean the list payload before returning/storing — see leanTile. The reader
    // MV-hit path returns already-lean stored tiles; this covers the live
    // assembly (refresher store + cold-start fallback).
    return tiles.slice(0, limit).map(leanTile);
  },
});

/**
 * Owner "× close" — dismiss a thread so it leaves the Quick Reply widget. Stays
 * gone until the renter sends another message (assembleTile compares the newest
 * renter message against dismissed_at and un-hides it). Upserts a minimal
 * conversation row for request-only threads that have no conversation yet.
 */
export const dismissThread = mutation({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const now = Date.now();
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    if (conv) {
      await ctx.db.patch(conv._id, { dismissed_at: now });
    } else {
      // No conversation row (pure request) — find the reservation's account so
      // the placeholder is still attributable.
      const reservation = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
        .first();
      await ctx.db.insert("conversations", {
        thread_id,
        account_slug: reservation?.account_slug,
        last_msg_at: now,
        last_sender: "owner",
        created_at: now,
        dismissed_at: now,
      });
    }
    // Reflect the dismissal in the cached reply queue immediately — the 5-min
    // cron's clean-check can't detect a dismissed_at patch (it doesn't bump
    // last_msg_at), so kick a forced rebuild now.
    await ctx.scheduler.runAfter(0, internal.mv.reply_queue.refresh, {
      force: true,
    });
    return { ok: true };
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
    const reservation = await getBotBooking(ctx, thread_id);
    if (!conv && !reservation) return null;
    const priceIndex = await loadPriceIndex(ctx);
    const settingsRow = await ctx.db.query("settings").first();
    const incPending = settingsRow?.availability_include_pending ?? false;
    const availCtx = await loadAvailCtx(ctx, incPending);
    return await assembleTile(
      ctx,
      conv,
      reservation,
      thread_id,
      priceIndex,
      availCtx,
      await loadHubBook(ctx),
      await listingDisplayCatalog(ctx),
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

    const reservation = await getBotBooking(ctx, thread_id);
    const simOrder = await getLabOrder(ctx, thread_id);

    let slug = reservation?.account_slug ?? conv?.account_slug ?? undefined;
    let accountId = reservation?.account_id ?? conv?.account_id ?? undefined;
    if (!slug && accountId) {
      const acc = await ctx.db.get(accountId);
      slug = acc?.slug;
    }

    if (!accountId && slug)accountId=(await ctx.db.query("accounts").withIndex("by_slug",q=>q.eq("slug",slug!)).first())?._id;

    // Per-account persona / voice / business rules for grounded drafting.
    let persona_prompt: string | undefined;
    let discount_codes: unknown;
    let business_rules: unknown;
    let delivery_policy: unknown;
    let response_style: unknown;
    let business_hours: unknown;
    let hard_truths: string | undefined;
    let profile: Doc<"account_profiles"> | null = null;
    let draft_text_blocks: {
      opening: string;
      availability: string;
      location: string;
      pickup_time: string;
      payment: string;
    } | undefined;
    if (accountId) {
      profile = await ctx.db
        .query("account_profiles")
        .withIndex("by_account", (q) => q.eq("account_id", accountId!))
        .first();
      persona_prompt = profile?.persona_prompt ?? profile?.persona ?? undefined;
      discount_codes = profile?.discount_codes;
      business_rules = profile?.rules;
      delivery_policy = profile?.delivery;
      response_style = profile?.response_style;
      business_hours = profile?.business_hours;
      hard_truths = profile?.hard_truths;
      const blocks = (profile as {
        draft_text_blocks?: Partial<typeof draft_text_blocks>;
      } | null)?.draft_text_blocks;
      if (blocks) {
        draft_text_blocks = {
          opening: typeof blocks.opening === "string" ? blocks.opening : "",
          availability: typeof blocks.availability === "string" ? blocks.availability : "",
          location: typeof blocks.location === "string" ? blocks.location : "",
          pickup_time: typeof blocks.pickup_time === "string" ? blocks.pickup_time : "",
          payment: typeof blocks.payment === "string" ? blocks.payment : "",
        };
      }
    }

    // Phase 5: house rules from the dedicated `rules` table (enabled, this
    // account or global), priority-sorted. Carries the critical disclosure
    // guards (never reveal AI / shared inventory, payment-template rules) the
    // draft previously never saw. Tiny table — collect + filter in JS.
    const allRules = await ctx.db.query("rules").collect();
    const house_rules = allRules
      .filter(
        (r) =>
          r.enabled &&
          (r.account_id == null ||
            (accountId != null && r.account_id === accountId)),
      )
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      // Include ALL enabled rules — the old slice(0,24) truncated past priority 9
      // and dropped load-bearing rules like "when a renter asks for an item we
      // don't stock, offer the closest owned alternative" (#27) and the delivery
      // rules (2026-06-28).
      .slice(0, 60)
      .map((r) => r.rule_body);

    // Per-account pickup/collection windows are owner-editable in Settings and
    // take precedence over the global fallback. This keeps Diogo's wording and
    // availability independent from Leo/DB Cinema while still giving a safe
    // shared default to accounts that have not been configured yet.
    const settingsRow = await ctx.db.query("settings").first();
    const pickupHours =
      profile?.pickup_hours && profile.pickup_hours.length
        ? profile.pickup_hours
        : settingsRow?.pickup_hours;
    const businessHoursText =
      pickupHours && pickupHours.length
        ? `Pickup/collection windows (Europe/London): ${pickupHours.map((h) => `${h.start}–${h.end}`).join(", ")}. Only confirm times inside these windows.`
        : business_hours
          ? JSON.stringify(business_hours)
          : null;

    const {renter,identity_conflict}=await resolveBotRenter(ctx,reservation,conv);
    const renterId=renter?._id;

    // Cached low (<4★) reviews for this renter, if any have been fetched — the
    // AI uses them to stay cautious (it must NOT quote them to the renter).
    let low_reviews: Array<{ rating: number; text: string }> = [];
    if (renterId) {
      const revs = await ctx.db
        .query("renter_reviews")
        .withIndex("by_renter", (q) => q.eq("renter_id", renterId))
        .collect();
      low_reviews = revs
        .filter((r) => r.rating != null && r.rating < 4 && !!r.text)
        .map((r) => ({ rating: r.rating as number, text: r.text as string }))
        .slice(0, 3);
    }

    const negotiationMsgs = await chronologicalThreadMessages(ctx, thread_id);
    const msgs = negotiationMsgs.slice(-40);
    const recent = msgs.slice(-15).map((m) => ({
      role: m.sender === "owner" ? "owner" : "renter",
      content: m.body_text,
    }));
    const latest = msgs[msgs.length - 1];

    // Phase 3 RenterDNA — a tone read derived purely from the renter's own
    // messages, evolved from any prior DNA. Persisted by generateDraft.
    const renterMsgs = msgs
      .filter((m) => m.sender !== "owner")
      .map((m) => m.body_text);
    const renter_dna =
      renterId && renterMsgs.length
        ? profileRenter(renterMsgs, renter?.renter_dna ?? undefined)
        : (renter?.renter_dna ?? null);

    const history=await renterHistory(ctx,renter,thread_id,londonToday());
    const prior_rentals=history.recorded_rentals_with_us??0;
    const last_rental_at=history.last_rental_with_us_at;

    // Phase 4 conversation stage (sales funnel). A reservation's DB status is
    // authoritative; a date-less inquiry is read from renter interest signals.
    let conversation_stage: ConversationStage;
    if (reservation) {
      conversation_stage = rentalStage(reservation,londonToday()).stage;
    } else {
      const renterText = renterMsgs.join(" ").toLowerCase();
      const interest =
        /\b(price|cost|how much|available|free|book|rent|hire|when|date|deliver|pickup|collect)\b/.test(
          renterText,
        );
      const affirmative =
        /\b(sounds good|perfect|great|yes|sure|let'?s do|i'?ll take|go ahead|book it)\b/.test(
          renterText,
        );
      conversation_stage =
        affirmative && renterMsgs.length >= 3
          ? "READY_TO_BOOK"
          : interest
            ? "INTERESTED"
            : "INQUIRY";
    }

    const richItems = simOrder ? simOrder.items.map((i) => ({ name: i.name, qty: i.qty, image_url: null })) : buildRichItems(reservation, conv);

    // Phase 0 unblock: resolve the requested items to real inventory units and
    // compute live availability for the rental dates — the SAME engine the queue
    // tile uses (confirmed-only, V1 rule: never count unaccepted requests). The
    // draft path previously saw only raw Hygglo listing text, so it could never
    // ground specs/availability. `availability` carries the resolved canonical
    // item names + per-item free/booked counts for the draft prompt + guard.
    let availability: TileAvailability | null = null;
    // Phase 2 FactPack: per-item specs + price + marketing flags for the items
    // in play — resolved from the RESERVATION when there is one, otherwise from
    // the INQUIRY's listing (the product the renter clicked "ask owner" on, kept
    // in conv.inquiry_items). This is what makes the bot KNOW the listing on a
    // bare inquiry instead of asking "which item?".
    let fact_pack: {
      pricing?: { itemPrices: { name: string; min: number; max: number }[] };
      specs: { name: string; text: string }[];
      marketingItems: string[];
      verifiedListingItem?: string;
    } | null = null;
    let owned_cameras: string[] = [];
    // Full owned inventory grouped by kind — so the draft can offer the closest
    // alternative in ANY category (audio/monitor/power/light/…), not just cameras.
    const owned_inventory: Record<string, string[]> = {};
    // line items with a product_id, from reservation OR inquiry listing.
    const lineItems: {
      name?: string | null;
      product_id?: number | null;
      product_id_exact: boolean;
    }[] =
      simOrder
        ? simOrder.items.map((i) => ({ name: i.name, product_id: i.product_id, product_id_exact: typeof i.product_id === "number" }))
        : reservation
        ? (reservation.hygglo_items ?? []).map((h) => ({
            name: h.name,
            product_id: h.product_id,
            product_id_exact: typeof h.product_id === "number",
          }))
        : (conv?.inquiry_items ?? []).map((it) => ({
            name: it.name,
            product_id: (it as { product_id?: number }).product_id,
            product_id_exact:
              typeof (it as { product_id?: number }).product_id === "number",
          }));
    // Lever 5 (grounding coverage): ~46% of inquiries arrive with only an item
    // NAME (no product_id), so the draft got no real listing facts and had to
    // guess. Recover the product_id by matching the name against THIS account's
    // cached listings (deterministic token-coverage match) so those threads get
    // real price/kit/specs too. (Daniel, 2026-07-03)
    const marketingAsks: string[] = [];
    // One shared availability snapshot supplies reservations, product mappings,
    // overrides and items for the entire draft-context build. Previously this
    // function collected the fat product-index and items tables again below.
    const availCtx = await loadAvailCtx(ctx, false);
    if (slug && lineItems.some((li) => typeof li.product_id !== "number")) {
      const STOP = new Set(["the","and","for","with","plus","set","kit","bundle","combo"]);
      const toks = (str: string) =>
        Array.from(
          new Set(
            (str.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
              // keep multi-char tokens AND standalone digits (model numbers
              // like the 5 in "Mini 5" are the key discriminator)
              (t) => (t.length > 1 || /^[0-9]$/.test(t)) && !STOP.has(t),
            ),
          ),
        );
      // Only match listings backed by OWNED inventory. A phantom / marketing
      // listing the account advertises but does not stock (e.g. a "DJI Mini 5
      // Pro" with no product-index entry) must NEVER be recovered as an
      // available item, or the bot offers gear it doesn't have. (Daniel)
      const ownedPids = new Set<number>();
      const prefix = `${slug}#`;
      for (const key of availCtx.productIndex.keys()) {
        if (!key.startsWith(prefix)) continue;
        const pid = Number(key.slice(prefix.length));
        if (Number.isFinite(pid)) ownedPids.add(pid);
      }
      const allListings = (
        await ctx.db
          .query("online_listings")
          .withIndex("by_account", (q) => q.eq("account_slug", slug!))
          .collect()
      ).map((l) => ({
        product_id: l.product_id,
        owned: ownedPids.has(l.product_id),
        tset: new Set(toks(l.name)),
      }));
      const bestOver = (
        name: string | null | undefined,
        pool: typeof allListings,
      ): number | null => {
        if (!name) return null;
        const q = toks(name);
        if (q.length < 2) return null;
        // Model numbers are hard constraints: if the renter's item has a
        // numeric token the listing lacks (Mini 5 vs Mini 4, 24-105 vs 24-70),
        // it is NOT that listing, however much other wording overlaps.
        const qDigits = q.filter((t) => /^[0-9]+$/.test(t));
        let best: number | null = null;
        let bestScore = 0;
        let bestSize = Infinity;
        for (const L of pool) {
          if (qDigits.some((d) => !L.tset.has(d))) continue;
          let hit = 0;
          for (const t of q) if (L.tset.has(t)) hit++;
          if (hit < 2) continue;
          const score = hit / q.length;
          if (score > bestScore || (score === bestScore && L.tset.size < bestSize)) {
            best = L.product_id;
            bestScore = score;
            bestSize = L.tset.size;
          }
        }
        return bestScore >= 0.6 ? best : null;
      };
      const ownedListings = allListings.filter((l) => l.owned);
      const mktListings = allListings.filter((l) => !l.owned);
      for (const li of lineItems) {
        if (typeof li.product_id === "number") continue;
        const ownedPid = bestOver(li.name, ownedListings);
        if (typeof ownedPid === "number") {
          li.product_id = ownedPid;
          continue;
        }
        // No owned match — did they ask about a MARKETING listing
        // (advertised to show the class of gear, but not stocked)? Flag it
        // so the draft redirects warmly to the real owned alternative.
        if (li.name && bestOver(li.name, mktListings) !== null)
          marketingAsks.push(li.name);
      }
    }
    try {
      // Owned inventory grouped by kind (active, real, in stock) — the source
      // for both the camera guard and offering alternatives in any category.
      const allItems = availCtx.itemRows;
      for (const it of allItems) {
        if (it.status !== "active" || it.is_marketing_only || (it.qty ?? 0) <= 0) continue;
        (owned_inventory[it.kind] ??= []).push(it.name_canonical);
      }
      for (const k of Object.keys(owned_inventory))
        owned_inventory[k] = owned_inventory[k].sort().slice(0, 16);
      owned_cameras = owned_inventory["camera"] ?? [];

      // Resolve the items in play to inventory itemIds, using the SAME good
      // resolver for reservations AND inquiries: override map → product index →
      // masterItemId fallback. (The old inquiry path used only masterItemId,
      // which is null for lots of real gear, so inquiries kept "not stocked".)
      const resolvedIds: string[] = [];
      const itemNameOf = new Map<string, string>();
      if (reservation) {
        availability = computeAvailability(reservation, availCtx);
        const units = reservationItemUnits(reservation, availCtx.productIndex, availCtx.overrideMap, availCtx.itemRows);
        for (const id of [...units.keys()].slice(0, 8)) {
          resolvedIds.push(id);
          itemNameOf.set(id, availCtx.itemName.get(id) ?? "item");
        }
      } else if (slug) {
        for (const li of lineItems) {
          if (typeof li.product_id !== "number") continue;
          const key = `${slug}#${li.product_id}`;
          const ov = availCtx.overrideMap.get(key);
          if (ov && ov.length) {
            for (const c of ov)
              if (!resolvedIds.includes(c.item_id)) resolvedIds.push(c.item_id);
            continue;
          }
          const direct = availCtx.productIndex.get(key);
          if (direct) {
            if (!resolvedIds.includes(direct)) resolvedIds.push(direct);
            continue;
          }
          const prod = await ctx.db
            .query("hygglo_products")
            .withIndex("by_account_product", (q) =>
              q.eq("accountSlug", slug!).eq("productId", li.product_id!),
            )
            .first();
          if (prod?.masterItemId) {
            const idStr = String(prod.masterItemId);
            if (!resolvedIds.includes(idStr)) resolvedIds.push(idStr);
          }
        }
      }

      if (resolvedIds.length) {
        const priceRows = await ctx.db.query("pricing_catalog").collect();
        const specs: { name: string; text: string }[] = [];
        const itemPrices: { name: string; min: number; max: number }[] = [];
        const marketingItems: string[] = [];
        for (const idStr of resolvedIds.slice(0, 8)) {
          const item = await ctx.db.get(idStr as Id<"items">);
          if (!item) continue;
          const name = item.name_canonical ?? itemNameOf.get(idStr) ?? "item";
          itemNameOf.set(idStr, name);
          if (item.is_marketing_only) marketingItems.push(name);
          const spec = await ctx.db
            .query("item_specs")
            .withIndex("by_item", (q) => q.eq("item_id", idStr as Id<"items">))
            .first();
          const verified = verifiedItemSpec(spec, name);
          if (verified) specs.push({ name, text: verified.text.slice(0, 1000) });
          const sq = squash(name);
          const pr = priceRows.find((r) => {
            const k = squash(r.item_name_canonical);
            return k.length >= 5 && keyMatches(sq, k);
          });
          if (pr) itemPrices.push({ name, min: pr.daily_price_min, max: pr.daily_price_max });
        }
        fact_pack = {
          pricing: itemPrices.length ? { itemPrices } : undefined,
          specs,
          marketingItems,
          verifiedListingItem:
            resolvedIds.length === 1 ? itemNameOf.get(resolvedIds[0]) : undefined,
        };
      }
    } catch {
      availability = null; // grounding is best-effort; never block a draft
      fact_pack = null;
    }

    // Unfulfillable = ONLY the owner-confirmed not-owned CAMERA list, matched in
    // the listing title (SEO bait like an "fx30" / "like Canon R5" kit). We do
    // NOT infer "we don't stock it" from hygglo_products flags or resolution
    // gaps — those misfire on real owned gear (a JBL set, an A7 II combo, a
    // Handycam) and made the bot tell renters their item doesn't exist. Telling
    // a renter a real item is unavailable is far worse than missing a rare
    // genuinely-unowned non-camera item.
    const unfulfillable: string[] = [];
    if (slug) {
      const titles = lineItems.map((li) => li.name ?? "").join(" | ").toLowerCase();
      const ownedLc = owned_cameras.join(" | ").toLowerCase();
      const tok = (hay: string, t: string) =>
        new RegExp(
          `(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`,
          "i",
        ).test(hay);
      const NOT_OWNED = [
        "fx30",
        "a7iv",
        "a7 iv",
        "a7sii",
        "a7s ii",
        "a7riii",
        "a7r iii",
        "a6600",
        "r5c",
        "canon r5",
        "canon r6",
      ];
      for (const model of NOT_OWNED)
        if (tok(titles, model) && !tok(ownedLc, model))
          unfulfillable.push(model.toUpperCase());
    }
    // Message-based not-owned scan — catch specific models the renter NAMES that
    // we don't stock, so the draft offers the owned alternative instead of
    // hallucinating (e.g. "we've got the Atomos Ninja V" when we own the Shogun/
    // Shinobi). Each entry carries the alternative hint into the FACTS.
    {
      const renterLc = renterMsgs.slice(-3).join(" ").toLowerCase();
      const ownedAllLc = Object.values(owned_inventory).flat().join(" ").toLowerCase();
      const NOT_OWNED_NAMED: Array<{ match: string; label: string }> = [
        { match: "ninja v", label: "Atomos Ninja V (recorder-monitor) — we DON'T stock it; offer our Atomos Shogun (records) or Atomos Shinobi (monitor)" },
        { match: "atomos ninja", label: "Atomos Ninja V — we DON'T stock it; offer our Atomos Shogun / Shinobi" },
      ];
      for (const n of NOT_OWNED_NAMED)
        if (renterLc.includes(n.match) && !ownedAllLc.includes(n.match))
          unfulfillable.push(n.label);
    }
    const unfulfillableUniq = [...new Set(unfulfillable)];

    // Phase 5: a gentle, money-saving bundle suggestion — ONLY early-funnel
    // (never while negotiating/confirmed, where it would read as pushy). Matched
    // by trigger keywords / use-cases against the conversation + requested items.
    let bundle_suggestion: { name: string; price: string | null; note: string | null } | null =
      null;
    if (conversation_stage === "INQUIRY" || conversation_stage === "INTERESTED") {
      const text = `${renterMsgs.join(" ")} ${richItems.map((i) => i.name).join(" ")}`.toLowerCase();
      const bundles = await ctx.db.query("bundles").collect();
      const match = bundles
        .filter(
          (b) =>
            !b.account_scope ||
            b.account_scope === "both" ||
            b.account_scope === slug,
        )
        .find(
          (b) =>
            (b.trigger_keywords ?? []).some((k) => k && text.includes(k.toLowerCase())) ||
            (b.use_cases ?? []).some((u) => u && text.includes(u.toLowerCase())),
        );
      if (match) {
        const price =
          match.daily_price_min != null
            ? `£${match.daily_price_min}${match.daily_price_max && match.daily_price_max !== match.daily_price_min ? `–${match.daily_price_max}` : ""}/day`
            : null;
        bundle_suggestion = {
          name: match.bundle_name,
          price,
          note: match.savings_note ?? null,
        };
      }
    }

    // PLAYBOOK — the relevant DANIEL RULES / edge protocols / gear FAQs /
    // templates + delivery framework, retrieved from the `memories` corpus by
    // the renter's latest messages + intent + stage. The live draft never read
    // these before (only the 37-row `rules`); this is the #1 v1→v2 gap. FACTS
    // still come from the FactPack — this is behaviour + policy + gear knowledge.
    let playbook: {
      rules: string[];
      faqs: string[];
      templates: Array<{ title: string; content: string }>;
      frameworks: string[];
      intents: string[];
    } = { rules: [], faqs: [], templates: [], frameworks: [], intents: [] };
    try {
      const mems = await ctx.db.query("memories").collect();
      const renterText = renterMsgs.slice(-4).join("  ");
      playbook = selectPlaybook({
        memories: mems as unknown as MemoryRow[],
        renterText,
        stage: conversation_stage,
        account: slug,
        itemNames: richItems.map((i) => i.name),
      });
    } catch {
      /* best-effort — the draft still works without the playbook */
    }

    // LEARNED LESSONS — the corrections distilled from the operator's own edits
    // (draft_lessons), scored for THIS turn. Injected so the draft improves toward
    // how the owner actually writes, until the drafts are good enough to use.
    let learned_lessons: string[] = [];
    try {
      const rows = await ctx.db.query("draft_lessons").collect();
      const relevant = rows.filter((l) => l.account_slug == null || l.account_slug === slug);
      learned_lessons = selectLessons({
        lessons: relevant as unknown as LessonRow[],
        renterText: renterMsgs.slice(-4).join("  "),
        itemNames: richItems.map((i) => i.name),
      });
    } catch {
      /* best-effort */
    }

    return {
      account_slug: slug ?? null,
      location: computeLocation(reservation, slug, await loadHubBook(ctx)),
      renter_id: renterId ?? null,
      renter_identity_conflict:identity_conflict,
      conversation_id: conv?._id ?? null,
      draft_review: conv?.ai_draft_review ?? null,
      draft_epoch: settingsRow?.draft_epoch ?? 0,
      draft_context_key: draftContextKey(reservation, conv?.inquiry_items, simOrder),
      conversation_stage,
      renter_dna,
      prior_rentals,
      last_rental_at,
      renter_history:history,
      availability,
      fact_pack,
      owned_cameras,
      owned_inventory,
      unfulfillable: unfulfillableUniq,
      house_rules,
      hard_truths: hard_truths ?? null,
      draft_text_blocks: draft_text_blocks ?? null,
      bundle_suggestion,
      // Product ids in play — generateDraft fetches their REAL listing facts
      // (price + included kit + discount) to override the generic catalog.
      marketing_asks: marketingAsks,
      // Price/kit facts require the exact listing that the renter opened. A
      // fuzzy product recovery may help availability resolution, but a
      // similarly named single item must never price a set/bundle.
      listing_product_ids: exactListingProductIds(lineItems).slice(0, 6),
      playbook_rules: playbook.rules,
      playbook_faqs: playbook.faqs,
      playbook_templates: playbook.templates,
      playbook_frameworks: playbook.frameworks,
      playbook_intents: playbook.intents,
      learned_lessons,
      pickup_windows: pickupHours ?? null,
      pickup_privacy_sources:pickupPrivacySources(profile),
      persona_prompt: persona_prompt ?? null,
      discount_codes: discount_codes ?? null,
      business_rules: business_rules ?? null,
      delivery_policy: delivery_policy ?? null,
      response_style: response_style ?? null,
      business_hours: businessHoursText,
      // Master-settings toggle: when on, the operator wants every draft on the
      // stronger model (Sonnet), not just high-stakes ones. Wired into
      // generateDraft's model routing (was a decorative Settings toggle).
      escalate_to_sonnet: settingsRow?.escalate_to_sonnet ?? false,
      renter_name:
        renter?.display_name ?? reservation?.renter_name ?? "the renter",
      renter_rating: renter?.hygglo_rating ?? null,
      renter_review_count: renter?.hygglo_review_count ?? null,
      renter_blacklisted: renter?.blacklisted ?? renter?.blacklist ?? false,
      renter_flagged:
        (renter as { flag_on_request?: boolean } | null)?.flag_on_request ?? false,
      renter_total_rentals: renter?.platform_completed_rentals ?? null,
      low_reviews,
      has_reservation: !!reservation,
      rental_stage: rentalStage(reservation ? {...reservation,
        start_date: simOrder?.start_date ?? reservation.start_date,
        end_date: simOrder?.end_date ?? reservation.end_date,
      } : null, londonToday()),
      items: richItems.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)),
      start_date: simOrder?.start_date ?? reservation?.start_date ?? null,
      end_date: simOrder?.end_date ?? reservation?.end_date ?? null,
      return_date: reservation?.return_date ?? null,
      pickup_method: reservation?.pickup_method ?? null,
      status: reservation?.status ?? null,
      order_step: reservation?.order_step ?? null,
      // AUTHORITATIVE pending signal = Hygglo's awaiting_owner_action (the actions
      // map), NOT order_step==="REQUEST". Orders sit at order_step=APPROVED while
      // still awaiting my approve/decline — the draft was reading order_step and
      // telling renters "your booking's approved, just pay" when I hadn't approved
      // it yet (2026-06-28). Mirror the tile's isRequest exactly.
      is_request: reservation?.awaiting_owner_action ?? reservation?.order_step === "REQUEST",
      awaiting_owner_action: reservation?.awaiting_owner_action ?? false,
      gross_paid_gbp: reservation?.gross_paid_gbp ?? null,
      net_to_owner_gbp: reservation?.net_to_owner_gbp ?? null,
      delivery_fee_gbp: reservation?.delivery_fee_gbp ?? null,
      currency: reservation?.currency ?? "GBP",
      messages: recent,
      renter_camera_messages: renterMsgs,
      negotiation:negotiationFromMessages(negotiationMsgs,conv?.active_rental_request),
      last_message_id: latest?.message_id ?? null,
    };
  },
});

/** Awaiting-reply threads with no cached AI draft — for the pre-gen backfill.
 *  (On-message pre-gen only covers NEW messages; this catches existing threads
 *  so a draft is ready before you open the box.) */
export const threadsNeedingDraft = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    // MOST-RECENT renter-last threads first, so the backfill fills what the
    // owner actually sees in the queue before older/buried threads (the index
    // order is arbitrary, which left visible threads draft-less, 2026-06-28).
    const settings = await ctx.db.query("settings").first();
    const epoch = settings?.draft_epoch ?? 0;
    // 2026-07-13 cost audit: window the scan. Pre-gen exists to fill drafts for
    // QUEUE tiles, and the queue only surfaces threads active within the last
    // REPLY_MV_WITHIN_DAYS days — selecting older threads is waste by
    // construction, and it was self-sustaining: threads where generateDraft
    // skips/fails never get a draft written, so the unbounded by_last_sender
    // scan re-fed the same dead threads to the 30-min cron forever (~400+
    // wasted getThreadContext/availability runs per day, live usage data).
    const draftWindowStart = Date.now() - REPLY_MV_WITHIN_DAYS * 86_400_000;
    const convs = (
      await ctx.db
        .query("conversations")
        .withIndex("by_last_msg_at", (q) => q.gte("last_msg_at", draftWindowStart))
        .collect()
    ).filter(
      (c) => c.last_sender === "renter" && !c.thread_id.startsWith(PROBE_THREAD_PREFIX),
    );
    convs.sort(
      (a, b) =>
        (b.last_renter_msg_at ?? b.last_msg_at ?? 0) -
        (a.last_renter_msg_at ?? a.last_msg_at ?? 0),
    );
    const out: string[] = [];
    for (const c of convs) {
      const booking = await getBotBooking(ctx, c.thread_id);
      if (c.ai_draft_review) {
        const [latest] = await recentThreadMessages(ctx, c.thread_id, 1);
        if (currentDraftReview(c.ai_draft_review, { message_id: latest?.message_id, epoch,
          context_key: draftContextKey(booking, c.inquiry_items) })) continue;
      }
      // No draft, OR a draft from an older draft-logic epoch (stale).
      // No draft, OR epoch-stale, OR a NEW renter message arrived after the
      // draft was generated -> redraft with the new context. (Daniel, 2026-07-03)
      if (
        !c.ai_draft_text ||
        (c.ai_draft_epoch ?? 0) !== epoch ||
        c.ai_draft_context_key !== draftContextKey(booking, c.inquiry_items) ||
        (c.ai_draft_generated_at ?? 0) < (c.last_renter_msg_at ?? 0)
      )
        out.push(c.thread_id);
      if (out.length >= limit) break;
    }
    return out;
  },
});

// ── Draft cache write (called by generateDraft action) ────────────

/** A blocked candidate is never saved as a sendable preview. */
/** Fail closed while a managed generation is active; abandoned actions eventually expire. */
export const claimDraftGeneration = internalMutation({
  args: { thread_id: v.string(), token: v.string() },
  handler: async (ctx, { thread_id, token }) => {
    const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", thread_id)).first();
    if (!conv) return { ok: false as const, reason: "missing_thread" };
    if (conv.ai_draft_generation_token && (conv.ai_draft_generation_until ?? 0) > Date.now())
      return { ok: false as const, reason: "generation_in_progress" };
    await ctx.db.patch(conv._id, { ai_draft_generation_token: token, ai_draft_generation_until: Date.now() + 15 * 60_000 });
    return { ok: true as const };
  },
});

export const releaseDraftGeneration = internalMutation({
  args: { thread_id: v.string(), token: v.string() },
  handler: async (ctx, { thread_id, token }) => {
    const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", thread_id)).first();
    if (!conv || conv.ai_draft_generation_token !== token) return { ok: false as const };
    await ctx.db.patch(conv._id, { ai_draft_generation_token: undefined, ai_draft_generation_until: undefined });
    return { ok: true as const };
  },
});

export const setDraftReview = internalMutation({
  args: { thread_id: v.string(), message_id: v.string(), epoch: v.number(), context_key: v.string(),
    reason: v.string(), flags: v.array(reviewFlagValidator), stage: v.string(), evidence: v.optional(draftEvidenceValidator), owner_checks:v.optional(v.array(ownerCheckValidator)) },
  handler: async (ctx, { thread_id, message_id, epoch, context_key, reason, flags, stage, evidence, owner_checks }) => {
    const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", thread_id)).first();
    if (!conv) return { ok: false as const, reason: "missing_thread" };
    const [latest] = await recentThreadMessages(ctx, thread_id, 1);
    const settings = await ctx.db.query("settings").first();
    const booking = await getBotBooking(ctx, thread_id);
    const labOrder = await getLabOrder(ctx, thread_id);
    if (latest?.message_id !== message_id || (settings?.draft_epoch ?? 0) !== epoch
      || draftContextKey(booking, conv.inquiry_items, labOrder) !== context_key) return { ok: false as const, reason: "stale_inbound" };
    await persistOwnerChecks(ctx,{thread_id,message_id,epoch,context_key,checks:owner_checks ?? []});
    const review = { for_message_id: message_id, epoch, context_key, reason, flags, stage, evidence, created_at: Date.now() };
    await ctx.db.patch(conv._id, { ai_draft_review: review, ai_draft_text: undefined,
      ai_draft_for_message_id: undefined, ai_draft_generated_at: undefined, ai_draft_epoch: undefined,
      ai_draft_context_key: undefined,
      ai_draft_confidence: undefined, ai_draft_flags: undefined, ai_draft_evidence: undefined });
    return { ok: true as const, review };
  },
});

export const setDraft = internalMutation({
  args: {
    thread_id: v.string(),
    draft_text: v.string(),
    owner_checks: v.optional(v.array(ownerCheckValidator)),
    message_id: v.optional(v.string()),
    epoch: v.optional(v.number()),
    context_key: v.optional(v.string()),
    conversation_stage: v.optional(conversationStageValidator),
    confidence: v.optional(v.number()),
    evidence: v.optional(draftEvidenceValidator),
    flags: v.optional(
      v.array(
        v.object({
          type: v.string(),
          detail: v.string(),
          severity: v.union(
            v.literal("critical"),
            v.literal("high"),
            v.literal("medium"),
            v.literal("low"),
          ),
          action: v.union(
            v.literal("stripped"),
            v.literal("rewritten"),
            v.literal("flagged"),
          ),
        }),
      ),
    ),
  },
  handler: async (
    ctx,
    { thread_id, draft_text, message_id, epoch, context_key, conversation_stage, confidence, flags, evidence, owner_checks },
  ) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    if (!conv) return { ok: false };
    if (message_id) {
      const [latest] = await recentThreadMessages(ctx, thread_id, 1);
      if (latest?.message_id !== message_id) return { ok: false, reason: "stale_inbound" };
    }
    const settings = await ctx.db.query("settings").first();
    if (epoch !== undefined && epoch !== (settings?.draft_epoch ?? 0)) return { ok: false, reason: "stale_context" };
    const booking=await getBotBooking(ctx,thread_id);
    const currentContext = draftContextKey(booking, conv.inquiry_items, await getLabOrder(ctx, thread_id));
    if (context_key !== undefined && context_key !== currentContext) {
      return { ok: false, reason: "stale_context" };
    }
    if (owner_checks?.length) {
      if (!message_id || epoch === undefined || !context_key) throw new Error("Owner checks require a scoped draft");
      await persistOwnerChecks(ctx,{thread_id,message_id,epoch,context_key,checks:owner_checks});
    }
    const patch: Record<string, unknown> = {
      ai_draft_text: draft_text,
      ai_draft_review: undefined,
      ai_draft_for_message_id: message_id,
      ai_draft_generated_at: Date.now(),
      ai_draft_epoch: settings?.draft_epoch ?? 0,
      ai_draft_context_key: currentContext,
      ai_draft_confidence: confidence,
      ai_draft_flags: flags,
      ai_draft_evidence: evidence,
    };
    const stage=booking?rentalStage(booking,londonToday()).stage:conversation_stage;
    if (stage && stage !== conv.conversation_stage) {
      patch.conversation_stage = stage;
      patch.stage_updated_at = Date.now();
    }
    await ctx.db.patch(conv._id, patch);
    return { ok: true };
  },
});

// ── Renter intelligence persistence (Phase 3) ────────────────────

/** Tone learning never writes platform or business-history statistics.
 * Resolve the person and transcript in the current Native snapshot. */
export const persistRenterDNA = internalMutation({
 args:{thread_id:v.string(),message_id:v.string(),epoch:v.number(),context_key:v.string(),renter_id:v.optional(v.id("renters"))},
 handler:async(ctx,a)=>{
  if(a.thread_id.startsWith(PROBE_THREAD_PREFIX))return {ok:true,skipped:"lab_isolated"};
  const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",a.thread_id)).first();
  const booking=await getBotBooking(ctx,a.thread_id);
  const messages=await recentThreadMessages(ctx,a.thread_id,40);
  const settings=await ctx.db.query("settings").first();
  if(!conv||messages.at(-1)?.message_id!==a.message_id||(settings?.draft_epoch??0)!==a.epoch||draftContextKey(booking,conv.inquiry_items)!==a.context_key)
   return {ok:false,reason:"stale_context"};
  const identity=await resolveBotRenter(ctx,booking,conv);
  if(identity.identity_conflict||!identity.renter||identity.renter._id!==a.renter_id)return {ok:false,reason:"renter_identity_changed"};
  const text=messages.filter(m=>m.sender!=="owner").map(m=>m.body_text);
  if(!text.length)return {ok:true,skipped:"no_renter_messages"};
  const renter_dna=profileRenter(text,identity.renter.renter_dna);
  await ctx.db.patch(identity.renter._id,{renter_dna:{...renter_dna,updated_at:Date.now()}});
  return {ok:true};
 }
});

// ── Post-send bookkeeping (called by sendRenterReply action) ──────

/**
 * After a reply is accepted by Hygglo, persist an optimistic owner message and
 * flip the conversation owner-last. The next poll replaces this synthetic row
 * with Hygglo's authoritative message (matched by thread/body/time), so chat is
 * reactive immediately without duplicates or client-only state.
 */
export const recordSentReply = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.optional(v.string()),
    text: v.string(),
    message_id: v.string(),
  },
  handler: async (ctx, { thread_id, account_slug, text, message_id }) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    const now = Date.now();
    const existingMessage = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread_and_message", (q) =>
        q.eq("thread_id", thread_id).eq("message_id", message_id),
      )
      .first();
    if (!existingMessage) {
      const proposals = !account_slug || account_slug === conv?.account_slug ? await sentBookingProposals(ctx, conv, text) : {additions:[],dates:[],replacements:[],inquiries:[]};
      const rental_request=!account_slug||account_slug===conv?.account_slug?await recordSentRentalRequest(ctx,conv,text):undefined;
      const quoted_inquiries=proposals.inquiries,quoted_additions=proposals.additions,quoted_dates=proposals.dates,quoted_replacements=proposals.replacements;
      await ctx.db.insert("hygglo_messages", {
        account_slug: account_slug ?? conv?.account_slug ?? "unknown",
        thread_id,
        message_id,
        sender: "owner",
        sender_name: "You",
        body_text: text,
        hygglo_sent_at: now,
        fetched_at: now,
        raw: "manual_send_optimistic",
        ...(rental_request?{rental_request}:{}),
        ...(quoted_inquiries.length ? {quoted_inquiries} : {}), ...(quoted_additions.length ? {quoted_additions} : {}), ...(quoted_dates.length ? {quoted_dates} : {}), ...(quoted_replacements.length ? {quoted_replacements} : {}),
      });
    }
    if (conv) {
      await ctx.db.patch(conv._id, {
        last_sender: "owner",
        last_msg_at: now,
        ai_draft_text: undefined,
        ai_draft_for_message_id: undefined,
        ai_draft_generated_at: undefined,
      });
    } else {
      // Defensive: thread with no conversation row yet — create one owner-last.
      await ctx.db.insert("conversations", {
        thread_id,
        account_slug,
        last_msg_at: now,
        last_sender: "owner",
        created_at: now,
      });
    }

    const reservation = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .first();
    if (reservation && !reservation.is_obsolete && reservation.start_date && reservation.end_date) {
      await ctx.scheduler.runAfter(0, internal.extract_booking_times.__service_extractForReservation, {
        reservation_id: reservation._id,
      });
    }
    await ctx.scheduler.runAfter(0, internal.mv.reply_queue.refresh, { force: true });
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
    // Approve/decline change the tile's action buttons (accept→decline-only, or
    // none) — reflect it in the cached reply queue instantly rather than waiting
    // for the next poller cycle to re-trip the cron's clean-check.
    await ctx.scheduler.runAfter(0, internal.mv.reply_queue.refresh, {
      force: true,
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


// ── Imminent handoffs (Quick Reply pinned bar) ───────────────────────────────
// Reservations whose PICKUP or RETURN is within ±windowMin of NOW (London wall-
// clock). Powers the pinned top bar in the Quick Reply widget so the renter's
// chat is one tap away right at the handover. (Daniel 2026-07-07)
export const getImminentHandoffs = query({
  args: { accountSlug: v.optional(v.string()), windowMin: v.optional(v.number()), _tick: v.optional(v.number()) },
  handler: async (ctx, { accountSlug, windowMin = 60 }) => {
    const nowDate = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const nowHM = new Date().toLocaleString("en-GB", {
      timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit",
    });
    const candidates: ImminentHandoffCandidate[] = [];
    // 2026-07-13 cost audit: MV fast path. This query polls every 60s per tab
    // (`_tick`) and each execution collected the whole confirmed set (~200KB,
    // ~226MB/day) to derive TODAY's timed handovers. The candidates (dated +
    // timed rows, no window math) are cached in mv_widgets key "handoffs" by
    // the 5-min reply-queue cron; minutes_away/windowMin are computed here at
    // read time from a ~2KB row. Date-mismatch or stale row → live fallback.
    const cachedHandoffs = (await readWidgetMv(ctx, "handoffs", 45 * 60 * 1000)) as
      | { date?: string; candidates?: ImminentHandoffCandidate[] }
      | null;
    if (cachedHandoffs?.date === nowDate && Array.isArray(cachedHandoffs.candidates)) {
      return filterImminentHandoffs(
        cachedHandoffs.candidates, nowDate, nowHM, windowMin, accountSlug,
      );
    }
    for (const st of ["confirmed", "ongoing"]) {
      const rows = await ctx.db
        .query("reservations")
        .withIndex("by_status", (qq) => qq.eq("status", st))
        .collect();
      for (const r of rows) {
        const a = r as Record<string, unknown>;
        if (a.is_obsolete) continue;
        const items = ((a.hygglo_items as Array<{ name: string }> | undefined) ?? [])
          .map((h) => h.name).slice(0, 2);
        const base = {
          thread_id: (a.hygglo_order_id as string) ?? null,
          account_slug: (a.account_slug as string) ?? null,
          renter_name: (a.renter_name as string) ?? "renter",
          items,
        };
        const pd = (a.pickup_date as string) ?? (a.start_date as string);
        const pt = a.pickup_time as string | undefined;
        if (pd && pt) candidates.push({ ...base, kind: "pickup", date: pd, time: pt });
        const rd = (a.return_date as string) ?? (a.end_date as string);
        const rt = a.return_time as string | undefined;
        if (rd && rt) candidates.push({ ...base, kind: "return", date: rd, time: rt });
      }
    }
    return filterImminentHandoffs(candidates, nowDate, nowHM, windowMin, accountSlug);
  },
});

/** Lightweight final check for owner approval; no catalogue/LLM/provider calls. */
export const getDraftApprovalContext = query({
  args: { thread_id: v.string() },
  handler: async (ctx, { thread_id }) => {
    const conv = await ctx.db.query("conversations").withIndex("by_thread", q => q.eq("thread_id", thread_id)).first();
    const [latest] = await recentThreadMessages(ctx, thread_id, 1);
    const settings = await ctx.db.query("settings").first();
    const booking = await getBotBooking(ctx, thread_id);
    const scope = {
      message_id: latest?.message_id,
      epoch: settings?.draft_epoch ?? 0,
      context_key: draftContextKey(booking, conv?.inquiry_items, await getLabOrder(ctx, thread_id)),
    };
    return {
      account_slug: conv?.account_slug ?? booking?.account_slug ?? null,
      stored_draft_text: conv?.ai_draft_text ?? null,
      draft_approval: currentDraftApproval(conv, scope),
    };
  },
});

/** Recheck the copied text and approval in one database snapshot. Old model
 * receipts identify what to check; current Native stock and reviewed specifications
 * must still qualify copied recommendations. */
export const recheckCopiedDraftStock = internalQuery({
  args: {thread_id:v.string(),account_slug:v.string(),text:v.string(),
    draft_approval:v.object({message_id:v.string(),context_key:v.string(),epoch:v.number(),generated_at:v.number()})},
  handler: async (ctx,{thread_id,account_slug,text,draft_approval}) => {
    const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",thread_id)).first();
    const cameraMessages = await recentThreadMessages(ctx,thread_id,40);
    const latest = cameraMessages.at(-1);
    const settings=await ctx.db.query("settings").first();
    const booking=await getBotBooking(ctx,thread_id);
    const labOrder=await getLabOrder(ctx,thread_id);
    const current=currentDraftApproval(conv,{message_id:latest?.message_id,epoch:settings?.draft_epoch??0,
      context_key:draftContextKey(booking,conv?.inquiry_items,labOrder)});
    if ((conv?.account_slug??booking?.account_slug)!==account_slug || !sameDraftApproval(current,draft_approval))
      return {ok:false,reason:"stale_draft"};
    const currentStage=rentalStage(booking,londonToday());
    let evidence=conv?.ai_draft_evidence;
    const selection=inquiryOffersForText(evidence,conv?.ai_draft_text,text);
    if(selection.supported){
      if(!selection.ok)return {ok:false,reason:"native_quote_text_unverified"};
      const keys=new Set(selection.quotes.map(q=>q.quote_key));
      evidence={...evidence!,stock_quotes:selection.quotes,recommendation_quotes:evidence?.recommendation_quotes?.filter(q=>keys.has(q.quote_key))};
    }
    const values=nativeInformationForText(evidence,conv?.ai_draft_text,text);
    if(!values.ok)return {ok:false,reason:"replacement_value_text_unverified"};
    for(const comparison of values.comparisons)for(const proof of [comparison.original,comparison.alternative]){
      const id=ctx.db.normalizeId("items",proof.item_id),item=id?await ctx.db.get(id):null;
      if(!item||item.status!=="active"||item.is_marketing_only||item.qty<=0||item.name_canonical!==proof.name||item.replacement_cost_gbp!==proof.value_gbp)
        return {ok:false,reason:"replacement_value_unverified"};
    }
    if(values.budget_checks.length){
      const [listings,index,overrides,items]=await Promise.all([
        ctx.db.query("online_listings").withIndex("by_account",q=>q.eq("account_slug",account_slug)).collect(),
        ctx.db.query("hygglo_product_index").collect(),ctx.db.query("listing_resolution_override").collect(),ctx.db.query("items").collect(),
      ]);
      for(const check of values.budget_checks){
        const reader=ownedItemHirePriceReader(ctx,account_slug,listings,index,overrides,items,inclusiveRentalDays(check.start_date,check.end_date),check.quantity);
        for(const proof of check.prices){
          const item=items.find(i=>String(i._id)===proof.item_id);
          if(!item||item.status!=="active"||item.is_marketing_only||item.qty<=0||item.name_canonical!==proof.name)return {ok:false,reason:"budget_price_unverified"};
          const current=await reader.price(item);
          if(current.altPid!==proof.product_id||current.quote?.listed_total_gbp!==proof.total_gbp)return {ok:false,reason:"budget_price_unverified"};
        }
      }
    }
    const financialClaimText=values.claim_text;
    if(evidence?.rental_request){
      try{await validateRentalRequest(ctx,thread_id,evidence.rental_request,latest?.sender==="renter"?latest.message_id:undefined);}
      catch{return {ok:false,reason:"rental_request_unverified"};}
      if(evidence.stock_quotes?.some(q=>q.rental_request&&!sameRentalRequest(q.rental_request,evidence.rental_request!)))return {ok:false,reason:"rental_request_unverified"};
    }
    const newInquiry=evidence?.rental_request?.kind==="inquiry"||evidence?.stock_quotes?.some(q=>q.new_inquiry)||evidence?.stock.some(r=>r.new_inquiry);
    if(unsupportedRenterCameraClaims(text,cameraMessages.filter(message=>message.sender!=="owner").map(message=>message.body_text)).length)
      return {ok:false,reason:"renter_camera_identity_unverified"};
    const permissions=currentStage;
    if(unsupportedBookingDateClaims(text,currentStage.booking_dates,newInquiry).length || !permissions.can_confirm_booking && claimsBookingConfirmation(text) ||
      (newInquiry||!permissions.can_acknowledge_owner_acceptance) && claimsCurrentOwnerApproval(text))return {ok:false,reason:"booking_state_unverified"};
    if(newInquiry||!currentStage.can_share_pickup_address) {
      const accountId=booking?.account_id??conv?.account_id??(await ctx.db.query("accounts").withIndex("by_slug",q=>q.eq("slug",account_slug)).first())?._id;
      const profile=accountId?await ctx.db.query("account_profiles").withIndex("by_account",q=>q.eq("account_id",accountId)).first():null;
      if(hasPickupDisclosure(text,pickupPrivacySources(profile)))return {ok:false,reason:"pickup_details_unverified"};
    }
    if(evidence?.booking_record) {
      const freshRecord=bookingRecord(thread_id,account_slug,currentStage.stage,booking,labOrder);
      if(!freshRecord||!hasSingleBookingRecord(text,freshRecord)||Object.keys(freshRecord).some(key=>freshRecord[key as keyof typeof freshRecord]!==evidence.booking_record![key as keyof typeof freshRecord]))
        return {ok:false,reason:"booking_record_unverified"};
    }
    const request=stockRequestForInquiryQuote(stockRequestForSeparateCheck(evidence?.stock_request??{items:[]},evidence?.stock??[]),evidence?.stock_quotes??[],rentalStage(booking,londonToday()).stage);
    const claimRequest=nativeInformationClaimRequest(request,values.budget_checks);
    if(kitClaimsNeedEvidence(text)) {
      const currentLines=requestedListingContext(booking,labOrder,conv?.inquiry_items).lines.map(l=>({...l,name:l.name??""}));
      const selectedLines=(evidence?.stock_quotes??[]).flatMap(q=>q.listing_quote?.lines??[]);
      const kit=await currentKitEvidence(ctx,account_slug,text,[
        ...currentLines.map(l=>({...l,booked:true})),...selectedLines,
      ]);
      if(unsupportedKitClaims(text,kit,request.items.map(i=>i.name),currentLines.map(l=>l.name)).length)
        return {ok:false,reason:"kit_contents_unverified"};
    }
    // Human wording edits cannot borrow technical facts from a previous draft.
    // Reuse the generation validators with current exact catalogue reviews.
    const currentSpecs=new Map<string,Promise<Doc<"item_specs">[]>>();
    if(equipmentClaimsNeedProfiles(text)) {
      const [items,specs]=await Promise.all([ctx.db.query("items").collect(),ctx.db.query("item_specs").collect()]);
      const byItem=new Map<string,Doc<"item_specs">[]>();
      for(const spec of specs){const key=String(spec.item_id);byItem.set(key,[...(byItem.get(key)??[]),spec]);}
      for(const item of items)currentSpecs.set(String(item._id),Promise.resolve(byItem.get(String(item._id))??[]));
      const profiles=equipmentClaimProfiles(items,specs),initial=stockRequestForInquiryQuote(request,evidence?.stock_quotes??[]).items.map(i=>i.name);
      if(unsupportedCameraModeClaims(text,profiles.cameras).length || unsupportedBuiltInNDClaims(text,profiles.cameras,initial).length ||
        unsupportedLensFocusClaims(text,profiles.lenses,initial,profiles.cameras.flatMap(e=>e.names)).length)return {ok:false,reason:"technical_claims_unverified"};
    }
    // A copied reply's edited amounts must still belong to its Native proof.
    // Selected inquiry offers use fresh receipts only; an unselected pricing
    // lookup cannot authorize a different amount in the outgoing reply.
    const prices:PriceEvidence[]=evidence?.stock_quotes?.length?[]:evidence?.prices??[];
    const inbound=latest?.sender!=="owner"?latest?.body_text??"":"";
    if(!evidence?.stock_request && !evidence?.recommendation_quotes?.length && !evidence?.stock_quotes?.length) {
      if(unsupportedPriceClaims(financialClaimText,prices,request,inbound,evidence?.booking_record).length)return {ok:false,reason:"price_unverified"};
      return unsupportedStockClaims(financialClaimText,[],claimRequest).length?{ok:false,reason:"stock_unverified"}:{ok:true};
    }
    const sources=await loadStockSources(ctx);
    // Selected Native offers are commitments to a particular physical basket,
    // even when the rendered reply mentions only its price. Recheck each offer
    // independently; separate alternatives must not consume each other's units.
    for(const quote of evidence?.stock_quotes??[]) {
      if(!quote.items.length || new Set(quote.items.map(i=>i.item_id)).size!==quote.items.length ||
        !/^\d{4}-\d{2}-\d{2}$/.test(quote.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(quote.end_date) || quote.start_date>quote.end_date)
        return {ok:false,reason:"stock_unverified"};
      for(const line of quote.items) {
        const item=sources.items.find(i=>String(i._id)===line.item_id);
        if(!item || item.name_canonical!==line.name || item.status!=="active" || item.is_marketing_only ||
          !Number.isInteger(line.quantity) || line.quantity<1 ||
          stockForRentalItem(sources,item,{item_name:line.name,start_date:quote.start_date,end_date:quote.end_date,quantity:line.quantity,thread_id:quote.new_inquiry?"":thread_id}).available!==true)
          return {ok:false,reason:"stock_unverified"};
      }
      const priced=quote.listing_quote;
      if(!priced || !Number.isFinite(priced.total_gbp) || priced.total_gbp<=0 || !priced.lines.length || priced.lines.length>8 ||
        new Set(priced.lines.map(l=>l.product_id)).size!==priced.lines.length || priced.lines.some(l=>!Number.isInteger(l.product_id)||l.product_id<1||
          !Number.isInteger(l.quantity)||l.quantity<1||l.quantity>20||!Number.isFinite(l.total_gbp)||l.total_gbp<=0))
        return {ok:false,reason:"price_unverified"};
      // Reuse the same Native stock/price/listing resolution as the original
      // offer. Physical IDs alone cannot establish the price of a listing.
      const fresh=await performJointStockCheck(ctx,{account_slug,thread_id,start_date:quote.start_date,end_date:quote.end_date,booking_use:"standalone",
        items:priced.lines.map(l=>({product_id:l.product_id,item_name:l.name,quantity:l.quantity}))},sources,{standalone_offer:true,new_inquiry:quote.new_inquiry});
      const identity=JSON.stringify(quote.items.map(l=>[l.item_id,l.name,l.quantity]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
      if(fresh.available!==true || !("physical_identity_key" in fresh) || fresh.physical_identity_key!==identity)
        return {ok:false,reason:"stock_unverified"};
      const current="quote" in fresh?fresh.quote:null;
      const cents=(n:number)=>Math.round(n*100);
      if(!current || current.total_gbp==null || current.unpriced.length || current.lines.length!==priced.lines.length ||
        cents(current.total_gbp)!==cents(priced.total_gbp) || priced.lines.some(l=>!current.lines.some(c=>c.product_id===l.product_id && c.qty===l.quantity &&
          c.line_total_gbp!=null && cents(c.line_total_gbp)===cents(l.total_gbp))))
        return {ok:false,reason:"price_unverified"};
      prices.push(...renterPriceEvidence([{tool:"check_basket_availability",call_id:`send-quote:${quote.quote_key}`,result:fresh}],[],thread_id));
    }
    if(unsupportedPriceClaims(financialClaimText,prices,request,inbound,evidence?.booking_record).length)return {ok:false,reason:"price_unverified"};
    // A copied recommendation must still qualify even when its prose says
    // only "this setup". Reuse the initial Native criteria and physical IDs;
    // an old model claim or old review is never current technical proof.
    for(const quote of evidence?.recommendation_quotes??[]) {
      if(!quote.items.length || new Set(quote.items.map(i=>i.item_id)).size!==quote.items.length)
        return {ok:false,reason:"technical_requirements_unverified"};
      const physical=quote.items.map(line=>({line,item:sources.items.find(i=>String(i._id)===line.item_id)}));
      if(physical.some(({line,item})=>!item || item.name_canonical!==line.name || item.status!=="active" || item.is_marketing_only ||
        !Number.isInteger(line.quantity) || line.quantity<1 || item.qty<line.quantity))return {ok:false,reason:"technical_requirements_unverified"};
      const items=await Promise.all(physical.map(async ({line,item})=>{
        let read=currentSpecs.get(line.item_id);
        if(!read){read=["camera","camera_body","lens"].includes(item!.kind??"")?ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item!._id)).collect():Promise.resolve([]);currentSpecs.set(line.item_id,read);}
        const specs=await read;
        return {item_id:line.item_id,name:item!.name_canonical,quantity:line.quantity,kind:item!.kind??"",native_mount:item!.lens_mount,spec:specs.length===1?specs[0]:null};
      }));
      if(qualifyRecommendationBasket(quote.requirements,items).verified!==true)return {ok:false,reason:"technical_requirements_unverified"};
    }
    // Missing legacy scope cannot qualify a stock assertion, but a human's
    // edited reply with no such assertion does not need old stock receipts.
    if (!evidence?.stock_request) return unsupportedStockClaims(financialClaimText,[],claimRequest).length?{ok:false,reason:"stock_unverified"}:{ok:true};
    const receipts:StockReceipt[]=[];
    const checked=new Set<string>();
    for(const old of evidence.stock) {
      // Recompute every aggregate physical unit in a saved joint proof using
      // this same current Native snapshot; never carry its old verdict forward.
      const basket=old.basket ? {
        items:old.basket.items,
        available:old.basket.items.length>0 && old.basket.items.every(line=>{
          const resolved=resolveStockItem(line.name,sources.items);
          return Number.isInteger(line.quantity) && line.quantity>0 && resolved.confident && !!resolved.match
            && stockForRentalItem(sources,resolved.match,{item_name:line.name,start_date:old.start_date,end_date:old.end_date,quantity:line.quantity,thread_id:old.new_inquiry?"":thread_id}).available===true;
        }),
      } : undefined;
      const key=JSON.stringify([old.item,old.start_date,old.end_date,old.quantity,basket?.items,old.new_inquiry]);
      if(checked.has(key))continue;
      checked.add(key);
      const item=resolveStockItem(old.item,sources.items);
      if(!item.confident||!item.match)continue;
      const fresh=stockForRentalItem(sources,item.match,{item_name:old.item,start_date:old.start_date,end_date:old.end_date,quantity:old.quantity,thread_id:old.new_inquiry?"":thread_id});
      let identity_names:string[]|undefined;
      if(["camera","camera_body","lens"].includes(item.match.kind??"")) {
        const id=String(item.match._id);
        let read=currentSpecs.get(id);
        if(!read){read=ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item.match!._id)).collect();currentSpecs.set(id,read);}
        const profiles=equipmentClaimProfiles([item.match],await read);
        identity_names=profiles.lenses[0]?.names??profiles.cameras[0]?.names;
      }
      receipts.push({item:old.item,start_date:old.start_date,end_date:old.end_date,quantity:old.quantity,identity_names,
        available:fresh.available,free_units:fresh.free_units,checked_at:fresh.checked_at,kind:item.match.kind,owned:fresh.owned,basket,call_id:`send-recheck:${receipts.length}`});
    }
    const excluded=(evidence.rental_eligibility?.ineligible_items??[]).filter(name=>{
      const item=resolveStockItem(name,sources.items);
      return item.confident&&!!item.match&&(item.match.is_marketing_only===true||item.match.status!=="active"||item.match.qty<=0);
    });
    return unsupportedStockClaims(financialClaimText,receipts,claimRequest,excluded,latest?.sender!=="owner" ? latest?.body_text ?? "" : "").length?
      {ok:false,reason:"stock_unverified",checked_at:Date.now()}:{ok:true,checked_at:Date.now()};
  },
});

// Privileged caller counterpart; shares the original handler and validators.
export const __service_getReplyQueue = internalQueryOf(getReplyQueue);

// Privileged caller counterpart; shares the original handler and validators.
export const __service_getDraftApprovalContext = internalQueryOf(getDraftApprovalContext);
