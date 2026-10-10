"use client";
import type {CSSProperties} from "react";
import { OwnerChecksPanel } from "./OwnerChecksPanel";
import { shortListingTitle, shortItemName } from "../../../convex/lib/item_display_name";
import { draftReviewSummary, sameDraftApproval, type DraftApproval, type DraftReview } from "../../../convex/lib/draft_review";
import { inclusiveRentalDays } from "../../../convex/lib/hygglo_pricing";
/**
 * Reply Inbox (2026-06-22 v3) — cross-account "renters waiting on me".
 *
 * Reference-matched split inbox: each card = item thumbnail + renter ★ + account + booking/
 * request context, with a large "unanswered for" timer. Urgency: calm < 20h →
 * amber ≥ 20h → red ≥ 30h → blinking red ≥ 48h. Pending rental REQUESTs always
 * surface with Approve / Decline (live, verified `accept`/`deny` verbs, gated by
 * ALLOW_MANUAL_ORDER_ACTIONS). Click a card → a body-portaled modal (escapes the
 * widget's clipping) with the full thread + AI draft + Send.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import type { DraftEvidence } from "../../../convex/lib/renter_draft_evidence";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { accountAccent, accountLabel } from "@/lib/account-theme";
import { Card } from "@/components/ui/Card";
import styles from "./ReplyInbox.module.css";
import {ProfilePortrait} from "./ProfilePortrait";
import {compareQuickReplies, type QuickReplySort} from "../../../convex/lib/quick_reply_sort";
import {reviewTimeLabel} from "../../../convex/lib/review_time";
import { RentalControls, type RentalControlTab } from "./RentalControls";
import { quickReplyStage, quickReplyDuplicateIds } from "../../../convex/lib/quick_reply_presentation";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

const dbCinemaInboxRef = makeFunctionReference<"action">("dbcinema_chat:inbox");
const dbCinemaThreadRef = makeFunctionReference<"action">("dbcinema_chat:thread");
const dbCinemaSendRef = makeFunctionReference<"action">("dbcinema_chat:sendOwnerReply");
const dbCinemaDraftRef = makeFunctionReference<"action">("dbcinema_chat:draftReply");
const dbCinemaReviewsRef = makeFunctionReference<"action">("dbcinema_chat:renterReviews");

// canned_responses is a NEW convex module not yet in the committed _generated/api
// type map (only existing modules are picked up via `typeof import`), so the
// typed `api.canned_responses.*` breaks `next build`. Reference by name — same
// pattern the dashboard chat tools + the dbcinema_web sync use.
const cannedListRef = makeFunctionReference<"query">("canned_responses:list");
const cannedCreateRef = makeFunctionReference<"mutation">("canned_responses:create");
const cannedUpdateRef = makeFunctionReference<"mutation">("canned_responses:update");
const cannedRemoveRef = makeFunctionReference<"mutation">("canned_responses:remove");
// renter_reviews is a new module → reference by name (api.renter_reviews.* would
// break next build until _generated catches up).
const reviewsGetRef = makeFunctionReference<"query">("renter_reviews:getForThread");
// locations is a new convex module — reference by name so `next build`'s
// typecheck stays green against the committed (lagging) _generated api.
const dismissThreadRef = makeFunctionReference<"mutation">("replyInbox:dismissThread");
const resolveLocRef = makeFunctionReference<"action">("locations:resolveForThread");
const resolveTrustRef = makeFunctionReference<"action">("renter_trust:resolveForThread");
// Star-click refresh uses the renter-trust resolver (renter-side reviews from
// the order detail) — NOT the old owner-side product-reviews source.
const reviewsRefreshRef = makeFunctionReference<"action">("renter_trust:resolveForThread");
type RenterReview = { id: string; rating: number | null; text: string | null; author: string | null; created_at: string | null };
type RenterReviewsResult = { reviews: RenterReview[]; lowCount: number; fetched: boolean; unavailable?: boolean };

// Order-edit + online-listings (new convex modules) — referenced by name so
// `next build`'s typecheck stays green against the committed (lagging) _generated
// api, same pattern as canned_responses / renter_reviews above.
const getOrderStateRef = makeFunctionReference<"action">("order_edit:getOrderState");
const previewPriceRef = makeFunctionReference<"action">("order_edit:previewPrice");
const itemUnavailRef = makeFunctionReference<"action">("order_edit:itemUnavailableDates");
const addItemRef = makeFunctionReference<"action">("order_edit:addItem");
const removeOrderItemRef = makeFunctionReference<"action">("order_edit:removeItem");
const setPriceRef = makeFunctionReference<"action">("order_edit:setPrice");
const refundRef = makeFunctionReference<"action">("order_edit:refund");
const setDatesRef = makeFunctionReference<"action">("order_edit:setDates");
const onlineListingsRef = makeFunctionReference<"query">("online_listings:list");

type OrderEditState = {
  ok: boolean;
  order_id: string;
  renter_name: string | null;
  currency: string;
  dates: { start: string | null; end: string | null };
  price: { order_price: number | null; total: number | null; earnings: number | null };
  items: Array<{
    item_id: number | null;
    product_id: number | null;
    name: string;
    image: string | null;
    thumb: string | null;
    can_remove: boolean;
    price_label: string | null;
  }>;
  actions: {
    add_product: boolean;
    remove_item: boolean;
    change_price: boolean;
    change_dates: boolean;
    select_dates: boolean;
    partial_refund: boolean;
  };
  step: string | null;
  error?: string;
};
type OnlineListing = {
  display_name?: string;
  product_id: number;
  name: string;
  image: string | null;
  daily_price: number | null;
  is_published: boolean;
  public_url: string | null;
};
type WriteOut = { status: "sent" | "skipped" | "failed"; reason?: string; httpStatus?: number; error?: string };

interface RichItem {
  display_name?: string;
  name: string;
  qty: number;
  image_url: string | null;
}
interface ItemAvail {
  name: string;
  requested: number;
  total_units: number;
  booked: number;
  pending: number;
  free: number;
  available: boolean | null;
  reason?: string;
  item_index?: number;
}
interface TileAvailability {
  status: "available" | "conflict" | "unknown";
  include_pending: boolean;
  reason?: string;
  checked_at?: number;
  items: ItemAvail[];
}
export interface DraftFlag {
  type: string;
  detail: string;
  severity: "critical" | "high" | "medium" | "low";
  action: "stripped" | "rewritten" | "flagged";
}
export interface ReplyTileData {
  thread_id: string;
  source?: "hygglo" | "dbcinema_web";
  source_booking_id?: string;
  start_at?: number | null;
  end_at?: number | null;
  renter_image_url?: string | null;
  renter_identity?: string | null;
  verification_status?: string | null;
  paid?: boolean;
  verification_started?: boolean;
  platform_booking_confirmed?: boolean;
  account_slug: string | null;
  renter_name: string;
  renter_rating: number | null;
  renter_review_count: number | null;
  renter_rating_source?: "hygglo" | null;
  renter_blacklisted: boolean;
  renter_flagged: boolean;
  has_reservation: boolean;
  start_date: string | null;
  end_date: string | null;
  return_date: string | null;
  pickup_method: string | null;
  status: string | null;
  booking_status: string | null;
  order_step: string | null;
  is_request: boolean;
  can_decide: boolean;
  kind: "request" | "message";
  last_sender: "owner" | "renter" | null;
  can_accept: boolean | null;
  can_deny: boolean | null;
  gross_paid_gbp: number | null;
  net_to_owner_gbp: number | null;
  delivery_fee_gbp: number | null;
  estimate_gbp: number | null;
  estimate_days: number | null;
  estimate_earnings_gbp: number | null;
  availability: TileAvailability | null;
  currency: string;
  items: RichItem[];
  item_count: number;
  image_url: string | null;
  last_renter_msg_at: number;
  dismissed?: boolean;
  last_activity_at: number;
  request_created_at?: number | null;
  last_msg_at: number;
  preview: string;
  has_draft: boolean;
  ai_draft_text: string | null;
  ai_draft_confidence: number | null;
  ai_draft_flags: DraftFlag[] | null;
  ai_draft_evidence?: DraftEvidence | null;
  ai_draft_approval?: DraftApproval | null;
  ai_draft_review?: DraftReview | null;
  ai_draft_stale?: boolean;
  location: TileLocation | null;
}

export interface TileLocation {
  label: string | null;
  area: string | null;
  zip: string | null;
  street: string | null;
  public_url: string | null;
  map_url: string;
  map_embed_url?: string;
  distance_km: number | null;
  vehicle: string | null;
  too_heavy: boolean;
  out_of_range: boolean;
}

// ── helpers ───────────────────────────────────────────────────────

/** Friendly send-time for a chat bubble. Same day → "14:32"; otherwise
 *  "16 Jun, 14:32". Accepts ms-epoch or an ISO/parseable string; returns "" when
 *  there's nothing usable so the caller can skip the caption. */
function fmtMsgTime(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "";
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const day = d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day}, ${time}`;
}

/**
 * Pickup-location overlay: the listing's area as a Google Maps hyperlink (shows
 * streets + stations), distance from the hub, and a red tag when the order is
 * too heavy / out of range for that location.
 */
/** In-app map overlay — keyless Google embed (streets + stations) + external link. */
function MapOverlay({
  loc,
  onClose,
  confined,
}: {
  loc: TileLocation;
  onClose: () => void;
  /** True when rendered inside ReplyModal's own body panel (position:
   *  relative) — confines to that panel instead of the viewport, so it can't
   *  cover the modal's header/close button. False/default (e.g. from a
   *  standalone LocationBadge on a ReplyCard tile, with no modal to confine
   *  to) keeps the original full-viewport overlay. */
  confined?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const title = [loc.street, loc.zip].filter(Boolean).join(", ") || loc.label || "Location";
  return (
    <div
      className={`${confined ? "absolute z-[40] overflow-y-auto" : "fixed z-[400]"} inset-0 flex items-center justify-center bg-black/70 p-3`}
      onClick={onClose}
    >
      <div
        className={`w-full max-w-2xl rounded-2xl overflow-hidden bg-[#13151a] border border-white/10 shadow-2xl ${confined ? "max-h-full my-auto" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.07]">
          <span className="text-[13px]">📍</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-[#eef1f5] truncate">
              {loc.label ?? loc.area ?? "Location"}
            </div>
            <div className="text-[11px] text-[#8b8fa3] truncate">{title}</div>
          </div>
          <a
            href={loc.map_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] px-2 py-1 rounded-md bg-white/[0.06] text-sky-300 hover:bg-white/[0.12] shrink-0"
          >
            Open in Google Maps ↗
          </a>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[#9aa0ad] hover:text-white hover:bg-white/[0.08] text-xl leading-none"
          >
            ×
          </button>
        </div>
        {loc.map_embed_url ? (
          <iframe
            title="Pickup location map"
            src={loc.map_embed_url}
            // 60vh assumes viewport-relative sizing; confined to the modal's
            // own (shorter) body panel, that could overflow it — cap smaller.
            className={confined ? "w-full h-[36vh] border-0" : "w-full h-[60vh] border-0"}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <div className="h-40 flex items-center justify-center text-[#8b8fa3] text-sm">
            No map available
          </div>
        )}
      </div>
    </div>
  );
}

function LocationBadge({
  loc,
  compact,
  onOpenMap,
}: {
  loc: TileLocation;
  compact?: boolean;
  /** Controlled mode: when provided, a click delegates to the caller instead
   *  of managing (and rendering) its own MapOverlay. ReplyModal uses this so
   *  the map opens as an in-shell panel it owns, rather than an independent
   *  viewport overlay that could cover the modal's own header. Every other
   *  caller (e.g. a ReplyCard tile, with no modal to confine to) omits this
   *  and keeps the original self-contained behaviour. */
  onOpenMap?: () => void;
}) {
  const [showMap, setShowMap] = useState(false);
  const tag = loc.out_of_range
    ? { text: "Out of range", cls: "bg-rose-500/20 text-rose-300" }
    : loc.too_heavy
      ? { text: "Too heavy here", cls: "bg-rose-500/20 text-rose-300" }
      : null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (onOpenMap) onOpenMap();
          else setShowMap(true);
        }}
        title={`${loc.street ? loc.street + ", " : ""}${loc.zip ?? ""} — view map`}
        className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 hover:underline max-w-full"
      >
        <span>📍</span>
        <span className="truncate">{loc.label ?? loc.area ?? loc.zip ?? "Location"}</span>
      </button>
      {loc.distance_km != null && (
        <span className="text-[#7f8694]">{loc.distance_km}km</span>
      )}
      {!compact && loc.vehicle && (
        <span className="text-[#7f8694] capitalize">· {loc.vehicle}</span>
      )}
      {tag && (
        <span className={`px-1.5 py-0.5 rounded-md font-semibold ${tag.cls}`}>
          ⚠ {tag.text}
        </span>
      )}
      {!onOpenMap && showMap && <MapOverlay loc={loc} onClose={() => setShowMap(false)} />}
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  REQUEST: "Request · awaiting you",
  APPROVED: "Awaiting payment",
  FUNDS_RESERVED: "Awaiting payment",
  VERIFIED: "Verifying renter",
  BOOKED_AFTER_VERIFIED: "Confirmed",
  DELIVERED: "Out with renter",
  RETURNED: "Awaiting return",
  REVIEWED: "Complete",
  CANCELED: "Cancelled",
  VERIFICATION_FAILED: "Verification failed",
};
/**
 * Decision state from the granular owner-action flags (falling back to the
 * is_request boolean for rows not yet stamped). approved = I've accepted but can
 * still decline until the renter pays.
 */
function decideState(t: ReplyTileData): {
  canApprove: boolean;
  canDecline: boolean;
  approved: boolean;
} {
  const canApprove = t.availability?.status !== "conflict" && (t.can_accept ?? t.is_request);
  const canDecline = t.can_deny ?? t.is_request;
  return { canApprove, canDecline, approved: !canApprove && canDecline };
}
/** Lifecycle states I (the owner) have already resolved. Once a request is
 *  cancelled or declined the thread is closed — cancelling IS the answer — so it
 *  should drop out of the action lists even when the renter's message was last. */
function isResolvedClosed(t: ReplyTileData): boolean {
  const s = (t.status ?? "").toLowerCase();
  if (s === "cancelled" || s === "canceled" || s === "declined" || s === "denied") return true;
  const step = (t.order_step ?? "").toUpperCase();
  return (
    step === "CANCELED" ||
    step === "CANCELLED" ||
    step === "DENIED" ||
    step === "VERIFICATION_FAILED"
  );
}
/** True when the ball is in MY court (renter spoke last, or a pending request). */
function awaitingMe(t: ReplyTileData): boolean {
  // If I sent the last message, it's the renter's turn — never "waiting on me",
  // even for a still-open request (I've already replied / approved it).
  if (t.last_sender === "owner") return false;
  // Cancelled / declined → I already closed it; don't keep nagging me.
  if (isResolvedClosed(t)) return false;
  return t.last_sender === "renter" || t.is_request;
}
function statusText(t: ReplyTileData): string {
  if (!t.has_reservation) {
    return t.last_sender === "owner" ? "Inquiry · you replied" : "Inquiry · not requested yet";
  }
  const { canApprove, canDecline, approved } = decideState(t);
  // Decision-state labels take priority — never say "awaiting payment" for a
  // request that hasn't been approved/declined yet.
  if (canApprove && canDecline) return "New request · approve or decline";
  if (approved) return "Approved · awaiting payment";
  if (t.order_step && STEP_LABEL[t.order_step]) return STEP_LABEL[t.order_step];
  if (t.last_sender === "owner") return "You replied · awaiting renter";
  return t.status ?? "Active";
}
// ── rental lifecycle bar ──────────────────────────────────────────
// Minimal 5-stage stepper showing where a rental is in its lifecycle.
const RENTAL_STAGES = ["Request", "Approved", "Confirmed", "Out", "Returned"] as const;
function stageIndex(t: ReplyTileData): number {
  const step = (t.order_step ?? "").toUpperCase();
  if (step === "RETURNED" || step === "REVIEWED") return 4;
  if (step === "DELIVERED") return 3;
  if (step === "VERIFIED" || step === "BOOKED_AFTER_VERIFIED") return 2;
  if (step === "APPROVED" || step === "FUNDS_RESERVED") return 1;
  if (step === "REQUEST") return 0;
  // No usable step — infer from the decision state / coarse status.
  const { canApprove, canDecline, approved } = decideState(t);
  if (canApprove && canDecline) return 0;
  if (approved) return 1;
  const st = (t.status ?? "").toLowerCase();
  if (st === "completed") return 4;
  if (st === "ongoing") return 3;
  if (st === "confirmed") return 2;
  return 0;
}
/** Small, minimal progress bar: 5 segments filled up to the current stage. */
function StageBar({ t }: { t: ReplyTileData }) {
  const labels = ["Enquiry", "Pending", "Confirmed"] as const;
  const stage = quickReplyStage(t);
  const index = stage === "closed" ? -1 : stage === "confirmed" ? 2 : stage === "pending" ? 1 : 0;
  return <div className={styles.stepper} aria-label={`Booking progress: ${stage[0].toUpperCase()+stage.slice(1)}`}><div className={styles.steps}>{labels.map((label,i) => <div key={label} className={`${styles.step} ${i<=index ? styles.completeStep : ""}`}><small>{label}</small><span title={`${label}: ${i<=index ? "reached" : "pending"}`}>{i<=index ? "✓" : ""}</span></div>)}</div>{stage === "closed" && <small className={styles.closedStage}>Booking closed</small>}</div>;
}

function QueueAvailability({tile}: {tile:ReplyTileData}) {
  const status=tile.availability?.status??"unknown";
  const label=status==="available"?"Available":status==="conflict"?"Unavailable":tile.availability?.reason?.startsWith("Dates")?"Dates needed":"Needs stock review";
  return <span className={`${styles.availability} ${status==="available"?styles.available:status==="conflict"?styles.unavailable:styles.unknown}`} title={tile.availability?.reason??tile.availability?.items.map(item=>`${item.name}: ${item.available===null?item.reason??"Needs stock review":`${item.free} free / ${item.requested} requested`}`).join("; ")??"Checking availability"}>{label}</span>;
}
function ItemAvailability({tile}: {tile:ReplyTileData}) {
  // Fall back for an old MV row until the next shared refresh; never drop a line.
  return <div className={styles.itemStock} aria-label="Item availability">{tile.items.map((line,index)=>{
    const check=tile.availability?.items.find(item=>item.item_index===index)??tile.availability?.items.find(item=>item.name===line.name);
    const state=check?.available;
    return <div key={`${index}-${line.name}`}><span>{line.qty}× {line.display_name??line.name}</span><strong className={state===true?styles.stockYes:state===false?styles.stockNo:styles.stockUnknown}>{state===true?"Available":state===false?"Unavailable":check?.reason??tile.availability?.reason??"Checking stock"}</strong></div>;
  })}{tile.availability?.checked_at&&<small>Stock checked {new Date(tile.availability.checked_at).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</small>}</div>;
}

function fmtDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function fmtMoney(n?: number | null, ccy = "GBP"): string | null {
  if (n == null) return null;
  const sym = ccy === "GBP" ? "£" : `${ccy} `;
  return `${sym}${Math.round(n)}`;
}
function waited(ts: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - ts) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
function urgency(elapsedMs: number) {
  const h = elapsedMs / 3_600_000;
  if (h >= 48)
    return { color: "#ef4444", caption: "2d+ overdue", glow: true, blink: true };
  if (h >= 30)
    return { color: "#ef4444", caption: "overdue", glow: true, blink: false };
  if (h >= 20)
    return { color: "#eab308", caption: "waiting", glow: true, blink: false };
  return { color: "#94a3b8", caption: "unanswered", glow: false, blink: false };
}
function contextLine(t: ReplyTileData): string {
  // Money is shown separately by MoneyHeadline now — keep this to dates + pickup.
  const parts: string[] = [];
  const p = fmtDate(t.start_date);
  if (p) parts.push(`${p} → ${fmtDate(t.end_date) ?? "?"}`);
  if (t.pickup_method && t.pickup_method !== "unknown")
    parts.push(t.pickup_method[0].toUpperCase() + t.pickup_method.slice(1));
  return parts.join("  ·  ");
}
function itemLine(t: ReplyTileData): string {
  const names = t.items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name));
  const extra = t.item_count > t.items.length ? ` +${t.item_count - t.items.length}` : "";
  return names.join(", ") + extra;
}
/**
 * Shorten a Hygglo listing title for the overlay. Their titles are
 * "Real Name | keyword salad" / "Name – long SEO description" — show the
 * meaningful first half (before the first separator), or literally half the
 * text when there's no separator. Keeps the chat, not the SEO title, in focus.
 */
function shortListing(name: string): string { return shortItemName(shortListingTitle(name)); }
/** Modal item line — shortened listing names (overlay stays compact). */
function itemLineShort(t: ReplyTileData): string {
  const names = t.items.map((i) => (i.qty > 1 ? `${i.qty}× ${(i.display_name ?? shortListing(i.name))}` : (i.display_name ?? shortListing(i.name))));
  const extra = t.item_count > t.items.length ? ` +${t.item_count - t.items.length}` : "";
  return names.join(", ") + extra;
}

/**
 * Double-booking badge. Green when the requested set is free for the dates; red
 * when accepting would over-book a unit (shows the tightest item). `incl.
 * pending` tag appears when not-yet-confirmed bookings were counted.
 */
function AvailabilityBadge({ a, compact }: { a: TileAvailability; compact?: boolean }) {
  if (a.status === "unknown") return <span className="inline-flex rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-[#a6adbb]">Availability not verified</span>;
  const ok = a.status === "available";
  // Tightest item drives the message (smallest free-minus-requested margin).
  const worst =
    [...a.items].sort(
      (x, y) => x.free - x.requested - (y.free - y.requested),
    )[0] ?? null;
  const color = ok ? "#34d399" : "#f87171";
  const bg = ok ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.12)";
  const border = ok ? "rgba(16,185,129,0.32)" : "rgba(239,68,68,0.38)";
  const label = ok
    ? compact
      ? "Free for these dates"
      : "Available for the requested dates"
    : worst
      ? `Double-booking · ${worst.name}: ${Math.max(0, worst.free)}/${worst.requested} free`
      : "Double-booking risk";
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 max-w-full"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <span className="text-[11px] leading-none" style={{ color }}>
        {ok ? "✓" : "⚠"}
      </span>
      <span
        className="text-[11px] font-medium truncate"
        style={{ color }}
      >
        {label}
      </span>
      {a.include_pending && (
        <span
          className="text-[8px] uppercase tracking-wider opacity-70 flex-shrink-0"
          style={{ color }}
        >
          incl pending
        </span>
      )}
    </div>
  );
}

// Prospective money, scaled in £100 steps — bigger + warmer + more glow the more
// the rental is worth. tier 0 <£100 … tier 4 £400+ (bright gold, pulsing).
const MONEY_TIERS = [
  { size: 22, color: "#86efac", ring: "rgba(134,239,172,0.22)", glow: "none", pulse: false },
  { size: 27, color: "#34d399", ring: "rgba(52,211,153,0.30)", glow: "0 0 16px -6px rgba(52,211,153,0.65)", pulse: false },
  { size: 33, color: "#5eead4", ring: "rgba(45,212,191,0.38)", glow: "0 0 22px -5px rgba(45,212,191,0.7)", pulse: false },
  { size: 39, color: "#fbbf24", ring: "rgba(251,191,36,0.45)", glow: "0 0 26px -4px rgba(251,191,36,0.75)", pulse: true },
  { size: 46, color: "#fcd34d", ring: "rgba(251,191,36,0.6)", glow: "0 0 34px -2px rgba(251,191,36,0.9)", pulse: true },
] as const;

/**
 * The rental's prospective value + owner earnings, sized/coloured by how much
 * money it is (in £100 steps). Uses the confirmed price when booked, else the
 * estimate (priced from the items × the requested/mentioned days, default 1).
 */
function MoneyHeadline({ tile, compact = false }: { tile: ReplyTileData; compact?: boolean }) {
  // Owner EARNINGS only (not what the renter pays), still scaled in £100 steps.
  const earnings = tile.net_to_owner_gbp ?? tile.estimate_earnings_gbp;
  if (earnings == null) return null;
  const isEstimate = tile.gross_paid_gbp == null;
  const tier = Math.max(0, Math.min(4, Math.floor(earnings / 100)));
  const T = MONEY_TIERS[tier];
  const size = compact ? Math.round(T.size * 0.82) : T.size;
  return (
    <div
      className="inline-flex items-baseline gap-1.5 rounded-xl px-2.5 py-1"
      style={{
        background: `${T.color}14`,
        border: `1px solid ${T.ring}`,
        boxShadow: T.glow,
        animation: T.pulse ? "rgMoney 2.2s ease-in-out infinite" : undefined,
      }}
    >
      <span className="font-extrabold tabular-nums tracking-tight" style={{ fontSize: size, color: T.color }}>
        {fmtMoney(earnings, tile.currency)}
      </span>
      <span className="text-[8.5px] uppercase tracking-[0.1em] font-semibold" style={{ color: `${T.color}b3` }}>
        {isEstimate ? "est earn" : "you keep"}
      </span>
    </div>
  );
}

/** Rental length in days (matches the estimate convention: same-day = 1). */
function daysOf(t: ReplyTileData): number | null {
  return inclusiveRentalDays(t.start_date, t.end_date) ?? t.estimate_days;
}
/** Compact, visually distinct dates + length chip for the overlay meta row. */
function DatePill({ tile }: { tile: ReplyTileData }) {
  const d = daysOf(tile);
  const start = fmtDate(tile.start_date);
  const label = start
    ? `${start}${tile.end_date && tile.end_date !== tile.start_date ? ` → ${fmtDate(tile.end_date)}` : ""}`
    : d != null
      ? `~${d} day${d === 1 ? "" : "s"}`
      : null;
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/[0.14] border border-sky-400/30 px-1.5 py-0.5 text-[11px] font-semibold text-sky-200 whitespace-nowrap">
      <span className="text-[10px]">📅</span>
      <span>{label}</span>
      {start && d != null && <span className="font-medium text-sky-300/70">· {d}d</span>}
    </span>
  );
}
/** Owner earnings only (what they pay is intentionally hidden in the overlay). */
function EarningsChip({ tile }: { tile: ReplyTileData }) {
  const earnings = tile.net_to_owner_gbp ?? tile.estimate_earnings_gbp;
  if (earnings == null) return null;
  const isEst = tile.gross_paid_gbp == null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/[0.14] border border-emerald-400/30 px-1.5 py-0.5 text-[11.5px] font-bold text-emerald-300 tabular-nums whitespace-nowrap">
      {fmtMoney(earnings, tile.currency)}
      <span className="text-[8.5px] font-semibold text-emerald-300/70 uppercase tracking-wide">
        {isEst ? "est earn" : "earn"}
      </span>
    </span>
  );
}

/** Renter reviews as a proper centred overlay (portal), with physical stars. */
function ReviewsOverlay({
  renterName,
  rating,
  count,
  reviews,
  source,
  onClose,
}: {
  renterName: string;
  rating: number | null;
  count: number | null;
  reviews: RenterReviewsResult | undefined;
  source?: ReplyTileData["source"];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Confined to ReplyModal's own body panel (that wrapper is `position:
  // relative`) instead of portaled to document.body — so this never covers
  // the modal's header/close button the way a viewport-fixed overlay would.
  // Single caller (ReplyModal), so no other usage depends on the old portal.
  return (
    <div className="absolute inset-0 z-[40] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-full flex flex-col rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-white/10 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[#f1f3f5] truncate">{renterName}</div>
            <div className="flex items-center gap-1.5 mt-1">
              {rating != null ? (
                <>
                  <StarRating rating={rating} size={14} />
                  <span className="text-[11px] text-[#9aa0ad] tabular-nums">
                    {rating.toFixed(1)}
                    {count != null ? ` · ${count} review${count === 1 ? "" : "s"}` : ""}
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-[#6b7280]">no rating yet</span>
              )}
              {reviews?.lowCount ? (
                <span className="text-[10px] text-red-400 font-semibold">{reviews.lowCount} under 4★</span>
              ) : null}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[#9aa0ad] hover:text-white hover:bg-white/[0.08] text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {source === "dbcinema_web" && reviews?.unavailable ? (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 text-xs leading-relaxed text-[#9aa0ad]">
              No verified renter profile is linked to this DB Cinema account, so there is no trusted renter score or review history to show.
            </div>
          ) : reviews === undefined ? (
            <div className="text-xs text-[#6b7280] py-3 text-center">Loading reviews…</div>
          ) : reviews.reviews.length === 0 ? (
            <div className="text-xs text-[#6b7280] py-3 text-center">No reviews found for this renter.</div>
          ) : (
            reviews.reviews.map((r) => {
              const low = r.rating != null && r.rating < 4;
              return (
                <div
                  key={r.id}
                  className="rounded-lg px-2.5 py-2"
                  style={{
                    background: low ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.03)",
                    border: low ? "1px solid rgba(239,68,68,0.25)" : "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <div className="flex items-center gap-2">
                    {r.rating != null ? <StarRating rating={r.rating} size={11} /> : <span className="text-[11px] text-[#6b7280]">—</span>}
                    {r.author && <span className="text-[10px] text-[#8b8fa3] truncate">{r.author}</span>}
                    <span className="text-[10px] text-[#9aa0ad] ml-auto shrink-0" aria-label="Review date">{reviewTimeLabel(r.created_at)}</span>
                  </div>
                  {r.text && (
                    <div className={`text-[12px] mt-1 ${low ? "text-red-100/90" : "text-[#c5cad3]"}`}>{r.text}</div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** One star, filled 0..1 (a grey star with a coloured star clipped over it) —
 *  gives real fractional/half stars. */
function StarGlyph({ fill, size, color }: { fill: number; size: number; color: string }) {
  const pct = Math.max(0, Math.min(1, fill)) * 100;
  return (
    <span
      className="relative inline-block"
      style={{ width: size, height: size, fontSize: size, lineHeight: `${size}px` }}
    >
      <span className="absolute inset-0" style={{ color: "#3b4150" }}>★</span>
      <span className="absolute inset-0 overflow-hidden" style={{ width: `${pct}%`, color }}>★</span>
    </span>
  );
}
/** Physical 5-star rating with half/fractional stars. Red when < 4★. */
function StarRating({ rating, size = 12 }: { rating: number; size?: number }) {
  const low = rating < 4;
  const color = low ? "#f87171" : "#f5c518";
  return (
    <span className="inline-flex items-center gap-px align-middle">
      {[0, 1, 2, 3, 4].map((i) => (
        <StarGlyph key={i} fill={rating - i} size={size} color={color} />
      ))}
    </span>
  );
}
function Stars({ rating, count, size = 12, emptyLabel = "no rating" }: { rating: number | null; count: number | null; size?: number; emptyLabel?: string }) {
  if (rating == null) return <span className="text-[10px] text-[#8790a0]">☆ {emptyLabel}</span>;
  const low = rating < 4;
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap"
      title={low ? "Low-rated renter — vet their history before accepting" : undefined}
    >
      {low && <span className="text-red-400 text-[11px] leading-none">⚠</span>}
      <StarRating rating={rating} size={size} />
      {count != null && (
        <span className={`text-[10px] ${low ? "text-red-400/70" : "text-[#64748b]"}`}>({count})</span>
      )}
    </span>
  );
}
function Thumb({ src, accent, size = 56 }: { src: string | null; accent: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <div
        className="flex items-center justify-center rounded-xl flex-shrink-0 text-base ring-1 ring-white/10"
        style={{ width: size, height: size, background: `${accent}14`, color: accent }}
      >
        📷
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className="rounded-xl object-cover flex-shrink-0 ring-1 ring-white/10"
      style={{ width: size, height: size }}
    />
  );
}

function tileAccent(tile: Pick<ReplyTileData, "source" | "account_slug">): string {
  return tile.source === "dbcinema_web" ? "#b28cff" : tile.account_slug === "leo" ? "#59d6b5" : accountAccent(tile.account_slug);
}
function AccountTag({ slug, source }: { slug: string | null; source?: ReplyTileData["source"] }) {
  const accent = tileAccent({source,account_slug:slug});
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-1.5 py-[3px] rounded-md tracking-wide border"
      style={{ background: `${accent}22`, color: accent, borderColor: `${accent}55` }}
    >
      {source === "dbcinema_web" ? "DB Cinema" : accountLabel(slug)}
    </span>
  );
}

// ── card ──────────────────────────────────────────────────────────

function ReplyCard({
  tile,
  now,
  onOpen,
  onActed,
  dryRun,
  duplicate = false,
  selected = false,
  onReviews,
  onReplacement,
}: {
  tile: ReplyTileData;
  now: number;
  onOpen: () => void;
  onActed: (id: string) => void;
  dryRun: boolean;
  duplicate?: boolean;
  selected?: boolean;
  onReviews: () => void;
  onReplacement: () => void;
}) {
  const aw = awaitingMe(tile);
  const [stockExpanded,setStockExpanded]=useState(false);
  const ds = decideState(tile);
  // Urgency timer only when the ball is in MY court; a thread I replied to last
  // is calm (no glow / no "unanswered for" clock).
  const u = aw ? urgency(now - tile.last_renter_msg_at) : null;
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<"approve" | "decline" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const dismiss = useMutation(dismissThreadRef);

  // "× close" — hide the tile now (optimistic), persist the dismissal so it stays
  // gone across reloads, and let it re-surface only when the renter messages again.
  async function onDismiss() {
    onActed(tile.thread_id);
    if (tile.source === "dbcinema_web") {
      try { window.localStorage.setItem(`rm-quick-reply-dismissed:${tile.thread_id}`, String(tile.last_activity_at)); } catch { /* browser storage can be disabled */ }
      return;
    }
    try {
      await dismiss({ thread_id: tile.thread_id });
    } catch {
      /* a failed close just means the next queue refresh re-lists it */
    }
  }

  // OPTIMISTIC — flip to "✓ done" the instant you confirm, fire the Hygglo call
  // in the background, revert only on rejection. Makes the trigger feel instant.
  async function act(kind: "approve" | "decline") {
    if (!tile.account_slug) return setNote("No account for this thread — can't " + kind + ".");
    setConfirming(null);
    setOptimistic(kind);
    setBusy(true);
    setNote(null);
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug, dryRun });
      if (r.status === "sent") {
        if (r.reason === "DRY_RUN") setNote(`✓ ${kind} OK (test — nothing sent)`);
        else onActed(tile.thread_id);
      } else if (r.status === "skipped") {
        setOptimistic(null);
        setNote("Order actions disabled (ALLOW_MANUAL_ORDER_ACTIONS off).");
      } else {
        setOptimistic(null);
        setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
      }
    } catch (e) {
      setOptimistic(null);
      setNote(`${kind} failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onOpen} className={`${styles.row} ${selected ? styles.selected : ""} ${duplicate ? styles.duplicate : ""}`} role="button" tabIndex={0} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); } }} aria-label={`Open conversation with ${tile.renter_name}`}>
      <div className={styles.renterCell}>
        <ProfilePortrait src={tile.renter_image_url} name={tile.renter_name} className={styles.avatar}/>
        <div className="min-w-0"><strong className={styles.renterName}>{tile.renter_name}</strong><button type="button" className={styles.rating} onClick={(e) => {e.stopPropagation();onReviews();}} title="View renter reviews">{tile.renter_rating?.toFixed(1) ?? "Unrated"} <span>★</span></button>{(tile.renter_blacklisted || tile.renter_flagged) && <span className="block text-[10px] text-red-300">{tile.renter_blacklisted ? "Blacklisted" : "Flagged"}</span>}{duplicate && <span className={styles.duplicateLabel}>Duplicate · lower value</span>}</div>
      </div>
      <div className={styles.previewCell}><p>{tile.preview || statusText(tile)}</p>{tile.ai_draft_review && <span className="text-[10px] text-amber-300">Reply needs review</span>}</div>
      <div className={styles.gearCell}><AccountTag slug={tile.account_slug} source={tile.source} /><div className={styles.gearLine}><Thumb src={tile.image_url} accent={tileAccent(tile)} size={38} /><span>{itemLineShort(tile) || "General inquiry"}</span></div></div>
      <div className={styles.datesCell}>{tile.start_date ? <><span>{fmtDate(tile.start_date)}</span><span>– {fmtDate(tile.end_date ?? tile.start_date)}</span></> : <span>Dates pending</span>}</div>
      <div className={styles.waitCell}>{aw ? <><span>Waiting</span><strong style={{color:u?.glow ? u.color : "#f6be55"}}>{waited(tile.last_renter_msg_at, now)}</strong></> : <><span>Replied</span><strong className="text-emerald-300">✓</strong></>}</div>
      <div className={styles.earnCell}><span>{tile.net_to_owner_gbp != null ? "Owner earns" : "Est. earn"}</span><strong>{fmtMoney(tile.net_to_owner_gbp ?? tile.estimate_earnings_gbp) ?? "—"}</strong></div>
      <div className={styles.availCell}><QueueAvailability tile={tile} />{tile.items.length>0&&<button type="button" className={styles.itemStockDetails} aria-label={`Show stock for all items requested by ${tile.renter_name}`} aria-expanded={stockExpanded} onClick={event=>{event.stopPropagation();setStockExpanded(value=>!value);}}>{tile.items.length} item{tile.items.length===1?"":"s"} · stock</button>}{tile.availability?.status === "conflict" && <button type="button" className={styles.rowReplacement} onClick={(event) => {event.stopPropagation();onReplacement();}}>Find replacement</button>}</div>
      <div className={styles.progressCell}><StageBar t={tile} />
        <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          {optimistic ? <span className="text-[10px] text-emerald-300">{optimistic === "approve" ? "Approved" : "Declined"}</span> : confirming ? <><button disabled={busy} onClick={() => act(confirming)}>Confirm {confirming}</button><button onClick={() => setConfirming(null)}>Cancel</button></> : <>{ds.canApprove && <button onClick={() => setConfirming("approve")}>Approve</button>}{ds.canDecline && <button onClick={() => setConfirming("decline")}>Decline</button>}</>}
        </div>{note && <span className="text-[10px] text-amber-300">{note}</span>}
      </div>
      {stockExpanded&&<div className={styles.expandedStock} onClick={event=>event.stopPropagation()}><ItemAvailability tile={tile}/></div>}
      <button type="button" onClick={(e) => {e.stopPropagation();void onDismiss();}} aria-label="Close thread" title="Hide until the renter messages again" className={styles.dismiss}>×</button>
    </div>
  );
}

// ── Canned responses (per-account quick texts) ────────────────────

type Canned = {
  _id: Id<"canned_responses">;
  account_slug: string;
  label: string;
  symbol: string;
  text: string;
  sort: number;
};

const CANNED_ACCOUNTS = ["dbcinema", "leo", "diogo", "dbcinema_web"];

/** Pasted into the box (not sent) when a thread has no booking request yet. */
const ASK_REQUEST_TEXT =
  "Whenever you're ready, just send a booking request for the dates you'd like and I'll confirm availability and the price right away 👍";

/** Manage overlay — see/add/edit/delete each account's saved paste-only texts. */
function CannedManager({ accountSlug, onClose }: { accountSlug: string | null; onClose: () => void }) {
  const [acct, setAcct] = useState<string>(accountSlug ?? CANNED_ACCOUNTS[0]);
  const list = (useQuery(cannedListRef, { account_slug: acct }) ?? []) as Canned[];
  const create = useMutation(cannedCreateRef);
  const update = useMutation(cannedUpdateRef);
  const remove = useMutation(cannedRemoveRef);

  const [symbol, setSymbol] = useState("💬");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<Id<"canned_responses"> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function resetForm() {
    setEditing(null);
    setSymbol("💬");
    setLabel("");
    setText("");
  }
  async function save() {
    if (!text.trim() || !label.trim()) return;
    if (editing) await update({ id: editing, symbol, label, text });
    else await create({ account_slug: acct, symbol, label, text });
    resetForm();
  }

  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-stretch justify-end bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-[420px] h-[100dvh] flex flex-col border-l border-white/10 bg-[#17212b] shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center gap-3">
          <span className="text-base font-semibold text-[#f1f3f5]">Quick texts</span>
          <select
            value={acct}
            onChange={(e) => { setAcct(e.target.value); resetForm(); }}
            className="text-xs rounded-lg bg-black/40 border border-white/10 px-2 py-1 text-[#cbd5e1]"
          >
            {CANNED_ACCOUNTS.map((a) => (
              <option key={a} value={a}>{accountLabel(a)}</option>
            ))}
          </select>
          <button aria-label="Close quick texts" onClick={onClose} className="ml-auto text-[#8b8fa3] hover:text-white text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {list.length === 0 ? (
            <div className="text-sm text-[#6b7280]">No quick texts for {accountLabel(acct)} yet.</div>
          ) : (
            list.map((c) => (
              <div key={c._id} className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                <span className="text-xl leading-none">{c.symbol}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#eef1f5]">{c.label}</div>
                  <div className="text-xs text-[#9aa0ad] line-clamp-2">{c.text}</div>
                </div>
                <button
                  onClick={() => { setEditing(c._id); setSymbol(c.symbol); setLabel(c.label); setText(c.text); }}
                  className="text-[11px] px-2 py-1 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12]"
                >
                  Edit
                </button>
                <button
                  onClick={() => { if (confirm(`Delete "${c.label}"?`)) void remove({ id: c._id }); }}
                  className="text-[11px] px-2 py-1 rounded-lg bg-red-500/15 text-red-300 hover:bg-red-500/25"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-white/10 space-y-2">
          <div className="text-xs text-[#8b8fa3]">{editing ? "Edit quick text" : "New quick text"} for {accountLabel(acct)}</div>
          <div className="flex gap-2">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="🏦"
              className="w-14 text-center rounded-lg bg-black/30 border border-white/10 px-2 py-2 text-lg"
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. Bank details)"
              className="flex-1 rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-[#eef1f5] placeholder-[#6b7280]"
            />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Text to paste into Quick Reply (delivery, location, bank info…)"
            rows={3}
            className="w-full resize-y rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-[#eef1f5] placeholder-[#6b7280]"
          />
          <div className="flex items-center gap-2">
            {editing && (
              <button onClick={resetForm} className="text-xs px-3 py-2 rounded-lg bg-white/[0.06] text-[#8b8fa3]">Cancel</button>
            )}
            <button
              onClick={save}
              disabled={!text.trim() || !label.trim()}
              className="ml-auto text-sm font-medium px-5 py-2 rounded-lg bg-emerald-600/90 text-white hover:bg-emerald-600 disabled:opacity-40"
            >
              {editing ? "Save" : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Order editor (live add/remove items · price · dates) ──────────
// Everything Hygglo's own owner order page does, inside the chat. Reads the
// LIVE order (order_edit.getOrderState) so items/price/dates are always fresh;
// writes go through the gated dispatcher (add/remove item, change price, change
// dates). Respects Test mode (dryRun) end-to-end.

const money = (n: number | null | undefined, ccy = "GBP") =>
  n == null ? "—" : `${ccy === "GBP" ? "£" : ccy + " "}${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** yyyy-MM-dd for a local Date. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function prettyDay(s: string | null): string {
  if (!s) return "—";
  const d = parseYmd(s);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Searchable picker over the account's online listings → pick a product to add. */
function AddItemPicker({
  accountSlug,
  onPick,
  onClose,
  busy,
}: {
  accountSlug: string;
  onPick: (productId: number, name: string) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [q, setQ] = useState("");
  const listings = (useQuery(onlineListingsRef, { account_slug: accountSlug }) ?? []) as OnlineListing[];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = listings
    .filter((l) => tokens.every((t) => `${l.display_name ?? ""} ${l.name}`.toLowerCase().includes(t)))
    .slice(0, 60);
  // Confined to ReplyModal's own body panel — see ReviewsOverlay for why
  // (not portaled, so it can't cover the modal's header). Single caller
  // (OrderEditor, itself only rendered inside ReplyModal).
  return (
    <div className="absolute inset-0 z-[40] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-full flex flex-col rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-white/10 flex items-center gap-2">
          <span className="text-sm font-semibold text-[#f1f3f5]">Add an item</span>
          <span className="text-[11px] text-[#6b7280]">{listings.length} listings</span>
          <button onClick={onClose} className="ml-auto text-[#8b8fa3] hover:text-white text-2xl leading-none">×</button>
        </div>
        <div className="p-3 border-b border-white/[0.06]">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search listings by name…"
            className="w-full rounded-lg bg-black/35 border border-white/10 px-3 py-2 text-[16px] text-[#eef1f5] placeholder-[#5b6170] focus:outline-none focus:border-white/25"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {listings.length === 0 ? (
            <div className="text-sm text-[#6b7280] p-3">
              No listings cached yet. Open Settings → “Online listings” and hit Rescan for {accountLabel(accountSlug)}.
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-[#6b7280] p-3">No listings match “{q}”.</div>
          ) : (
            filtered.map((l) => (
              <div key={l.product_id} className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2 hover:bg-white/[0.05]">
                <Thumb src={l.image} accent={accountAccent(accountSlug)} size={40} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-[#e6e9ef] truncate" title={l.name}>{l.display_name ?? shortListing(l.name)}</div>
                  <div className="text-[11px] text-[#7a8190]">
                    {l.daily_price != null ? `${money(l.daily_price)}/day` : "price n/a"}
                    {!l.is_published && <span className="text-amber-400/80"> · unpublished</span>}
                  </div>
                </div>
                <button
                  disabled={busy}
                  onClick={() => onPick(l.product_id, l.name)}
                  className="shrink-0 text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** In-manager month calendar → pick a new rental date range. */
function DateCalendar({
  initialStart,
  initialEnd,
  unavailable,
  minDays,
  accent,
  onApply,
  onClose,
  busy,
}: {
  initialStart: string | null;
  initialEnd: string | null;
  unavailable: Set<string>;
  minDays: number;
  accent: string;
  onApply: (start: string, end: string) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [start, setStart] = useState<string | null>(initialStart);
  const [end, setEnd] = useState<string | null>(initialEnd);
  const [cursor, setCursor] = useState<Date>(() =>
    initialStart ? new Date(parseYmd(initialStart).getFullYear(), parseYmd(initialStart).getMonth(), 1) : new Date(),
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const today = ymd(new Date());
  const y = cursor.getFullYear();
  const m = cursor.getMonth();
  const first = new Date(y, m, 1);
  // Monday-first offset.
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(ymd(new Date(y, m, d)));

  function pick(day: string) {
    if (day < today || unavailable.has(day)) return;
    if (!start || (start && end)) {
      setStart(day);
      setEnd(null);
    } else if (day < start) {
      setStart(day);
    } else {
      setEnd(day);
    }
  }
  const inRange = (day: string) =>
    start && end ? day >= start && day <= end : start ? day === start : false;
  const rangeDays = start && end ? (parseYmd(end).getTime() - parseYmd(start).getTime()) / 86400000 + 1 : start ? 1 : 0;
  const tooShort = rangeDays > 0 && rangeDays < minDays;
  const canApply = !!start && rangeDays >= minDays && !busy;

  // Confined to ReplyModal's own body panel — see ReviewsOverlay for why.
  // Single caller (OrderEditor, itself only rendered inside ReplyModal).
  return (
    <div className="absolute inset-0 z-[40] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-3 border-b border-white/10 flex items-center gap-2">
          <span className="text-sm font-semibold text-[#f1f3f5]">Change rental dates</span>
          <button onClick={onClose} className="ml-auto text-[#8b8fa3] hover:text-white text-2xl leading-none">×</button>
        </div>
        <div className="p-3">
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => setCursor(new Date(y, m - 1, 1))} className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-[#cbd5e1]">‹</button>
            <span className="text-[13px] font-semibold text-[#e6e9ef]">
              {first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
            </span>
            <button onClick={() => setCursor(new Date(y, m + 1, 1))} className="w-8 h-8 rounded-lg hover:bg-white/[0.08] text-[#cbd5e1]">›</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <div key={i} className="text-[10px] text-[#6b7280] py-1">{d}</div>
            ))}
            {cells.map((day, i) => {
              if (!day) return <div key={i} />;
              const disabled = day < today || unavailable.has(day);
              const sel = inRange(day);
              const isEdge = day === start || day === end;
              return (
                <button
                  key={i}
                  disabled={disabled}
                  onClick={() => pick(day)}
                  className={`h-9 rounded-lg text-[12.5px] transition-colors ${
                    disabled
                      ? "text-[#4b5160] line-through cursor-not-allowed"
                      : sel
                        ? "text-white font-semibold"
                        : "text-[#cbd5e1] hover:bg-white/[0.08]"
                  }`}
                  style={sel ? { background: isEdge ? accent : `${accent}44` } : undefined}
                >
                  {parseYmd(day).getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-3 text-[12px] text-[#9aa0ad]">
            {start ? (
              <>
                {prettyDay(start)}
                {end && end !== start ? ` → ${prettyDay(end)}` : ""} · {rangeDays} day{rangeDays === 1 ? "" : "s"}
                {tooShort && <span className="text-amber-400"> · min {minDays} days</span>}
              </>
            ) : (
              "Pick a start date, then an end date."
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button onClick={onClose} className="text-xs px-3 py-2 rounded-lg bg-white/[0.06] text-[#8b8fa3]">Cancel</button>
            <button
              disabled={!canApply}
              onClick={() => start && onApply(start, end ?? start)}
              className="ml-auto text-[13px] font-semibold px-5 py-2 rounded-lg text-white disabled:opacity-40"
              style={{ background: accent }}
            >
              {busy ? "Saving…" : "Apply dates"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Lab orders are stored locally and must never be fetched from Hygglo. */
function LabOrderSummary({ threadId }: { threadId: string }) {
  const order = useQuery(api.renter_bot_lab_order.get, { thread_id: threadId });
  const [expanded, setExpanded] = useState(false);
  if (order === undefined) return <div className="px-4 py-3 border-b border-white/[0.07]"><SkeletonBlock className="h-8 w-full" /></div>;
  if (!order) return <div className="px-4 py-2 border-b border-white/[0.07] text-xs text-[#9aa0ad]">No Lab booking has been created yet.</div>;
  return <div className="border-b border-white/[0.07] bg-[#0d0f13]" aria-label="Lab booking">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/[0.02]">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7a8190] shrink-0">Lab booking</span>
      <span className="text-[11.5px] text-[#9aa0ad] truncate">
        {order.lines.length} item{order.lines.length === 1 ? "" : "s"} · {money(order.total_gbp, "GBP")} · {order.days} day{order.days === 1 ? "" : "s"}
      </span>
      <span className="ml-auto text-[11px] font-medium text-sky-300 shrink-0">{expanded ? "Close ▴" : "View ▾"}</span>
    </button>
    {expanded && <div className="px-4 pb-3 space-y-2 text-xs">
      {order.lines.map((line, index) => <div key={`${line.item_id ?? line.product_id ?? line.name}-${index}`} className="flex items-center gap-2">
        <span className="text-[#e6e9ef] flex-1 min-w-0">{line.qty}× {line.display_name ?? shortListing(line.name)}</span>
        <span className="text-[#9aa0ad] shrink-0">{money(line.line_total_gbp, "GBP")}</span>
      </div>)}
      <div className="text-[#9aa0ad]">{prettyDay(order.start_date)} → {prettyDay(order.end_date)}</div>
      {!!order.unpriced.length && <div className="text-amber-300">Some items need a verified price before a total can be quoted.</div>}
      <div className="text-[10.5px] text-[#6b7280]">Simulated booking. Manage its items and dates in Rental Bot Lab.</div>
    </div>}
  </div>;
}

function OrderEditor({
  accountSlug,
  orderId,
  dryRun,
  initialAction,
}: {
  accountSlug: string;
  orderId: string;
  dryRun: boolean;
  initialAction?: "change" | "dates" | "discount" | "refund";
}) {
  const accent = accountAccent(accountSlug);
  const getState = useAction(getOrderStateRef);
  const preview = useAction(previewPriceRef);
  const getUnavail = useAction(itemUnavailRef);
  const addItem = useAction(addItemRef);
  const removeItem = useAction(removeOrderItemRef);
  const setPrice = useAction(setPriceRef);
  const refund = useAction(refundRef);
  const setDates = useAction(setDatesRef);

  const [st, setSt] = useState<OrderEditState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [editingPrice, setEditingPrice] = useState(false);
  const [priceInput, setPriceInput] = useState("");
  const [pricePreview, setPricePreview] = useState<string | null>(null);
  const [editingRefund, setEditingRefund] = useState(false);
  const [refundInput, setRefundInput] = useState("");
  const [showCal, setShowCal] = useState(false);
  const [unavail, setUnavail] = useState<{ dates: Set<string>; minDays: number }>({ dates: new Set(), minDays: 1 });
  // Collapsed by default so the conversation stays visible — expand to edit.
  const [expanded, setExpanded] = useState(!!initialAction);

  async function refresh() {
    try {
      const r = (await getState({ account_slug: accountSlug, hygglo_order_id: orderId })) as OrderEditState;
      setSt(r);
      if (r.price.order_price != null) setPriceInput(String(r.price.order_price));
    } catch {
      setNote("Couldn't load the booking.");
    } finally {
      setLoading(false);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refresh();
  }, [accountSlug, orderId]);

  function ok(r: WriteOut, verb: string): boolean {
    if (r.status === "sent") {
      setNote(r.reason === "DRY_RUN" ? `✓ ${verb} OK (test — nothing sent)` : `✓ ${verb} done`);
      return true;
    }
    if (r.status === "skipped") setNote("Order edits disabled (ALLOW_MANUAL_ORDER_ACTIONS off).");
    else setNote(`${verb} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
    return false;
  }

  async function onAdd(productId: number, name: string) {
    setBusy("add");
    setNote(null);
    try {
      const r = (await addItem({ account_slug: accountSlug, hygglo_order_id: orderId, product_id: productId, dryRun })) as WriteOut;
      if (ok(r, `Added ${name.slice(0, 30)}`)) {
        setShowPicker(false);
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }
  async function onRemove(itemId: number, name: string) {
    setBusy("remove");
    setNote(null);
    setConfirmRemove(null);
    try {
      const r = (await removeItem({ account_slug: accountSlug, hygglo_order_id: orderId, item_id: itemId, dryRun })) as WriteOut;
      if (ok(r, `Removed ${name.slice(0, 30)}`)) await refresh();
    } finally {
      setBusy(null);
    }
  }
  async function onPreview(v: string) {
    setPriceInput(v);
    const n = Number(v);
    if (!v || Number.isNaN(n) || n < 0) return setPricePreview(null);
    try {
      const r = (await preview({ account_slug: accountSlug, hygglo_order_id: orderId, new_order_price: n })) as {
        ok: boolean; new_total?: number;
      };
      setPricePreview(r.ok && r.new_total != null ? `renter pays ${money(r.new_total, st?.currency)}` : null);
    } catch {
      setPricePreview(null);
    }
  }
  async function onApplyPrice() {
    const n = Number(priceInput);
    if (Number.isNaN(n) || n < 0) return setNote("Enter a valid price.");
    setBusy("price");
    setNote(null);
    try {
      const r = (await setPrice({ account_slug: accountSlug, hygglo_order_id: orderId, order_price: n, dryRun })) as WriteOut;
      if (ok(r, "Price changed")) {
        setEditingPrice(false);
        setPricePreview(null);
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }
  async function onApplyRefund() {
    const amount = Number(refundInput);
    if (!Number.isFinite(amount) || amount <= 0) return setNote("Enter a refund amount greater than zero.");
    setBusy("refund");
    setNote(null);
    try {
      const r = (await refund({ account_slug: accountSlug, hygglo_order_id: orderId, amount, dryRun })) as WriteOut;
      if (ok(r, `Refunded ${money(amount, st?.currency)}`)) {
        setEditingRefund(false);
        setRefundInput("");
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }
  async function openCalendar() {
    setBusy("cal-load");
    try {
      const r = (await getUnavail({ account_slug: accountSlug, hygglo_order_id: orderId })) as {
        dates: string[]; min_rental_days: number;
      };
      setUnavail({ dates: new Set(r.dates), minDays: r.min_rental_days || 1 });
    } catch {
      setUnavail({ dates: new Set(), minDays: 1 });
    } finally {
      setBusy(null);
      setShowCal(true);
    }
  }
  const initialActionApplied = useRef(false);
  useEffect(() => {
    if (!st?.ok || initialActionApplied.current || !initialAction) return;
    initialActionApplied.current = true;
    if (initialAction === "discount") {setEditingPrice(true);setPriceInput(String(st.price.order_price));}
    if (initialAction === "refund") setEditingRefund(true);
    if (initialAction === "dates") void openCalendar();
  }, [st, initialAction]);

  async function onApplyDates(start: string, end: string) {
    setBusy("dates");
    setNote(null);
    try {
      const verb = st?.actions.change_dates ? "changeDates" : st?.actions.select_dates ? "selectDates" : undefined;
      const r = (await setDates({ account_slug: accountSlug, hygglo_order_id: orderId, start, end, verb, dryRun })) as WriteOut;
      if (ok(r, "Dates changed")) {
        setShowCal(false);
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  if (loading)
    return (
      <div className="px-4 py-3 border-b border-white/[0.07]">
        <SkeletonBlock className="h-16 w-full" />
      </div>
    );
  if (!st || !st.ok)
    return (
      <div className="px-4 py-2.5 border-b border-white/[0.07] text-[12px] text-amber-400/90">
        Couldn’t load booking items{st?.error ? ` (${st.error.slice(0, 60)})` : ""}.
        <button onClick={() => void refresh()} className="ml-2 underline">retry</button>
      </div>
    );

  const a = st.actions;
  const canDiscount = a.change_price || a.partial_refund;
  const anyEditable =
    a.add_product || a.change_price || a.change_dates || a.select_dates || a.partial_refund || st.items.some((i) => i.can_remove);
  return (
    <div className="border-b border-white/[0.07] bg-[#0d0f13]">
      {/* Collapsed summary — click to expand the editor. Keeps the chat visible. */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-white/[0.02]"
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#7a8190] shrink-0">
          Booking
        </span>
        {!expanded && (
          <span className="text-[11.5px] text-[#9aa0ad] truncate">
            {st.items.length} item{st.items.length === 1 ? "" : "s"} · {money(st.price.order_price, st.currency)} · {prettyDay(st.dates.start)}
          </span>
        )}
        {dryRun && <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold shrink-0">TEST</span>}
        <span className="ml-auto text-[11px] font-medium text-sky-300 shrink-0">
          {expanded ? "Done ▴" : anyEditable ? "✎ Edit ▾" : "View ▾"}
        </span>
      </button>

      {expanded && (
      <>
      <div className="flex items-center gap-2 px-4 pb-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-[#5f6675]">items · price · dates</span>
        <button onClick={() => void refresh()} title="Refresh from Hygglo" className="ml-auto text-[11px] text-[#7a8190] hover:text-white">↻</button>
      </div>

      {/* Items */}
      <div className="px-3 pb-2 space-y-1.5">
        {st.items.map((it) => (
          <div key={it.item_id ?? it.name} className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
            <Thumb src={it.image} accent={accent} size={36} />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-[#e6e9ef] truncate" title={it.name}>{shortListing(it.name)}</div>
              {it.price_label && <div className="text-[11px] text-[#7a8190]">{it.price_label}</div>}
            </div>
            {confirmRemove === it.item_id ? (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  disabled={!!busy}
                  onClick={() => it.item_id != null && onRemove(it.item_id, it.name)}
                  className="text-[11px] px-2 py-1 rounded-lg bg-red-600 text-white disabled:opacity-50"
                >
                  {busy === "remove" ? "…" : "Remove"}
                </button>
                <button onClick={() => setConfirmRemove(null)} className="text-[11px] px-1.5 py-1 rounded-lg bg-white/[0.06] text-[#8b8fa3]">✗</button>
              </div>
            ) : it.can_remove ? (
              <button
                disabled={!!busy}
                onClick={() => it.item_id != null && setConfirmRemove(it.item_id)}
                title="Remove this item from the booking"
                className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.05] text-red-300 hover:bg-red-500/15 disabled:opacity-40"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {a.add_product ? (
          <button
            disabled={!!busy}
            onClick={() => setShowPicker(true)}
            title="Add a listing to this booking"
            className="w-full text-[12px] font-medium px-3 py-2 rounded-xl border border-dashed border-white/15 text-[#cbd5e1] hover:bg-white/[0.05] disabled:opacity-40"
          >
            {busy === "add" ? "Adding…" : "＋ Add item"}
          </button>
        ) : (
          <div className="text-[10.5px] text-[#6b7280] px-1">
            Items are locked — this booking can’t be changed anymore.
          </div>
        )}
      </div>

      {/* Price + dates */}
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="text-[#7a8190]">Price</span>
          <span className="text-[#e6e9ef] font-medium">
            {money(st.price.order_price, st.currency)} rental
          </span>
          <span className="text-[#6b7280]">· {money(st.price.total, st.currency)} total</span>
          {canDiscount && (
            <button
              onClick={() => { setEditingPrice((s) => !s); setPricePreview(null); setPriceInput(st.price.order_price != null ? String(st.price.order_price) : ""); }}
              title="Change the price (discount or increase)"
              className="ml-auto text-[12px] text-sky-300 hover:text-sky-200"
            >
              ✎ edit
            </button>
          )}
        </div>
        {editingPrice && a.change_price && (
          <div className="rounded-xl border border-white/10 bg-black/30 p-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[#8b8fa3]">New rental price</span>
              <div className="flex items-center gap-1 rounded-lg bg-black/40 border border-white/10 px-2">
                <span className="text-[13px] text-[#9aa0ad]">£</span>
                <input
                  type="number"
                  value={priceInput}
                  onChange={(e) => void onPreview(e.target.value)}
                  className="w-20 bg-transparent py-1.5 text-[15px] text-[#eef1f5] focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-1">
                {[-10, -5, 5].map((delta) => (
                  <button
                    key={delta}
                    onClick={() => void onPreview(String(Math.max(0, Number(priceInput || st.price.order_price || 0) + delta)))}
                    className="text-[11px] px-1.5 py-1 rounded-md bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12]"
                  >
                    {delta > 0 ? `+${delta}` : delta}
                  </button>
                ))}
              </div>
            </div>
            {pricePreview && <div className="text-[11px] text-sky-300/90">{pricePreview}</div>}
            <div className="flex items-center gap-2">
              <button onClick={() => setEditingPrice(false)} className="text-[11px] px-2.5 py-1.5 rounded-lg bg-white/[0.06] text-[#8b8fa3]">Cancel</button>
              <button
                disabled={busy === "price"}
                onClick={() => void onApplyPrice()}
                className="ml-auto text-[12px] font-semibold px-4 py-1.5 rounded-lg text-white disabled:opacity-50"
                style={{ background: accent }}
              >
                {busy === "price" ? "Saving…" : "Apply price"}
              </button>
            </div>
          </div>
        )}
        {a.partial_refund && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
            {!editingRefund ? (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 text-[11px] text-[#8b93a3]">Refund part of the payment through Hygglo.</span>
                <button
                  disabled={!!busy}
                  onClick={() => { setEditingRefund(true); setRefundInput(""); setNote(null); }}
                  className="shrink-0 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-semibold text-[#d7dce5] hover:bg-white/[0.09] disabled:opacity-40"
                >
                  Refund…
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <label htmlFor={`refund-${orderId}`} className="min-w-0 flex-1 text-[11px] text-[#aeb5c2]">Refund amount</label>
                  <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-black/40 px-2">
                    <span className="text-[12px] text-[#9aa0ad]">{st.currency === "GBP" ? "£" : st.currency}</span>
                    <input
                      id={`refund-${orderId}`}
                      type="number"
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      value={refundInput}
                      onChange={(e) => setRefundInput(e.target.value)}
                      placeholder="0.00"
                      className="w-24 bg-transparent py-1.5 text-[15px] text-[#eef1f5] focus:outline-none"
                    />
                  </div>
                </div>
                <p className="text-[10.5px] leading-relaxed text-[#737b89]">This sends a partial refund to the renter’s original payment method.</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => { setEditingRefund(false); setRefundInput(""); }} className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-[#a0a6b2]">Cancel</button>
                  <button
                    disabled={busy === "refund" || !refundInput || Number(refundInput) <= 0}
                    onClick={() => void onApplyRefund()}
                    className="ml-auto rounded-lg bg-rose-600 px-3.5 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-40"
                  >
                    {busy === "refund" ? "Processing…" : `Refund ${refundInput ? money(Number(refundInput), st.currency) : "payment"}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="text-[#7a8190]">Dates</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/[0.14] border border-sky-400/30 px-2 py-0.5 text-[12px] font-semibold text-sky-100">
            <span className="text-[10px]">📅</span>
            {prettyDay(st.dates.start)}
            {st.dates.end && st.dates.end !== st.dates.start ? ` → ${prettyDay(st.dates.end)}` : ""}
          </span>
          {(a.change_dates || a.select_dates) && (
            <button
              disabled={busy === "cal-load"}
              onClick={() => void openCalendar()}
              title="Change the rental dates"
              className="ml-auto text-[12px] text-sky-300 hover:text-sky-200 disabled:opacity-50"
            >
              📅 {busy === "cal-load" ? "…" : "change"}
            </button>
          )}
        </div>
      </div>
      </>
      )}

      {note && (
        <div className={`px-4 pb-2 text-[11px] ${note.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>{note}</div>
      )}

      {showPicker && (
        <AddItemPicker accountSlug={accountSlug} busy={!!busy} onPick={onAdd} onClose={() => setShowPicker(false)} />
      )}
      {showCal && (
        <DateCalendar
          initialStart={st.dates.start}
          initialEnd={st.dates.end}
          unavailable={unavail.dates}
          minDays={unavail.minDays}
          accent={accent}
          busy={busy === "dates"}
          onApply={onApplyDates}
          onClose={() => setShowCal(false)}
        />
      )}
    </div>
  );
}

// ── modal (body portal — escapes widget clipping) ─────────────────
// Exported so the notification deep-link host can open a thread from a tapped
// push without the Reply Inbox widget being mounted/visible.

export function ReplyModal({
  tile,
  onClose,
  onActed,
  dryRun,
  zClass = "z-[200]",
  dockTarget,
  initialShowReviews = false,
  initialReplacementRequest = 0,
}: {
  tile: ReplyTileData;
  onClose: () => void;
  onActed: (id: string) => void;
  dryRun: boolean;
  zClass?: string;
  dockTarget?: HTMLElement | null;
  initialShowReviews?: boolean;
  initialReplacementRequest?: number;
}) {
  const accent = tileAccent(tile);
  const ds = decideState(tile);
  const [viewport,setViewport]=useState<{height:number;width:number;top:number;left:number}|null>(null);
  useEffect(()=>{
    if(dockTarget)return;
    const visible=window.visualViewport;
    const update=()=>setViewport({height:visible?.height??window.innerHeight,width:visible?.width??window.innerWidth,top:visible?.offsetTop??0,left:visible?.offsetLeft??0});
    update();visible?.addEventListener("resize",update);visible?.addEventListener("scroll",update);window.addEventListener("resize",update);
    return ()=>{visible?.removeEventListener("resize",update);visible?.removeEventListener("scroll",update);window.removeEventListener("resize",update);};
  },[dockTarget]);
  const [bookingAction, setBookingAction] = useState<"change" | "dates" | "discount" | "refund" | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [controlTab, setControlTab] = useState<RentalControlTab>("gear");
  const [replacementApplied, setReplacementApplied] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  type ReplacementOption={id:string;name:string;image_url:string|null;available:boolean;original:Record<string,unknown>;can_apply:boolean;price_note:string};
  const replacementOptions=useAction(makeFunctionReference<"action">("quick_reply_replacements:options"));
  const dbReplacementOptions=useAction(makeFunctionReference<"action">("dbcinema_chat:replacementOptions"));
  const acceptReplacement=useAction(makeFunctionReference<"action">("quick_reply_replacements:accept"));
  const dbAcceptReplacement=useAction(makeFunctionReference<"action">("dbcinema_chat:acceptReplacement"));
  const draftReplacement=useAction(makeFunctionReference<"action">("quick_reply_replacements:draft"));
  const [replacementOpen,setReplacementOpen]=useState(false);
  const [replacementIndex,setReplacementIndex]=useState(0);
  const [replacementChoices,setReplacementChoices]=useState<ReplacementOption[]>([]);
  const [replacementChoice,setReplacementChoice]=useState<ReplacementOption|null>(null);
  const [replacementText,setReplacementText]=useState("");
  const [replacementBusy,setReplacementBusy]=useState<string|null>(null);
  const [replacementError,setReplacementError]=useState<string|null>(null);
  const replacementRequest=useRef<string|null>(null);
  const replacementDraftVersion=useRef(0);
  const replacementStockVersion=useRef(0);
  const chooseReplacement=async(candidate:ReplacementOption,index:number)=>{
    const version=++replacementDraftVersion.current;
    setReplacementChoice(candidate);setReplacementText("");setReplacementError(null);replacementRequest.current=crypto.randomUUID();
    try{const result=await draftReplacement({thread_id:tile.thread_id,item_index:index,replacement_id:candidate.id,source:tile.source,booking_id:tile.source_booking_id});if(version===replacementDraftVersion.current)setReplacementText(result.draft);}
    catch(error){if(version===replacementDraftVersion.current)setReplacementError(error instanceof Error?error.message:"Replacement draft is unavailable.");}
  };
  const findReplacements=async(index:number)=>{
    if(replacementBusy === "apply")return;
    const stockVersion=++replacementStockVersion.current;
    ++replacementDraftVersion.current;
    setControlsOpen(true);setControlTab("gear");setBookingAction(null);setReplacementApplied(false);setReplacementOpen(true);setReplacementIndex(index);setReplacementBusy("stock");setReplacementError(null);setReplacementChoices([]);setReplacementChoice(null);setReplacementText("");
    try{const result=tile.source==="dbcinema_web"?await dbReplacementOptions({booking_id:tile.source_booking_id,item_index:index}):await replacementOptions({thread_id:tile.thread_id,item_index:index});
      if(stockVersion!==replacementStockVersion.current)return;
      setReplacementChoices(result.options.slice(0,2));if(result.options.length)await chooseReplacement(result.options[0],index);else setReplacementError(result.reason??"No suitable replacement with verified stock is available.");}
    catch(error){if(stockVersion===replacementStockVersion.current)setReplacementError(error instanceof Error?error.message:"Replacement stock check failed.");}finally{if(stockVersion===replacementStockVersion.current)setReplacementBusy(null);}
  };
  useEffect(() => {
    if (initialReplacementRequest > 0 && tile.availability?.status === "conflict") {
      const unavailable = tile.availability.items.find(item => item.available === false);
      const index = unavailable?.item_index ?? (unavailable ? tile.items.findIndex(item => item.name === unavailable.name) : 0);
      void findReplacements(Math.max(0, index));
    }
    // A new explicit list-row request, not polling, opens the prepared proposal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReplacementRequest]);
  const applyReplacement=async()=>{
    if(!replacementChoice||!replacementRequest.current||replacementBusy)return;
    setReplacementBusy("apply");setReplacementError(null);
    try{const shared={replacement_id:replacementChoice.id,original:replacementChoice.original,request_id:replacementRequest.current,dryRun};
      const result=tile.source==="dbcinema_web"?await dbAcceptReplacement({...shared,booking_id:tile.source_booking_id}):await acceptReplacement({...shared,thread_id:tile.thread_id,item_index:replacementIndex});
      if(!result.ok)throw Error(result.message??"Replacement could not be verified. Check the original order.");
      setNote(result.dryRun?"✓ Replacement checked in test mode — nothing changed.":"✓ Replacement applied. Review and send the reply separately.");
      setText(replacementText);setComposeApproval(null);setComposeOpen(true);
      setReplacementApplied(true);setDbCinemaRefresh(value=>value+1);
    }catch(error){setReplacementError(error instanceof Error?error.message:"Replacement failed.");}finally{setReplacementBusy(null);}
  };

  const fileRef = useRef<HTMLInputElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  const hyggloThread = useQuery(api.hygglo.listByThread, tile.source === "dbcinema_web" ? "skip" : { thread_id: tile.thread_id });
  const loadDbCinemaThread = useAction(dbCinemaThreadRef);
  const sendDbCinemaReply = useAction(dbCinemaSendRef);
  const draftDbCinemaReply = useAction(dbCinemaDraftRef);
  const [dbCinemaMessages, setDbCinemaMessages] = useState<Array<{id:string;role:"owner"|"renter";content:string;timestamp:number}>>([]);
  const [dbCinemaLoading, setDbCinemaLoading] = useState(tile.source === "dbcinema_web");
  const [dbCinemaRefresh, setDbCinemaRefresh] = useState(0);
  useEffect(() => {
    if (tile.source !== "dbcinema_web" || !tile.source_booking_id) return;
    let alive = true;
    void loadDbCinemaThread({ booking_id: tile.source_booking_id }).then((result) => {
      if (alive) setDbCinemaMessages(result.messages);
    }).catch(() => {
      if (alive) setNote("DB Cinema chat history is temporarily unavailable.");
    }).finally(() => { if (alive) setDbCinemaLoading(false); });
    return () => { alive = false; };
  }, [loadDbCinemaThread, tile.source, tile.source_booking_id, dbCinemaRefresh]);
  useEffect(() => {
    if (tile.source !== "dbcinema_web") return;
    const refresh = () => {if(document.visibilityState === "visible")setDbCinemaRefresh(value=>value+1);};
    const timer = window.setInterval(refresh,15_000);
    document.addEventListener("visibilitychange",refresh);
    return () => {window.clearInterval(timer);document.removeEventListener("visibilitychange",refresh);};
  },[tile.source]);
  const thread = tile.source === "dbcinema_web" ? (dbCinemaLoading ? undefined : dbCinemaMessages) : hyggloThread;
  // Live tile (reactive) so the location overlay appears the moment it resolves.
  const liveTile = useQuery(api.replyInbox.getThreadById, tile.source === "dbcinema_web" ? "skip" : {
    thread_id: tile.thread_id,
  });
  const loc = (liveTile?.location ?? tile.location) as TileLocation | null;
  const resolveLoc = useAction(resolveLocRef);
  const resolveTrust = useAction(resolveTrustRef);
  const locResolvedRef = useRef(false);
  useEffect(() => {
    if (tile.source === "dbcinema_web") return;
    if (locResolvedRef.current) return;
    locResolvedRef.current = true;
    void resolveLoc({ thread_id: tile.thread_id });
    // Pull the renter's real rating + reviews (Hygglo order detail) on open.
    void resolveTrust({ thread_id: tile.thread_id });
  }, [resolveLoc, resolveTrust, tile.thread_id, tile.source]);
  const generateDraft = useAction(api.replyInbox_actions.generateDraft);
  const sendReply = useAction(api.replyInbox_actions.sendRenterReply);
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);

  const [text, setText] = useState("");
  useEffect(()=>{
    const input=replyInputRef.current;if(!input)return;
    input.style.height="42px";
    input.style.height=`${Math.min(viewport&&viewport.height<500?42:110,Math.max(42,input.scrollHeight))}px`;
  },[text,viewport?.height]);
  const [composeApproval,setComposeApproval] = useState<DraftApproval|null>(null);
  const copiedDraftStale = !!composeApproval && !sameDraftApproval(composeApproval,liveTile?.ai_draft_approval);
  // AI draft lives in its OWN preview box (not the compose box). Tap it to copy
  // it into the message box, then edit + Send yourself — never auto-sent.
  const [draft, setDraft] = useState(tile.ai_draft_review || tile.ai_draft_stale ? "" : tile.ai_draft_text ?? "");
  const [draftConfidence, setDraftConfidence] = useState<number | null>(
    tile.ai_draft_confidence ?? null,
  );
  const [draftFlags, setDraftFlags] = useState<DraftFlag[]>(
    tile.ai_draft_flags ?? [],
  );
  const [draftReview, setDraftReview] = useState<DraftReview | null>(tile.ai_draft_review ?? null);
  // The AI preview follows the authoritative thread, including background
  // results and review invalidation. The owner's compose text is separate.
  useEffect(() => {
    if (!liveTile) return;
    const review = liveTile.ai_draft_review ?? null;
    const withheld = !!review || !!liveTile.ai_draft_stale;
    setDraftReview(review);
    setDraft(withheld ? "" : liveTile.ai_draft_text ?? "");
    setDraftConfidence(withheld ? null : liveTile.ai_draft_confidence ?? null);
    setDraftFlags(withheld ? [] : liveTile.ai_draft_flags ?? []);
  }, [liveTile]);
  const [showFlags, setShowFlags] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Real sends are written into hygglo_messages by recordSentReply and arrive
  // through the reactive `thread` query. Only dry-run messages are client-only.
  const [dryRunSentMsgs, setDryRunSentMsgs] = useState<string[]>([]);
  const messageListRef=useRef<HTMLDivElement>(null);
  const followLatest=useRef(true);
  useEffect(()=>{
    const list=messageListRef.current;if(!list)return;
    let alive=true;
    const revealLatest=()=>{if(alive&&followLatest.current)list.scrollTop=list.scrollHeight;};
    revealLatest();
    const observer=new ResizeObserver(revealLatest);observer.observe(list);
    void document.fonts.ready.then(revealLatest);
    return()=>{alive=false;observer.disconnect();};
  },[thread?.length,dryRunSentMsgs.length]);
  const [decided, setDecided] = useState<"approve" | "decline" | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  // Renter reviews — fetched live from Hygglo on first star-click, then cached.
  const [showReviews, setShowReviews] = useState(initialShowReviews);
  // Map — owned here (not by LocationBadge) so it renders as a confined panel
  // in this modal's own body wrapper instead of LocationBadge's default
  // full-viewport overlay. See LocationBadge's onOpenMap prop.
  const [showMap, setShowMap] = useState(false);
  const queriedReviews = useQuery(
    reviewsGetRef,
    showReviews && tile.source !== "dbcinema_web" ? { thread_id: tile.thread_id } : "skip",
  ) as RenterReviewsResult | undefined;
  const [dbCinemaReviews, setDbCinemaReviews] = useState<RenterReviewsResult | undefined>();
  const dbCinemaReviewsRequested = useRef(false);
  const getDbCinemaReviews = useAction(dbCinemaReviewsRef);
  useEffect(() => {
    if (showReviews && tile.source === "dbcinema_web" && !dbCinemaReviewsRequested.current) {
      dbCinemaReviewsRequested.current = true;
      const bookingId = tile.source_booking_id ?? tile.thread_id.replace(/^dbcinema:/, "");
      void getDbCinemaReviews({ booking_id: bookingId }).then(setDbCinemaReviews).catch(() => {
        setDbCinemaReviews({ reviews: [], lowCount: 0, fetched: false, unavailable: true });
      });
    }
  }, [showReviews, tile.source, tile.source_booking_id, tile.thread_id, getDbCinemaReviews]);
  const reviews = tile.source === "dbcinema_web"
    ? dbCinemaReviews
    : queriedReviews;
  const refreshReviews = useAction(reviewsRefreshRef);
  const reviewsRefreshedRef = useRef(false);
  useEffect(() => {
    if (showReviews && tile.source !== "dbcinema_web" && !reviewsRefreshedRef.current) {
      reviewsRefreshedRef.current = true;
      void refreshReviews({ thread_id: tile.thread_id });
    }
  }, [showReviews, refreshReviews, tile.source, tile.thread_id]);
  // Per-account canned "quick texts" — tapping one PASTES into the box.
  const cannedAccountSlug = tile.account_slug;
  const canned = (useQuery(cannedListRef, {
    account_slug: cannedAccountSlug ?? undefined,
  }) ?? []) as Canned[];
  const createCanned = useMutation(cannedCreateRef);
  const updateCanned = useMutation(cannedUpdateRef);
  const [quickSlot, setQuickSlot] = useState<"location" | "times" | "delivery" | null>(null);
  const [quickDraft, setQuickDraft] = useState("");
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickError, setQuickError] = useState<string|null>(null);
  const quickPreset = quickSlot
    ? canned.find((c) => quickSlot === "location" ? /location|address|pickup/i.test(c.label) : quickSlot === "times" ? /time|hour|availability/i.test(c.label) : /delivery|courier|shipping/i.test(c.label))
    : undefined;
  function openQuickSlot(slot: "location" | "times" | "delivery") {
    if(quickSaving)return;
    setQuickError(null);
    setQuickSlot(slot);
    const found = canned.find((c) => slot === "location" ? /location|address|pickup/i.test(c.label) : slot === "times" ? /time|hour|availability/i.test(c.label) : /delivery|courier|shipping/i.test(c.label));
    setQuickDraft(found?.text ?? "");
  }
  function pasteQuickSlot(slot: "location" | "times" | "delivery") {
    const found = canned.find((c) => slot === "location" ? /location|address|pickup/i.test(c.label) : slot === "times" ? /time|hour|availability/i.test(c.label) : /delivery|courier|shipping/i.test(c.label));
    if (found) pasteText(found.text);
    else openQuickSlot(slot);
  }
  async function saveQuickPreset() {
    if (quickSaving || !quickSlot || !quickDraft.trim() || !cannedAccountSlug) return;
    const label = quickSlot === "location" ? "Location" : quickSlot === "times" ? "Times" : "Delivery info";
    const symbol = quickSlot === "location" ? "📍" : quickSlot === "times" ? "🕒" : "🚚";
    setQuickSaving(true);setQuickError(null);
    const body=quickDraft.trim();
    try {
      if (quickPreset) await updateCanned({ id: quickPreset._id, label, symbol, text: body });
      else await createCanned({ account_slug: cannedAccountSlug, label, symbol, text: body });
      pasteText(body);setQuickSlot(null);
    } catch(error) {
      setQuickError(error instanceof Error ? error.message : "Could not save this quick reply. Please try again.");
    } finally {setQuickSaving(false);}
  }

  // Paste a snippet into the compose box (never sends). Appends with a blank
  // line if there's already text, so you can stack delivery + bank + your own.
  function copyAIDraft() {
    if(tile.source === "dbcinema_web"){pasteText(draft);return;}
    const approval=liveTile?.ai_draft_approval;
    if (!approval || liveTile?.ai_draft_text!==draft) {setNote("Waiting for the latest draft. Try again in a moment.");return;}
    if (composeApproval && !sameDraftApproval(composeApproval,approval)) {setNote("Clear the previous copied reply before copying the latest draft. Your text has been kept.");return;}
    setComposeApproval(approval);pasteText(draft);
  }
  function pasteText(snippet: string) {
    setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${snippet}` : snippet));
    setNote(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onGenerate() {
    setDrafting(true);
    setNote(null);
    try {
      if (tile.source === "dbcinema_web") {
        if (!tile.source_booking_id) throw new Error("Missing DB Cinema booking reference.");
        const result = await draftDbCinemaReply({ booking_id: tile.source_booking_id });
        setDraft(result.draft);
        setDraftConfidence(null);
        setDraftFlags([]);
        return;
      }
      const r = await generateDraft({ thread_id: tile.thread_id, retry_review: true });
      if (r.status === "ok" && r.draft) {
        setDraftReview(null);
        setDraft(r.draft);
        setDraftConfidence(r.confidence ?? null);
        setDraftFlags(r.flags ?? []);
      } else if (r.reason?.startsWith("needs_human")) {
        setDraftReview(r.review ?? null);
        setDraft(""); setDraftConfidence(null); setDraftFlags([]);
        setNote(r.review ? null : "The reply needs your review. " + draftReviewSummary({ reason: r.reason, flags: r.flags ?? [] }));
      } else if (r.reason === "generation_in_progress") {
        setNote("A reply is already being drafted. It will appear here when ready.");
      } else if (r.reason === "subscription_unavailable") {
        setNote("The draft assistant is temporarily unavailable.");
      } else setNote("Draft unavailable.");
    } catch {
      setNote("Draft failed.");
    } finally {
      setDrafting(false);
    }
  }
  function onCopyDraft() {
    if (tile.source === "dbcinema_web") {
      if (draft) pasteText(draft);
      return;
    }
    copyAIDraft();
  }
  // Shared send used by the compose box AND the canned quick-text buttons.
  // Returns true on success. clearBox=true also empties the textarea.
  async function sendBody(body: string, clearBox: boolean): Promise<boolean> {
    if (!body.trim()) {
      setNote("Type a message first.");
      return false;
    }
    if (!tile.account_slug) {
      setNote("No account for this thread — can't send.");
      return false;
    }
    setSending(true);
    setNote(null);
    try {
      if (tile.source === "dbcinema_web") {
        if (dryRun) {
          if (clearBox) setText("");
          setDryRunSentMsgs((prev) => [...prev, body.trim()]);
          setNote("✓ Reply OK (test — nothing sent)");
          return true;
        }
        if (!tile.source_booking_id) throw new Error("Missing DB Cinema booking reference.");
        await sendDbCinemaReply({ booking_id: tile.source_booking_id, text: body.trim() });
        setDbCinemaMessages((prev) => [...prev, { id: `sent-${Date.now()}`, role: "owner", content: body.trim(), timestamp: Date.now() }]);
        if (clearBox) setText("");
        setNote("Reply sent to the DB Cinema rental chat.");
        setDbCinemaRefresh((value) => value + 1);
        return true;
      }
      const r = await sendReply({ thread_id: tile.thread_id, account_slug: tile.account_slug, text: body.trim(), dryRun, ...(clearBox && composeApproval ? {draft_approval:composeApproval} : {}) });
      if (r.status === "sent") {
        // Keep the chat OPEN so you can also approve/decline or keep texting.
        if (r.reason === "DRY_RUN") setDryRunSentMsgs((p) => [...p, body.trim()]);
        if (clearBox) {setText("");setComposeApproval(null);}
        setNote(r.reason === "DRY_RUN" ? "✓ Reply OK (test — nothing sent)" : null);
        return true;
      }
      if (r.status === "skipped") setNote("Sending disabled (ALLOW_MANUAL_RENTER_SEND off).");
      else setNote(`Send failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
      return false;
    } catch (e) {
      setNote(`Send failed: ${e instanceof Error ? e.message : "error"}`);
      return false;
    } finally {
      setSending(false);
    }
  }
  function onSend() {
    return sendBody(text, true);
  }
  async function onDecide(kind: "approve" | "decline") {
    if (!tile.account_slug) {
      setConfirming(null);
      return setNote("No account for this thread — can't " + kind + ".");
    }
    // OPTIMISTIC — flip the UI to decided INSTANTLY, fire the Hygglo call in the
    // background, and revert only if it's rejected. Makes the trigger feel
    // immediate instead of waiting on the round-trip. Modal stays open (you can
    // still message); the card leaves the list only on confirmed success.
    setConfirming(null);
    setDeciding(true);
    setDecided(kind);
    setNote(null);
    try {
      const fn = kind === "approve" ? approve : decline;
      const r = await fn({ thread_id: tile.thread_id, account_slug: tile.account_slug, dryRun });
      if (r.status === "sent") {
        if (r.reason === "DRY_RUN") setNote(`✓ ${kind === "approve" ? "Approved" : "Declined"} (test — nothing sent)`);
        else onActed(tile.thread_id);
      } else if (r.status === "skipped") {
        setDecided(null);
        setNote("Order actions disabled (ALLOW_MANUAL_ORDER_ACTIONS off).");
      } else {
        setDecided(null);
        setNote(`${kind} failed${r.httpStatus ? ` (${r.httpStatus})` : ""}: ${r.error ?? r.reason ?? "unknown"}`);
      }
    } catch (e) {
      setDecided(null);
      setNote(`${kind} failed: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setDeciding(false);
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal={dockTarget ? false : true}
      aria-label={`Conversation with ${tile.renter_name}`}
      className={dockTarget ? styles.dockedDialog : `${styles.overlay} fixed inset-0 ${zClass}`}
      style={dockTarget||!viewport?undefined:({height:viewport.height,width:viewport.width,top:viewport.top,left:viewport.left,right:"auto",bottom:"auto","--quick-reply-viewport-height":`${viewport.height}px`} as CSSProperties)}
    >
      {/* Backdrop click does NOT close — only the × button (or Esc) closes, so
          you can text AND approve/decline in one session without losing it. */}
      <div
        className={styles.conversation}
        data-composing={composeOpen}
        data-controls={controlsOpen}
        data-short-viewport={viewport ? viewport.height<500 : undefined}
        style={{ borderColor: `${accent}4d` }}
      >
        {controlsOpen && <RentalControls
          name={tile.renter_name} portrait={tile.renter_image_url}
          identity={<><button type="button" className={styles.rating} onClick={()=>{setControlsOpen(false);setShowReviews(true);}}>{tile.renter_rating?.toFixed(1) ?? "Unrated"} <span>★</span></button><AccountTag slug={tile.account_slug} source={tile.source}/></>}
          progress={<StageBar t={tile}/>}
          tab={controlTab} onTab={tab=>{setControlTab(tab);setBookingAction(tab==="dates"?"dates":tab==="pricing"?"discount":null);}}
          onClose={()=>{setControlsOpen(false);setBookingAction(null);}}
          gear={<><div className={styles.controlGear}><Thumb src={tile.image_url} accent={accent} size={68}/><div><strong>{itemLineShort(tile)||"General inquiry"}</strong><small>{tile.start_date?`${fmtDate(tile.start_date)} – ${fmtDate(tile.end_date??tile.start_date)}`:"Dates pending"}</small><QueueAvailability tile={tile}/><b>{fmtMoney(tile.net_to_owner_gbp??tile.estimate_earnings_gbp)??"—"}</b></div></div><ItemAvailability tile={tile}/></>}
          replacement={replacementOpen?{
            choices:replacementChoices,selected:replacementChoice?.id??null,text:replacementText,busy:replacementBusy,error:replacementError,applied:replacementApplied,sending,
            onSend:()=>{if(sending||replacementBusy||!replacementText.trim())return;void sendBody(replacementText,false).then(ok=>{if(ok){setText("");setComposeApproval(null);setControlsOpen(false);setReplacementOpen(false);}else setReplacementError("Message was not sent. Your draft is kept; review the chat error before retrying.");});},
            onChoose:id=>{const candidate=replacementChoices.find(choice=>choice.id===id);if(candidate)void chooseReplacement(candidate,replacementIndex);},
            onText:setReplacementText,onApply:()=>void applyReplacement(),
            onUseReply:()=>{setText(replacementText);setComposeApproval(null);setComposeOpen(true);setControlsOpen(false);requestAnimationFrame(()=>replyInputRef.current?.focus());},
            itemPicker:tile.items.length>1?<label>Requested item<select aria-label="Requested replacement item" value={replacementIndex} disabled={!!replacementBusy||replacementApplied} onChange={event=>void findReplacements(Number(event.target.value))}>{tile.items.map((item,index)=><option key={index} value={index}>{item.name}</option>)}</select></label>:undefined,
          }:undefined}
          editor={bookingAction&&tile.has_reservation&&tile.account_slug?<section className={styles.controlEditor}><header><strong>{({change:"Change rental",dates:"Reschedule",discount:"Discount",refund:"Refund"})[bookingAction]}</strong><button type="button" aria-label="Close booking editor" onClick={()=>{setBookingAction(null);setControlTab("gear");}}>×</button></header>{tile.source==="dbcinema_web"?<div className={styles.sourceActions}><p>Review this change in the DB Cinema rental workspace.</p>{dryRun?<p>Workspace disabled in test mode.</p>:<a target="_blank" rel="noopener noreferrer" href={`https://dbcinemarentals.com/admin?rental=${encodeURIComponent(tile.source_booking_id??"")}&action=${bookingAction}`}>Open {({change:"kit editor",dates:"reschedule",discount:"discount / refund review",refund:"refund review"})[bookingAction]} ↗</a>}<small>Changes keep DB Cinema’s payment and approval checks.</small></div>:<OrderEditor key={bookingAction} accountSlug={tile.account_slug} orderId={tile.thread_id} dryRun={dryRun} initialAction={bookingAction}/>}</section>:undefined}
          actions={<div>{tile.availability?.status==="conflict"&&!replacementOpen&&<button type="button" onClick={()=>void findReplacements(Math.max(0,tile.availability?.items.findIndex(item=>item.available===false)??0))}>Find replacement</button>}{tile.has_reservation&&tile.account_slug&&([["change","Change rental"],["dates","Reschedule"],["discount","Discount"],["refund","Refund"]] as const).map(([action,label])=><button type="button" key={action} onClick={()=>{setBookingAction(action);setControlTab(action==="dates"?"dates":action==="change"?"gear":"pricing");}}>{label}</button>)}</div>}
        />}
        <div className={styles.conversationContent}>
        <div className={styles.chatHeader}>
          <div className={styles.chatIdentity}>
            <ProfilePortrait src={tile.renter_image_url} name={tile.renter_name} className={styles.chatAvatar}/>
            <div className="min-w-0"><h3>{tile.renter_name}</h3><button type="button" onClick={() => setShowReviews((value) => !value)} className={styles.rating} title="View all renter reviews">{tile.renter_rating?.toFixed(1) ?? "Unrated"} <span>★</span>{tile.renter_review_count != null && <small className={styles.reviewCount}> · {tile.renter_review_count} reviews</small>}</button><div className="mt-1.5"><AccountTag slug={tile.account_slug} source={tile.source} /></div><div className={styles.identityDates}>{tile.start_date ? `${fmtDate(tile.start_date)} – ${fmtDate(tile.end_date ?? tile.start_date)}` : "Dates pending"}</div></div>
          </div>
          {!controlsOpen && <button type="button" className={styles.headerControls} aria-label="Open rental controls" title="Rental controls" onClick={()=>{setControlsOpen(true);setControlTab("gear");}}>⚙</button>}
          <button type="button" onClick={onClose} aria-label="Close conversation" data-testid="quick-reply-close" className={styles.chatClose}><span>×</span><small>Close</small></button>
          <div className={styles.chatGear}><Thumb src={tile.image_url} accent={accent} size={140} /><div className={styles.chatGearDetails}><strong>{itemLineShort(tile) || "General inquiry"}</strong><div className={styles.chatDates}>{tile.start_date ? `${fmtDate(tile.start_date)} – ${fmtDate(tile.end_date ?? tile.start_date)}` : "Dates pending"}</div><div className={styles.chatGearMeta}><QueueAvailability tile={tile} /><span>{tile.net_to_owner_gbp != null ? "Owner earns" : "Est. earn"} <b>{fmtMoney(tile.net_to_owner_gbp ?? tile.estimate_earnings_gbp) ?? "—"}</b></span></div></div></div>

          {tile.availability?.status==="conflict" && <button type="button" className={styles.replacementButton} onClick={()=>void findReplacements(Math.max(0,tile.availability?.items.findIndex(item=>item.available===false)??0))}>Find replacement <span>↗</span></button>}
          {loc && <div className={styles.chatLocation}><LocationBadge loc={loc} onOpenMap={() => setShowMap(true)} /></div>}
          {tile.renter_rating != null && tile.renter_rating < 4 && <div className="mt-2 text-[11px] text-red-300">Low-rated renter · review before accepting</div>}
        </div>

        {/* Body panel (2026-08-16) — everything below the header lives inside
            this ONE `position: relative` wrapper, so it is the containing
            block for Reviews/Map/Add-Item/Change-Dates. Those used to be
            independent `fixed inset-0` viewport overlays (some via their own
            createPortal straight to document.body) stacked at z-320/330/400,
            ABOVE the modal's own z-200/300 — so whichever was open painted
            over the ENTIRE screen, header and close button included, with no
            way back to the chat except closing the whole modal. Confined here
            (`absolute inset-0` + z-40, see each component), they can only ever
            cover this body panel — the header above it, and the fact that
            this is still "the chat with renter X", stays on screen always. */}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div className={styles.verificationStrip}><div className={styles.chatProgress}><span className={styles.sectionLabel}>Booking progress</span><StageBar t={tile} /></div>

          {/* Order editor — live items + add/remove + price + dates (has_reservation
              threads only; inquiries with no booking have nothing to edit). */}
          {tile.has_reservation && tile.account_slug && (
            <button type="button" className={styles.rentalControlsButton} aria-expanded={controlsOpen} onClick={() => {setControlsOpen(true);setControlTab("gear");}}>Rental controls <span>⚙</span></button>
          )}

          </div>
          {/* Renter reviews — confined panel, opened by tapping the stars.
              Physical stars incl. half; under-4★ highlighted. */}
          {showReviews && (
            <ReviewsOverlay
              renterName={tile.renter_name}
              rating={tile.renter_rating}
              count={tile.renter_review_count}
              reviews={reviews}
              source={tile.source}
              onClose={() => setShowReviews(false)}
            />
          )}

          {/* Map — confined panel, opened via the header's LocationBadge
              (controlled mode: onOpenMap, so it doesn't open its own
              viewport overlay). */}
          {showMap && loc && (
            <MapOverlay loc={loc} onClose={() => setShowMap(false)} confined />
          )}

        {/* Thread — flex-1 + min-h-0 so it shrinks and the compose dock below
            (with Send) is ALWAYS visible, never clipped off-screen on mobile. */}
        <div ref={messageListRef} className={styles.messages} onScroll={(event)=>{const list=event.currentTarget;followLatest.current=list.scrollHeight-list.scrollTop-list.clientHeight<64;}}>
          {thread === undefined ? (
            <SkeletonBlock className="h-24 w-full" />
          ) : thread.length === 0 ? (
            <div className="text-sm text-[#6b7280]">No messages yet.</div>
          ) : (
            thread.map((m, i) => {
              const sent = fmtMsgTime(m.timestamp);
              return (
                <div key={i} className={`${styles.message} ${m.role === "owner" ? styles.ownerMessage : ""}`}>
                  {m.role === "owner" ? <div className={styles.messageAvatar}><span>Me</span></div> : <ProfilePortrait src={tile.renter_image_url} name={tile.renter_name} className={styles.messageAvatar}/> }
                  <div
                    className={styles.bubble}
                  >
                    {m.content}
                    {m.role === "owner" && sent && <span className={styles.messageTime}>{sent} <b>✓</b></span>}
                  </div>
                  {m.role !== "owner" && sent && <span className={styles.messageTime}>{sent}</span>}
                </div>
              );
            })
          )}
          {dryRunSentMsgs.map((s, i) => (
            <div key={`dry-sent-${i}`} className="flex justify-end">
              <div
                className="max-w-[78%] rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[#eef1f5]"
                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}1a)` }}
              >
                {s} <span className="text-[10px] text-[#9aa0ad] ml-1">test ✓</span>
              </div>
            </div>
          ))}
        </div>

        {/* Compose + decisions — shrink-0 so it never gets compressed/clipped. */}
        <div className={`${styles.compose} ${composeOpen ? styles.expandedCompose : ""}`}>
          <div className={styles.composeDrawer} hidden={!composeOpen}>
          {tile.has_reservation && tile.account_slug && <button type="button" className={styles.mobileBookingButton} onClick={() => {setControlsOpen(true);setControlTab("gear");}}>Rental controls ⚙</button>}
          <div className={styles.composeHeading}><strong>Reply</strong><button type="button" onClick={() => setComposeOpen(false)} aria-label="Collapse reply composer">×</button></div>
          {(ds.canApprove || ds.canDecline || decided) && (
            <div className="flex items-center gap-2 flex-wrap">
              {decided ? (
                <span className="text-xs font-medium" style={{ color: decided === "approve" ? "#34d399" : "#f87171" }}>
                  {decided === "approve" ? "✓ Approved" : "✓ Declined"}{dryRun ? " (test)" : ""} — you can still message below.
                </span>
              ) : (
                <>
                  <span className="text-xs font-medium" style={{ color: ds.approved ? "#34d399" : "#fdba74" }}>
                    {ds.approved ? "✓ Approved earlier · awaiting payment —" : "New request —"}
                  </span>
                  {confirming ? (
                    <>
                      <span className="text-xs text-[#9aa0ad] capitalize">{confirming}?</span>
                      <button disabled={deciding} onClick={() => onDecide(confirming)} className="text-xs px-3 py-1.5 rounded-lg bg-white/20 text-white disabled:opacity-50">
                        {deciding ? "…" : "Confirm"}
                      </button>
                      <button disabled={deciding} onClick={() => setConfirming(null)} className="text-xs px-2.5 py-1.5 rounded-lg bg-white/5 text-[#8b8fa3]">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {ds.canApprove && (
                        <button onClick={() => setConfirming("approve")} className="text-xs font-semibold px-4 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 shadow-[0_2px_10px_-2px_rgba(16,185,129,0.55)]">
                          Approve
                        </button>
                      )}
                      {ds.canDecline && (
                        <button onClick={() => setConfirming("decline")} className="text-xs font-medium px-3.5 py-1.5 rounded-lg bg-white/[0.06] text-red-300 hover:bg-red-500/15">
                          Decline
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {!tile.has_reservation && <button type="button" onClick={() => pasteText(ASK_REQUEST_TEXT)} className="mb-1 rounded-full border border-amber-400/25 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-200">📩 Ask to request</button>}

          {/* AI draft — its OWN box. Tap to copy it into the message box below;
              it never auto-fills the compose box and is never sent on its own. */}
          {draftReview && <div role="alert" aria-label="Reply needs review" className="rounded-xl border border-amber-400/30 bg-amber-500/[0.08] p-3 text-xs text-amber-100">
            <p className="font-semibold">Reply needs your review</p>
            <p className="mt-1">{draftReviewSummary(draftReview)} No reply was saved. Check the facts, write your reply, or retry the assistant.</p>
            {draftReview.flags.length > 0 && <details className="mt-2">
              <summary className="cursor-pointer">Why it was withheld</summary>
              <ul className="mt-1 space-y-1">{draftReview.flags.map((flag, i) => <li key={i}>{flag.detail}</li>)}</ul>
            </details>}
          </div>}
          {(draft || drafting) && (
            <div className="rounded-xl border border-violet-400/25 bg-violet-500/[0.07]">
              <div className="flex items-center gap-2 px-3 pt-2 pb-1">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-violet-300/90">
                  ✨ AI draft
                </span>
                {draftConfidence != null && !drafting && (
                  <span
                    title="Draft confidence — lower means the AI flagged something worth a closer look"
                    className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${
                      draftConfidence >= 0.75
                        ? "bg-emerald-500/15 text-emerald-300"
                        : draftConfidence >= 0.4
                          ? "bg-amber-500/15 text-amber-300"
                          : "bg-rose-500/15 text-rose-300"
                    }`}
                  >
                    {Math.round(draftConfidence * 100)}%
                  </span>
                )}
                {draft && !drafting && (
                  <span className="text-[10px] text-violet-200/60">tap to use ↓</span>
                )}
                <button
                  onClick={onGenerate}
                  disabled={drafting}
                  className="ml-auto text-[10px] px-2 py-0.5 rounded-md bg-white/[0.06] text-[#c5cad3] hover:bg-white/[0.12] disabled:opacity-50"
                >
                  {drafting ? "Drafting…" : "↻ Redraft"}
                </button>
              </div>
              {draft && (
                <button
                  type="button"
                  onClick={onCopyDraft}
                  title="Copy this draft into the message box"
                  className={`block w-full text-left px-3 pb-2.5 ${
                    draft.length > 400 ? "text-[12px]" : draft.length > 240 ? "text-[13px]" : "text-sm"
                  } leading-relaxed text-[#dcd6f0] hover:text-white whitespace-pre-wrap max-h-[28vh] overflow-y-auto`}
                >
                  {draft}
                </button>
              )}
              {/* Draft-guard flags: items the AI flagged for my review (amber)
                  and the leaks it auto-cleaned (muted). Never blocks — informs. */}
              {draft && !drafting && liveTile?.ai_draft_evidence && <details className="px-3 pb-2 text-xs text-slate-400">
                <summary className="cursor-pointer">Draft evidence · {liveTile.ai_draft_evidence.stage}</summary>
                <p className="mt-1">Model: {liveTile.ai_draft_evidence.model_id}</p>
                {liveTile.ai_draft_evidence.stock.map((r, i) => <p key={i}>{r.item} · {r.quantity} requested · {r.start_date}–{r.end_date} · {r.available === true ? "available" : r.available === false ? "unavailable" : "unknown"} · {r.free_units ?? "unknown"} free · checked {new Date(r.checked_at).toLocaleTimeString()}</p>)}
                <p className="mt-1">Stock results apply only to the item, quantity and dates shown. Review prices, kit and recommendations before sending.</p>
              </details>}
              {draft && !drafting && draftFlags.length > 0 && (() => {
                const review = draftFlags.filter((f) => f.action === "flagged");
                const auto = draftFlags.filter((f) => f.action !== "flagged");
                return (
                  <div className="px-3 pb-2.5 border-t border-violet-400/15 pt-1.5">
                    <button
                      type="button"
                      onClick={() => setShowFlags((s) => !s)}
                      className="flex items-center gap-2 text-[10px]"
                    >
                      {review.length > 0 && (
                        <span className="font-semibold text-amber-300">
                          ⚠ {review.length} to review
                        </span>
                      )}
                      {auto.length > 0 && (
                        <span className="text-[#8a8f9c]">
                          {auto.length} auto-fixed
                        </span>
                      )}
                      <span className="text-violet-200/50">
                        {showFlags ? "▴" : "▾"}
                      </span>
                    </button>
                    {showFlags && (
                      <ul className="mt-1.5 space-y-1">
                        {review.map((f, i) => (
                          <li
                            key={`r${i}`}
                            className="text-[11px] leading-snug text-amber-200/90"
                          >
                            ⚠ {f.detail}
                          </li>
                        ))}
                        {auto.map((f, i) => (
                          <li
                            key={`a${i}`}
                            className="text-[11px] leading-snug text-[#7f8694]"
                          >
                            ✓ {f.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })()}
            </div>
          )}


          </div>
          {copiedDraftStale && <div role="alert" className="mb-2 rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 text-xs text-amber-100">
            The copied AI reply is out of date. Your text is kept. Clear it to write your reply, or clear it and copy a fresh draft.
          </div>}
          <div className={styles.composerTools} aria-label="Reply shortcuts">
            <button type="button" onClick={() => {setComposeOpen(true);void onGenerate();}} disabled={drafting} title="Draft a reply from this conversation" className={styles.aiButton}><span>✦</span>{drafting ? "Drafting…" : draftReview ? "Retry reply" : <><span>Draft reply</span></>}</button>
            <div className={styles.snippetButtons}>
              {([["location","Location"],["times","Times"],["delivery","Delivery info"]] as const).map(([key,label]) => <button key={key} type="button" onClick={() => pasteQuickSlot(key)} title={`Insert ${label.toLowerCase()} for ${accountLabel(cannedAccountSlug)}`}>{label}</button>)}
            </div>
            <button type="button" onClick={() => openQuickSlot("location")} title="Customize these quick replies for this account" className={styles.customizeButton}><span aria-hidden="true">⚙</span><span className="sr-only">Customize</span></button>
          </div>
          {quickSlot && createPortal(<div className={styles.quickPanel} role="dialog" aria-label="Account quick replies" style={viewport ? {top:viewport.top+viewport.height*.18,height:viewport.height*.64,maxHeight:viewport.height*.64} : undefined}>
            <div className="mb-2 flex items-center justify-between"><div><div className="text-sm font-semibold text-white">Quick replies</div><small className={styles.quickAccount}>{accountLabel(cannedAccountSlug)}</small></div><button type="button" onClick={() => setQuickSlot(null)} aria-label="Close quick reply editor" className="h-8 w-8 rounded-lg text-xl text-[#9aa0ad] hover:bg-white/10">×</button></div>
            <div className="mb-2 flex gap-1">{([ ["location","Location"], ["times","Times"], ["delivery","Delivery"] ] as const).map(([key,label]) => <button key={key} type="button" onClick={() => openQuickSlot(key)} className={`rounded-full px-2.5 py-1 text-[10px] ${quickSlot===key?"bg-white/15 text-white":"bg-white/[0.04] text-[#969eae]"}`}>{label}</button>)}</div>
            <textarea disabled={quickSaving} value={quickDraft} onChange={(e) => setQuickDraft(e.target.value)} rows={4} placeholder="Write account-specific text…" className="w-full rounded-xl border border-white/10 bg-black/30 p-3 text-[15px] text-white placeholder:text-[#697080] focus:outline-none focus:border-white/25" />
            <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-[#7d8492]">Saved for {accountLabel(cannedAccountSlug)}</span><button type="button" onClick={() => void saveQuickPreset()} disabled={quickSaving||!quickDraft.trim()} className="rounded-full bg-white px-4 py-2 text-[11px] font-semibold text-[#17191f] disabled:opacity-40">{quickSaving ? "Saving…" : "Save & insert"}</button></div>
            {quickError && <p role="alert" className="mt-3 text-xs text-amber-200">{quickError}</p>}
          </div>,document.body)}
          <div className={styles.composeInput}>
            <button type="button" onClick={() => setComposeOpen((open) => !open)} className={styles.attachButton} aria-label="Write reply or insert text file" title="Write a reply or insert a text file"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m9 17 8-8a3 3 0 0 0-4-4L5 13a5 5 0 0 0 7 7l8-8a7 7 0 0 0-10-10L3 9"/><path d="m7 15 8-8"/></svg></button>
            <textarea ref={replyInputRef} aria-label={`Reply to ${tile.renter_name}`} value={text} onChange={(e) => {setText(e.target.value);if(!e.target.value.trim())setComposeApproval(null);}} placeholder="Write a reply…" rows={1} className="w-full resize-none bg-transparent px-3 py-2 text-[16px] leading-relaxed text-[#eef1f5] placeholder-[#697080] focus:outline-none" />
            <button type="button" onClick={() => {if(!text.trim()){setComposeOpen(true);replyInputRef.current?.focus();return;}void onSend();}} disabled={sending || copiedDraftStale} className={styles.sendButton}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m21 3-7 18-4-7-7-4 18-7Z"/><path d="m10 14 6-6"/></svg>{sending ? "Sending…" : "Send"}</button>          </div>
          <div className={styles.fileInsert} hidden={!composeOpen}><button type="button" onClick={() => fileRef.current?.click()}>Insert text file</button><input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={async(event) => {const file=event.target.files?.[0];if(!file)return;if(file.size>1_000_000){setNote("Text files must be smaller than 1 MB.");return;}pasteText(await file.text());event.target.value="";}} /></div>
          {note && (
            <div className={`text-xs ${note.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>{note}</div>
          )}
        </div>
        </div>
        </div>
      </div>
    </div>,
    dockTarget ?? document.body,
  );
}

// ── widget ────────────────────────────────────────────────────────

export function ReplyInbox() {
  const { activeAccountSlug } = useAccount();
  const loadDbCinemaInbox = useAction(dbCinemaInboxRef);
  // Persisted "count pending bookings in the double-booking check" toggle.
  const settings = useQuery(api.settings.get, {});
  const updateSettings = useMutation(api.settings.update);
  const includePending = settings?.availability_include_pending ?? false;
  const queue = useStableQuery(api.replyInbox.getReplyQueue, {
    accountSlug: activeAccountSlug ?? undefined,
    // High cap: renter inquiries on cancelled/finished orders now surface too,
    // so the awaiting-me backlog is much larger — don't truncate it away.
    limit: 200,
    // Hard 5-day window on REAL activity — nothing older shows, in any pass
    // (Daniel, 2026-06-28 "don't show me tiles/messages older than 5 days").
    withinDays: 5,
    messagesWithinDays: 5,
    includePending,
  }) as ReplyTileData[] | undefined;
  const loadPortraits = useAction(makeFunctionReference<"action">("renter_trust:profilePhotos"));
  const [portraits,setPortraits] = useState<Record<string,string|null>>({});
  const portraitBatch = (queue ?? []).filter(row => !row.renter_image_url && !(row.thread_id in portraits)).slice(0,12).map(row => row.thread_id).join("|");
  useEffect(() => {
    if (!portraitBatch) return;
    let alive=true;
    void loadPortraits({thread_ids:portraitBatch.split("|")}).then(rows => {if(alive)setPortraits(old=>({...old,...Object.fromEntries(rows.map((row:any)=>[row.thread_id,row.image_url]))}));}).catch(()=>{if(alive)setPortraits(old=>({...old,...Object.fromEntries(portraitBatch.split("|").map(id=>[id,null]))}));});
    return ()=>{alive=false;};
  },[portraitBatch,loadPortraits]);
  const withPortrait = (row: ReplyTileData): ReplyTileData => row.renter_image_url ? row : {...row,renter_image_url:portraits[row.thread_id]??null};
  const [dbCinemaRows, setDbCinemaRows] = useState<ReplyTileData[]>([]);
  const [dbCinemaLoadFailed, setDbCinemaLoadFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const rows = await loadDbCinemaInbox({});
        if (alive) {
          setDbCinemaRows(rows as ReplyTileData[]);
          setDbCinemaLoadFailed(false);
        }
      } catch {
        if (alive) setDbCinemaLoadFailed(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadDbCinemaInbox]);

  const [openId, setOpenId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);
  const [canDock, setCanDock] = useState(false);
  const [dockTarget, setDockTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = widgetRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCanDock(entry.contentRect.width >= 1050));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const openThread = (tile: ReplyTileData, reviews = false) => {
    openCacheRef.current = tile;
    setReviewId(reviews ? tile.thread_id : null);
    setOpenId(tile.thread_id);
  };

  const closeModal = useCallback(() => setOpenId(null), []);
  // Last-known row for the open thread, so the overlay survives the thread
  // leaving the queue after a send/approve (see `open` below).
  const openCacheRef = useRef<ReplyTileData | null>(null);
  const [acted, setActed] = useState<Set<string>>(new Set());
  const [dbDismissedAt, setDbDismissedAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  // Renters with a pickup/return within ±60 min — the pinned current-rental bar. Bump
  // `_tick` each minute (via `now`) so the time-window query re-runs live.
  const handoffs = useQuery(api.replyInbox.getImminentHandoffs, {
    accountSlug: activeAccountSlug ?? undefined,
    _tick: Math.floor(now / 60000),
  }) as
    | Array<{ thread_id: string | null; renter_name: string; items: string[]; kind: "pickup" | "return"; date: string; time: string; minutes_away: number }>
    | undefined;
  const dbHandoffs = dbCinemaRows.filter(tile => ["confirmed", "active", "ongoing", "returned", "completed"].includes((tile.booking_status ?? tile.status ?? "").toLowerCase())).flatMap((tile) => ([
    { timestamp: tile.start_at, kind: "pickup" as const },
    { timestamp: tile.end_at, kind: "return" as const },
  ]).flatMap(({ timestamp, kind }) => {
    if (!timestamp) return [];
    const minutes = Math.round((timestamp - now) / 60_000);
    if (Math.abs(timestamp - now) > 3_600_000) return [];
    const when = new Date(timestamp);
    return [{
      thread_id: tile.thread_id,
      renter_name: tile.renter_name,
      items: tile.items.map((item) => item.name),
      kind,
      date: when.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      time: when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      minutes_away: minutes,
    }];
  }));
  const currentHandoffs = [...(handoffs ?? []), ...dbHandoffs].filter((entry, index, all) => all.findIndex(other => other.thread_id === entry.thread_id && other.kind === entry.kind) === index);
  const [mounted, setMounted] = useState(false);
  // Default to "To reply" so chats I already answered (owner spoke last) DON'T
  // clutter the view — only new requests + renters waiting on me.
  const [filter, setFilter] = useState<"todo" | "requests" | "all">("todo");
  const [sortBy, setSortBy] = useState<QuickReplySort>("priority");
  const testMode = false;
  const [replacementRequest, setReplacementRequest] = useState({thread: "", revision: 0});
  const [showManager, setShowManager] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    try {
      const restored: Record<string, number> = {};
      for (let index = 0; index < window.localStorage.length; index++) {
        const key = window.localStorage.key(index);
        if (!key?.startsWith("rm-quick-reply-dismissed:dbcinema:")) continue;
        const value = Number(window.localStorage.getItem(key));
        if (Number.isFinite(value)) restored[key.slice("rm-quick-reply-dismissed:".length)] = value;
      }
      setDbDismissedAt(restored);
    } catch { /* browser storage can be disabled */ }
  }, []);
  // Yield to a tapped notification: when the SW asks to deep-link to a thread,
  // close this widget's own modal so the deep-link host (z-[300]) is the only
  // chat showing — otherwise a stale widget modal would sit behind it.
  useEffect(() => {
    const yieldModal = () => setOpenId(null);
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string } | undefined)?.type === "deep-link") yieldModal();
    };
    const sw =
      typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    sw?.addEventListener("message", onMsg);
    // Also yield when a notification is opened from the bell dropdown (a URL nav,
    // which sends no SW message) — the bell dispatches this so the deep-link host
    // is the ONLY chat showing, never a stale widget tile behind it.
    if (typeof window !== "undefined")
      window.addEventListener("rm-deeplink", yieldModal);
    return () => {
      sw?.removeEventListener("message", onMsg);
      if (typeof window !== "undefined")
        window.removeEventListener("rm-deeplink", yieldModal);
    };
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onActed = (id: string) => setActed((p) => new Set(p).add(id));
  const all = [...(queue ?? []), ...dbCinemaRows].map(withPortrait).filter((t) => {
    if (acted.has(t.thread_id)) return false;
    const dismissedAt = dbDismissedAt[t.thread_id];
    return t.source !== "dbcinema_web" || dismissedAt == null || t.last_activity_at > dismissedAt;
  });
  // A request still "needs me" only until I've replied/approved (owner-last).
  const pendingRequest = (t: ReplyTileData) =>
    t.is_request && !isResolvedClosed(t);
  const requests = all.filter(pendingRequest).length;
  const needsReply = (t: ReplyTileData) => t.last_sender === "renter" && !!t.preview.trim();
  const todo = all.filter(needsReply).length;
  const visible = all.filter((t) =>
    filter === "all" ? true : filter === "requests" ? pendingRequest(t) : needsReply(t),
  );
  const sorted = [...visible].sort((a,b)=>compareQuickReplies(a,b,sortBy,now));
  const duplicateIds = quickReplyDuplicateIds(sorted.filter(pendingRequest));
  const displayRows = [...sorted.filter((row) => !duplicateIds.has(row.thread_id)), ...sorted.filter((row) => duplicateIds.has(row.thread_id))];
  // `open` resolves against the RAW queue (not `all`/visible) so approving or
  // declining a card — which drops it from `all` via onActed — does NOT close
  // the chat overlay. Sending ALSO drops the thread from the queue (owner now
  // spoke last), which used to unmount the modal = the "auto-close on send" bug.
  // Cache the last-known row and fall back to it, so the overlay stays open
  // until YOU close it (× ) or tap a notification. (Daniel, 2026-07-03)
  const openFromCheck = useQuery(api.replyInbox.getThreadById, openId && !openId.startsWith("dbcinema:") ? {thread_id:openId} : "skip") as ReplyTileData | null | undefined;
  const openFromQueue = openId
    ? [...(queue ?? []), ...dbCinemaRows].find((t) => t.thread_id === openId) ?? null
    : null;
  if (openFromQueue) openCacheRef.current = openFromQueue;
  const open = openId
    ? openFromQueue ?? openFromCheck ??
      (openCacheRef.current?.thread_id === openId ? openCacheRef.current : null)
    : null;

  return (
    <Card className={styles.widget}>
      <div ref={widgetRef} className={styles.workspace}>
      <style>{`
        @keyframes rgGlow { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 18px -4px var(--u); } }
        @keyframes rgBlink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0.3; } }
        @keyframes rgMoney { 0%,100% { box-shadow: 0 0 18px -8px rgba(251,191,36,0.55); } 50% { box-shadow: 0 0 30px -4px rgba(251,191,36,0.95); } }
        /* Imminent handoff cards (±60min pickup/return) — a slow, gentle
           breathing glow, deliberately calmer than rgBlink's hard 1s blink
           (that one means "overdue/urgent"; this one means "happening soon"). */
        @keyframes rgHandoffPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(251,146,60,0), inset 0 1px 0 rgba(255,255,255,0.05); border-color: rgba(251,146,60,0.25); }
          50% { box-shadow: 0 0 22px -3px rgba(251,146,60,0.65), inset 0 1px 0 rgba(255,255,255,0.05); border-color: rgba(251,146,60,0.55); }
        }
      `}</style>
      <div className={styles.titleRow}><h2>Quick Reply</h2>{dbCinemaLoadFailed && <span className="text-amber-300">DB Cinema offline</span>}</div>
      <div className={styles.toolbar}>
        {([{k:"todo",label:"To reply",n:todo},{k:"requests",label:"Requests",n:requests},{k:"all",label:"All",n:all.length}] as const).map((item) => <button type="button" key={item.k} title={item.k === "todo" ? "Renter messages waiting for your reply" : item.k === "requests" ? "Booking requests awaiting your decision, including requests you have replied to" : "All recent conversations"} onClick={() => {setFilter(item.k);if(item.k === "all")setSortBy("priority");}} className={filter===item.k ? styles.activeFilter : ""}>{filter===item.k && <i />}{item.label}</button>)}
        <select title="Priority combines earnings, waiting time and stock. Other choices sort independently." value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} aria-label="Sort conversations"><option value="priority">Priority</option><option value="earnings">Highest earnings</option><option value="waiting">Longest wait</option><option value="newest">Newest activity</option><option value="oldest">Oldest request</option></select>
        <button type="button" onClick={() => setShowManager(true)}>▤ Quick texts</button>
        <button type="button" onClick={() => void updateSettings({availability_include_pending:!includePending})} aria-pressed={includePending} className={styles.toggle}><i data-on={includePending} />Pending {includePending ? "on" : "off"}</button>
      </div>
      <div className={`${styles.split} ${canDock ? styles.withDock : ""} ${canDock && openId ? styles.expandedChat : ""}`}><div className={styles.inbox}>
      {currentHandoffs.length > 0 && <div className={styles.handoffRail}><div className={styles.handoffIntro}><span>◷</span><div><strong>Next 60 min</strong><p>Rentals within 1 hour<br />before or after.</p></div></div><div className={styles.handoffs}>{currentHandoffs.map((h) => {
        const row = all.find((candidate) => candidate.thread_id === h.thread_id);
        return <button type="button" key={`${h.thread_id}-${h.kind}-${h.date}-${h.time}`} disabled={!h.thread_id} onClick={() => {if(row)openThread(row);else if(h.thread_id){openCacheRef.current=null;setReviewId(null);setOpenId(h.thread_id);}}} className={styles.handoffCard} aria-label={`${h.kind} with ${h.renter_name}`} title={h.renter_name}>
          <Thumb src={row?.image_url ?? null} accent={row ? tileAccent(row) : "#86baff"} size={75} /><div><span className={h.kind === "pickup" ? styles.pickup : styles.return}>● {h.kind === "pickup" ? "PICKUP" : "RETURN"} {h.minutes_away===0 ? "now" : h.minutes_away>0 ? `${h.minutes_away}m` : `${-h.minutes_away}m ago`}</span><div className={styles.handoffIdentity}>{row?.renter_image_url && <img src={row.renter_image_url} alt={h.renter_name} />}<div>{row ? <AccountTag slug={row.account_slug} source={row.source} /> : <strong>{h.renter_name}</strong>}<small>{row?.renter_rating != null ? <>{row.renter_rating.toFixed(1)} <b>★</b></> : h.items.join(", ")}</small></div></div></div><span className={styles.handoffArrow}>›</span>
        </button>;
      })}</div></div>}

      <OwnerChecksPanel accountSlug={activeAccountSlug ?? undefined} onOpen={setOpenId} />
      <div className={styles.table}><div className={styles.tableHeader}>{["Renter","Last message","Account / Gear","Dates","Wait","Est. earn","Availability","Progress"].map((label) => <span key={label}>{label}</span>)}</div>
      {queue === undefined ? (
        <div className="grid grid-cols-1 gap-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-44 w-full rounded-2xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          message={
            filter === "requests"
              ? "No pending requests"
              : filter === "todo"
                ? "All caught up — nobody waiting on a reply"
                : "Nothing here"
          }
          icon="✅"
        />
      ) : (
        <div className={styles.rows}>
          {displayRows.map((tile) => (
            <ReplyCard
              key={tile.thread_id}
              tile={tile}
              now={now}
              onOpen={() => openThread(tile)}
              onReviews={() => openThread(tile, true)}
              onReplacement={() => {openThread(tile);setReplacementRequest(value => ({thread: tile.thread_id, revision: value.revision + 1}));}}
              selected={openId === tile.thread_id}
              onActed={onActed}
              dryRun={testMode}
              duplicate={duplicateIds.has(tile.thread_id)}
            />
          ))}
        </div>
      )}
      </div></div>
      {canDock && <div ref={setDockTarget} className={styles.chatDock}>{!open && <div className={styles.emptyChat}><span>▤</span><h3>Your conversations, in focus</h3><p>Select a renter to see the request and reply.</p></div>}</div>}
      </div>
      {mounted && open && (
        <ReplyModal key={open.thread_id} tile={withPortrait(open)} onClose={closeModal} onActed={onActed} dryRun={testMode} dockTarget={canDock ? dockTarget : null} initialShowReviews={reviewId === open.thread_id} initialReplacementRequest={replacementRequest.thread === open.thread_id ? replacementRequest.revision : 0} />
      )}
      {mounted && showManager && (
        <CannedManager accountSlug={activeAccountSlug} onClose={() => setShowManager(false)} />
      )}
      </div>
    </Card>
  );
}
