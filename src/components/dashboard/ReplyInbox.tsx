"use client";
/**
 * Reply Inbox (2026-06-22 v3) — cross-account "renters waiting on me".
 *
 * Minimal card grid: each card = item thumbnail + renter ★ + account + booking/
 * request context, with a large "unanswered for" timer. Urgency: calm < 20h →
 * amber ≥ 20h → red ≥ 30h → blinking red ≥ 48h. Pending rental REQUESTs always
 * surface with Approve / Decline (live, verified `accept`/`deny` verbs, gated by
 * ALLOW_MANUAL_ORDER_ACTIONS). Click a card → a body-portaled modal (escapes the
 * widget's clipping) with the full thread + AI draft + Send.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../convex/_generated/dataModel";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { accountAccent, accountLabel } from "@/lib/account-theme";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

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
type RenterReviewsResult = { reviews: RenterReview[]; lowCount: number; fetched: boolean };

// Order-edit + online-listings (new convex modules) — referenced by name so
// `next build`'s typecheck stays green against the committed (lagging) _generated
// api, same pattern as canned_responses / renter_reviews above.
const getOrderStateRef = makeFunctionReference<"action">("order_edit:getOrderState");
const previewPriceRef = makeFunctionReference<"action">("order_edit:previewPrice");
const itemUnavailRef = makeFunctionReference<"action">("order_edit:itemUnavailableDates");
const addItemRef = makeFunctionReference<"action">("order_edit:addItem");
const removeOrderItemRef = makeFunctionReference<"action">("order_edit:removeItem");
const setPriceRef = makeFunctionReference<"action">("order_edit:setPrice");
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
  product_id: number;
  name: string;
  image: string | null;
  daily_price: number | null;
  is_published: boolean;
  public_url: string | null;
};
type WriteOut = { status: "sent" | "skipped" | "failed"; reason?: string; httpStatus?: number; error?: string };

interface RichItem {
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
  available: boolean;
}
interface TileAvailability {
  status: "available" | "conflict";
  include_pending: boolean;
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
  account_slug: string | null;
  renter_name: string;
  renter_rating: number | null;
  renter_review_count: number | null;
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
  last_msg_at: number;
  preview: string;
  has_draft: boolean;
  ai_draft_text: string | null;
  ai_draft_confidence: number | null;
  ai_draft_flags: DraftFlag[] | null;
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
function MapOverlay({ loc, onClose }: { loc: TileLocation; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const title = [loc.street, loc.zip].filter(Boolean).join(", ") || loc.label || "Location";
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 p-3"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl overflow-hidden bg-[#13151a] border border-white/10 shadow-2xl"
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
            className="w-full h-[60vh] border-0"
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

function LocationBadge({ loc, compact }: { loc: TileLocation; compact?: boolean }) {
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
          setShowMap(true);
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
      {showMap && <MapOverlay loc={loc} onClose={() => setShowMap(false)} />}
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
  const canApprove = t.can_accept ?? t.is_request;
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
  if (!t.has_reservation) return null;
  const cancelled = isResolvedClosed(t);
  const idx = stageIndex(t);
  const accent = accountAccent(t.account_slug);
  return (
    <div className="flex flex-col gap-1 pt-0.5">
      <div className="flex items-center gap-[3px]">
        {RENTAL_STAGES.map((_, i) => (
          <div
            key={i}
            className="h-[3px] flex-1 rounded-full transition-colors"
            style={{
              background: cancelled
                ? "rgba(248,113,113,0.30)"
                : i <= idx
                  ? accent
                  : "rgba(255,255,255,0.10)",
            }}
          />
        ))}
      </div>
      <span className="text-[9px] uppercase tracking-[0.08em] text-[#7a8190] leading-none">
        {cancelled ? "Cancelled" : `${RENTAL_STAGES[idx]} · ${idx + 1}/${RENTAL_STAGES.length}`}
      </span>
    </div>
  );
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
  if (h < 24) return `${h}h`;
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
function shortListing(name: string): string {
  const bySep = name.split(/\s*[|–—]\s*| - /)[0].trim();
  let base = bySep.length >= 6 && bySep.length < name.length ? bySep : name;
  const cap = Math.max(28, Math.ceil(name.length / 2));
  if (base.length > cap) {
    const cut = base.slice(0, cap);
    const lastSpace = cut.lastIndexOf(" ");
    base = (lastSpace > 16 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  }
  return base;
}
/** Modal item line — shortened listing names (overlay stays compact). */
function itemLineShort(t: ReplyTileData): string {
  const names = t.items.map((i) => (i.qty > 1 ? `${i.qty}× ${shortListing(i.name)}` : shortListing(i.name)));
  const extra = t.item_count > t.items.length ? ` +${t.item_count - t.items.length}` : "";
  return names.join(", ") + extra;
}

/**
 * Double-booking badge. Green when the requested set is free for the dates; red
 * when accepting would over-book a unit (shows the tightest item). `incl.
 * pending` tag appears when not-yet-confirmed bookings were counted.
 */
function AvailabilityBadge({ a, compact }: { a: TileAvailability; compact?: boolean }) {
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
  if (t.start_date && t.end_date) {
    const s = new Date(`${t.start_date}T00:00:00`).getTime();
    const e = new Date(`${t.end_date}T00:00:00`).getTime();
    if (!isNaN(s) && !isNaN(e) && e >= s) return Math.max(1, Math.round((e - s) / 86400000));
  }
  return t.estimate_days;
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
  onClose,
}: {
  renterName: string;
  rating: number | null;
  count: number | null;
  reviews: RenterReviewsResult | undefined;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[330] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[80vh] flex flex-col rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden"
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
          {reviews === undefined ? (
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
                    {r.created_at && (
                      <span className="text-[10px] text-[#6b7280] ml-auto shrink-0">
                        {new Date(r.created_at).toLocaleDateString("en-GB")}
                      </span>
                    )}
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
    </div>,
    document.body,
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
function Stars({ rating, count, size = 12 }: { rating: number | null; count: number | null; size?: number }) {
  if (rating == null) return <span className="text-[11px] text-[#64748b]">no rating</span>;
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

function AccountTag({ slug }: { slug: string | null }) {
  const accent = accountAccent(slug);
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold px-1.5 py-[3px] rounded-md lowercase tracking-wide"
      style={{ background: `${accent}22`, color: accent }}
    >
      {accountLabel(slug)}
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
}: {
  tile: ReplyTileData;
  now: number;
  onOpen: () => void;
  onActed: (id: string) => void;
  dryRun: boolean;
}) {
  const aw = awaitingMe(tile);
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
    <div
      onClick={onOpen}
      className="group relative cursor-pointer rounded-2xl border bg-gradient-to-b from-[#171a21] to-[#12151c] hover:from-[#1a1e27] hover:to-[#14181f] transition-colors p-4 pl-[18px] flex flex-col gap-2.5"
      style={{
        borderColor: u?.glow ? `${u.color}40` : "rgba(255,255,255,0.07)",
        boxShadow: u?.glow
          ? `inset 0 1px 0 rgba(255,255,255,0.04), 0 0 0 1px ${u.color}22, 0 0 26px -10px ${u.color}66`
          : "inset 0 1px 0 rgba(255,255,255,0.04), 0 10px 24px -16px rgba(0,0,0,0.55)",
      }}
    >
      {/* account-colour identity strip */}
      <div
        className="absolute left-0 top-3.5 bottom-3.5 w-[3px] rounded-r-full"
        style={{ background: accountAccent(tile.account_slug) }}
      />
      {/* × close — hides this thread until the renter messages again */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        title="Close — hides this thread until the renter messages again"
        aria-label="Close thread"
        className="absolute top-1.5 right-1.5 z-10 w-7 h-7 sm:w-6 sm:h-6 rounded-full flex items-center justify-center text-[#9aa0ad] sm:text-[#7b8190] bg-white/[0.07] sm:bg-[#12151c]/80 ring-1 ring-white/10 sm:ring-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-white/12 hover:text-[#eef1f5] transition-all"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div className="flex gap-3">
        <Thumb src={tile.image_url} accent={accountAccent(tile.account_slug)} size={46} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-1.5">
            <span className="text-[14px] font-semibold text-[#f1f3f5] truncate leading-tight min-w-0">
              {tile.renter_name}
            </span>
            {tile.renter_rating != null && (
              <span className="shrink-0 mt-[3px]">
                <Stars rating={tile.renter_rating} count={null} size={10} />
              </span>
            )}
            {tile.renter_blacklisted && (
              <span className="text-[9px] px-1 rounded bg-red-500/20 text-red-400 mt-0.5">BL</span>
            )}
            {!tile.renter_blacklisted && tile.renter_flagged && (
              <span
                title="Flagged renter"
                className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-400 mt-0.5"
              >
                ⚑
              </span>
            )}
            <span className="ml-auto flex flex-col items-end leading-none flex-shrink-0 transition-[margin] mr-7 sm:mr-0 sm:group-hover:mr-6">
              {u ? (
                <>
                  <span
                    className="text-[18px] font-bold tabular-nums leading-none"
                    style={{ color: u.color, animation: u.blink ? "rgBlink 1s step-end infinite" : undefined }}
                  >
                    {waited(tile.last_renter_msg_at, now)}
                  </span>
                  <span
                    className="text-[9px] uppercase tracking-[0.08em] mt-1"
                    style={{ color: `${u.color}b3` }}
                  >
                    {u.caption}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[13px] font-semibold text-emerald-400/90 leading-none">✓ replied</span>
                  <span className="text-[9px] uppercase tracking-[0.08em] text-[#6b7280] mt-1.5">
                    awaiting renter
                  </span>
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <AccountTag slug={tile.account_slug} />
            {tile.renter_review_count != null && (
              <span className="text-[10px] text-[#64748b]">
                {tile.renter_review_count} review{tile.renter_review_count === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>

      <span
        className="self-start text-[11px] font-medium px-2 py-[3px] rounded-full"
        style={
          tile.is_request
            ? {
                background: "rgba(251,191,36,0.14)",
                color: "#fcd34d",
                boxShadow: "inset 0 0 0 1px rgba(251,191,36,0.20)",
              }
            : { background: "rgba(255,255,255,0.06)", color: "#9aa0ad" }
        }
      >
        {statusText(tile)}
      </span>

      <StageBar t={tile} />

      {itemLine(tile) && (
        <div className="text-[13px] text-[#cbd0d8] truncate">{itemLine(tile)}</div>
      )}
      {tile.has_reservation && contextLine(tile) && (
        <div className="text-[11px] text-[#7a8190]">{contextLine(tile)}</div>
      )}
      {tile.preview && (
        <div className="text-[12px] text-[#8b92a0] line-clamp-2">“{tile.preview}”</div>
      )}
      {tile.location && <LocationBadge loc={tile.location} compact />}
      {(tile.net_to_owner_gbp != null || tile.estimate_earnings_gbp != null) && (
        <div className="self-start">
          <MoneyHeadline tile={tile} compact />
        </div>
      )}
      {tile.availability && (
        <div className="pt-0.5">
          <AvailabilityBadge a={tile.availability} compact />
        </div>
      )}

      <div className="flex items-center gap-2 mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onOpen}
          className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.06] text-[#cbd5e1] hover:bg-white/[0.12] transition-colors"
        >
          💬 Reply{tile.has_draft ? " ✨" : ""}
        </button>
        {optimistic ? (
          <span
            className="ml-auto text-[11px] font-semibold"
            style={{ color: optimistic === "approve" ? "#34d399" : "#f87171" }}
          >
            {optimistic === "approve" ? "✓ Approved" : "✓ Declined"}
            {dryRun ? " (test)" : ""}
          </span>
        ) : (ds.canApprove || ds.canDecline) &&
          (confirming ? (
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-[#9aa0ad] capitalize">{confirming}?</span>
              <button
                disabled={busy}
                onClick={() => act(confirming)}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-white/20 text-white disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                disabled={busy}
                onClick={() => setConfirming(null)}
                className="text-xs px-2 py-1.5 rounded-lg bg-white/5 text-[#8b8fa3]"
              >
                ✗
              </button>
            </div>
          ) : (
            <div className="ml-auto flex items-center gap-1.5">
              {ds.approved && (
                <span className="text-[11px] font-medium text-emerald-400">✓ Approved</span>
              )}
              {ds.canApprove && (
                <button
                  onClick={() => setConfirming("approve")}
                  className="text-[12px] font-medium px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 shadow-[0_2px_8px_-2px_rgba(16,185,129,0.5)]"
                >
                  Approve
                </button>
              )}
              {ds.canDecline && (
                <button
                  onClick={() => setConfirming("decline")}
                  className="text-[12px] font-medium px-3 py-1.5 rounded-lg bg-white/[0.06] text-red-300 hover:bg-red-500/15"
                >
                  Decline
                </button>
              )}
            </div>
          ))}
      </div>
      {note && (
        <div className={`text-[10px] ${note.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>{note}</div>
      )}
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

/** Manage overlay — see/add/edit/delete each account's saved auto-replies. */
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
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden">
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
          <button onClick={onClose} className="ml-auto text-[#8b8fa3] hover:text-white text-2xl leading-none">×</button>
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
            placeholder="The message to paste + send (e.g. delivery details, location, bank info)…"
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
    .filter((l) => tokens.every((t) => l.name.toLowerCase().includes(t)))
    .slice(0, 60);
  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden"
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
                  <div className="text-[12.5px] text-[#e6e9ef] truncate">{l.name}</div>
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
    </div>,
    document.body,
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

  return createPortal(
    <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/70 backdrop-blur-sm p-3" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#101216] shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
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
    </div>,
    document.body,
  );
}

function OrderEditor({
  accountSlug,
  orderId,
  dryRun,
}: {
  accountSlug: string;
  orderId: string;
  dryRun: boolean;
}) {
  const accent = accountAccent(accountSlug);
  const getState = useAction(getOrderStateRef);
  const preview = useAction(previewPriceRef);
  const getUnavail = useAction(itemUnavailRef);
  const addItem = useAction(addItemRef);
  const removeItem = useAction(removeOrderItemRef);
  const setPrice = useAction(setPriceRef);
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
  const [showCal, setShowCal] = useState(false);
  const [unavail, setUnavail] = useState<{ dates: Set<string>; minDays: number }>({ dates: new Set(), minDays: 1 });
  // Collapsed by default so the conversation stays visible — expand to edit.
  const [expanded, setExpanded] = useState(false);

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
        {editingPrice && !a.change_price && a.partial_refund && (
          <div className="rounded-xl border border-white/10 bg-black/30 p-2.5 text-[11px] text-[#9aa0ad]">
            This booking is already paid — use Hygglo’s partial-refund on the order to discount it.
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
}: {
  tile: ReplyTileData;
  onClose: () => void;
  onActed: (id: string) => void;
  dryRun: boolean;
  zClass?: string;
}) {
  const accent = accountAccent(tile.account_slug);
  const ds = decideState(tile);
  const thread = useQuery(api.hygglo.listByThread, { thread_id: tile.thread_id });
  // Live tile (reactive) so the location overlay appears the moment it resolves.
  const liveTile = useQuery(api.replyInbox.getThreadById, {
    thread_id: tile.thread_id,
  });
  const loc = (liveTile?.location ?? tile.location) as TileLocation | null;
  const resolveLoc = useAction(resolveLocRef);
  const resolveTrust = useAction(resolveTrustRef);
  const locResolvedRef = useRef(false);
  useEffect(() => {
    if (locResolvedRef.current) return;
    locResolvedRef.current = true;
    void resolveLoc({ thread_id: tile.thread_id });
    // Pull the renter's real rating + reviews (Hygglo order detail) on open.
    void resolveTrust({ thread_id: tile.thread_id });
  }, [resolveLoc, resolveTrust, tile.thread_id]);
  const generateDraft = useAction(api.replyInbox_actions.generateDraft);
  const sendReply = useAction(api.replyInbox_actions.sendRenterReply);
  const approve = useAction(api.replyInbox_actions.approveOrder);
  const decline = useAction(api.replyInbox_actions.declineOrder);

  const [text, setText] = useState("");
  // AI draft lives in its OWN preview box (not the compose box). Tap it to copy
  // it into the message box, then edit + Send yourself — never auto-sent.
  const [draft, setDraft] = useState(tile.ai_draft_text ?? "");
  const [draftConfidence, setDraftConfidence] = useState<number | null>(
    tile.ai_draft_confidence ?? null,
  );
  const [draftFlags, setDraftFlags] = useState<DraftFlag[]>(
    tile.ai_draft_flags ?? [],
  );
  const [showFlags, setShowFlags] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [sentMsgs, setSentMsgs] = useState<string[]>([]);
  const [decided, setDecided] = useState<"approve" | "decline" | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(null);
  // Renter reviews — fetched live from Hygglo on first star-click, then cached.
  const [showReviews, setShowReviews] = useState(false);
  const reviews = useQuery(
    reviewsGetRef,
    showReviews ? { thread_id: tile.thread_id } : "skip",
  ) as RenterReviewsResult | undefined;
  const refreshReviews = useAction(reviewsRefreshRef);
  const reviewsRefreshedRef = useRef(false);
  useEffect(() => {
    if (showReviews && !reviewsRefreshedRef.current) {
      reviewsRefreshedRef.current = true;
      void refreshReviews({ thread_id: tile.thread_id });
    }
  }, [showReviews, refreshReviews, tile.thread_id]);
  // Per-account canned "quick texts" — tapping one PASTES into the box.
  const canned = (useQuery(cannedListRef, {
    account_slug: tile.account_slug ?? undefined,
  }) ?? []) as Canned[];

  // Paste a snippet into the compose box (never sends). Appends with a blank
  // line if there's already text, so you can stack delivery + bank + your own.
  function pasteText(snippet: string) {
    setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${snippet}` : snippet));
    setNote(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-draft an AI reply ON OPEN — into the SEPARATE draft box, never the
  // compose box and never sent. Only when the renter is the one waiting and
  // there's no draft yet. You tap the draft to copy it across if you want it.
  const autoDraftedRef = useRef(false);
  useEffect(() => {
    if (autoDraftedRef.current) return;
    // Regenerate if there's no draft OR the cached one is stale (older draft
    // logic) — so a fix reaches whatever thread you open without a manual flush.
    if (draft.trim() && !tile.ai_draft_stale) return;
    if (!awaitingMe(tile)) return;
    autoDraftedRef.current = true;
    void onGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onGenerate() {
    setDrafting(true);
    setNote(null);
    try {
      const r = await generateDraft({ thread_id: tile.thread_id });
      if (r.status === "ok" && r.draft) {
        setDraft(r.draft);
        setDraftConfidence(r.confidence ?? null);
        setDraftFlags(r.flags ?? []);
      } else setNote("Draft unavailable.");
    } catch {
      setNote("Draft failed.");
    } finally {
      setDrafting(false);
    }
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
      const r = await sendReply({ thread_id: tile.thread_id, account_slug: tile.account_slug, text: body.trim(), dryRun });
      if (r.status === "sent") {
        // Keep the chat OPEN so you can also approve/decline or keep texting.
        setSentMsgs((p) => [...p, body.trim()]);
        if (clearBox) setText("");
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
      className={`fixed inset-0 ${zClass} flex items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4`}
    >
      {/* Backdrop click does NOT close — only the × button (or Esc) closes, so
          you can text AND approve/decline in one session without losing it. */}
      <div
        className="w-full max-w-2xl h-full sm:h-auto max-h-screen sm:max-h-[88vh] flex flex-col rounded-none sm:rounded-[20px] border bg-[#101216] shadow-[0_40px_100px_-30px_rgba(0,0,0,0.85)] overflow-hidden"
        style={{ borderColor: `${accent}4d` }}
      >
        {/* Accent top line */}
        <div className="h-[3px] w-full" style={{ background: `linear-gradient(90deg, ${accent}, ${accent}1a)` }} />
        {/* Context header — kept compact so the conversation gets the room. */}
        <div
          className="px-3 py-2.5 border-b border-white/[0.07] flex gap-2.5"
          style={{ background: `linear-gradient(180deg, ${accent}0f, transparent)` }}
        >
          <Thumb src={tile.image_url} accent={accent} size={40} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13.5px] font-semibold text-[#f1f3f5] truncate min-w-0 flex-1">{tile.renter_name}</span>
              <button
                onClick={() => setShowReviews((s) => !s)}
                className="shrink-0 inline-flex items-center gap-0.5 hover:opacity-80"
                title="See this renter's reviews"
              >
                <Stars rating={tile.renter_rating} count={tile.renter_review_count} />
                {tile.renter_rating != null && (
                  <span className="text-[9px] text-[#6b7280]">{showReviews ? "▴" : "▾"}</span>
                )}
              </button>
              <button
                type="button"
                onClick={onClose}
                // Mobile: the click sometimes never lands on the tiny X (tap
                // delay / ghost-click). Handle touchend directly and prevent the
                // synthetic click so it fires exactly once on tap.
                onTouchEnd={(e) => {
                  e.preventDefault();
                  onClose();
                }}
                aria-label="Close"
                style={{ touchAction: "manipulation" }}
                className="shrink-0 w-10 h-10 -mr-1 rounded-lg flex items-center justify-center text-[#9aa0ad] hover:text-white active:bg-white/[0.14] hover:bg-white/[0.08] text-2xl leading-none"
              >
                ×
              </button>
            </div>
            {/* One compact horizontal meta row — earnings + dates to the side,
                not stacked, so the chat gets the room. */}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <AccountTag slug={tile.account_slug} />
              <span
                className="text-[10px] uppercase tracking-wide font-medium"
                style={{ color: tile.is_request ? "#fdba74" : "#7a8190" }}
              >
                {statusText(tile)}
              </span>
              <DatePill tile={tile} />
              <EarningsChip tile={tile} />
            </div>
            {itemLineShort(tile) && (
              <div className="text-[11px] text-[#c5cad3] mt-1 truncate">{itemLineShort(tile)}</div>
            )}
            {loc && (
              <div className="mt-1">
                <LocationBadge loc={loc} />
              </div>
            )}
            {tile.renter_rating != null && tile.renter_rating < 4 && (
              <div className="mt-1 text-[10.5px] text-red-300/90">
                ⚠ Low-rated ({tile.renter_rating.toFixed(1)}★) — vet before accepting.
              </div>
            )}
            {/* Availability: hidden unless it's a problem — only surface a
                double-booking warning, never the "available" case. */}
            {tile.availability?.status === "conflict" && (
              <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-red-400/40 bg-red-500/[0.12] px-2 py-1.5">
                <span className="text-red-400 text-[12px] leading-none mt-px">⚠</span>
                <span className="text-[11px] text-red-200/95 leading-snug">
                  Double-booking —{" "}
                  {tile.availability.items
                    .filter((i) => !i.available)
                    .map((i) => `${shortListing(i.name)}: ${Math.max(0, i.free)}/${i.requested} free`)
                    .join(" · ")}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Order editor — live items + add/remove + price + dates (has_reservation
            threads only; inquiries with no booking have nothing to edit). */}
        {tile.has_reservation && tile.account_slug && (
          <OrderEditor accountSlug={tile.account_slug} orderId={tile.thread_id} dryRun={dryRun} />
        )}

        {/* Renter reviews — a proper centred overlay (portal), opened by tapping
            the stars. Physical stars incl. half; under-4★ highlighted. */}
        {showReviews && (
          <ReviewsOverlay
            renterName={tile.renter_name}
            rating={tile.renter_rating}
            count={tile.renter_review_count}
            reviews={reviews}
            onClose={() => setShowReviews(false)}
          />
        )}

        {/* Thread — flex-1 + min-h-0 so it shrinks and the compose dock below
            (with Send) is ALWAYS visible, never clipped off-screen on mobile. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 bg-black/25">
          {thread === undefined ? (
            <SkeletonBlock className="h-24 w-full" />
          ) : thread.length === 0 ? (
            <div className="text-sm text-[#6b7280]">No messages yet.</div>
          ) : (
            thread.map((m, i) => {
              const sent = fmtMsgTime(m.timestamp);
              return (
                <div key={i} className={`flex flex-col ${m.role === "owner" ? "items-end" : "items-start"}`}>
                  <div
                    className={`max-w-[78%] px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                      m.role === "owner"
                        ? "rounded-2xl rounded-tr-md text-[#eef1f5]"
                        : "rounded-2xl rounded-tl-md bg-white/[0.06] text-[#d8dce3]"
                    }`}
                    style={
                      m.role === "owner"
                        ? { background: `linear-gradient(135deg, ${accent}40, ${accent}24)` }
                        : undefined
                    }
                  >
                    {m.content}
                  </div>
                  {sent && <span className="text-[10px] text-[#6b7280] mt-1 px-1 tabular-nums">{sent}</span>}
                </div>
              );
            })
          )}
          {sentMsgs.map((s, i) => (
            <div key={`sent-${i}`} className="flex justify-end">
              <div
                className="max-w-[78%] rounded-2xl rounded-tr-md px-3.5 py-2.5 text-[13.5px] leading-relaxed text-[#eef1f5]"
                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}1a)` }}
              >
                {s} <span className="text-[10px] text-[#9aa0ad] ml-1">{dryRun ? "test ✓" : "sent ✓"}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Compose + decisions — shrink-0 so it never gets compressed/clipped. */}
        <div className="shrink-0 p-4 border-t border-white/[0.07] space-y-3 bg-[#0e1014]">
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

          {/* Quick texts — tap a chip to PASTE into the box. Never auto-sends:
              edit it, add/remove, then hit Send yourself. The amber "Ask to
              request" chip shows only on inquiry threads with no booking yet. */}
          {(canned.length > 0 || !tile.has_reservation) && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[9px] uppercase tracking-[0.12em] text-[#5f6675] font-semibold mr-0.5 select-none">
                Insert
              </span>
              {!tile.has_reservation && (
                <button
                  type="button"
                  onClick={() => pasteText(ASK_REQUEST_TEXT)}
                  title={`Paste: ${ASK_REQUEST_TEXT}`}
                  className="group/q flex items-center gap-1 pl-1 pr-2 py-0.5 rounded-full border border-amber-400/30 bg-gradient-to-b from-amber-500/[0.18] to-amber-600/[0.08] hover:border-amber-300/60 hover:from-amber-500/[0.28] transition-colors"
                >
                  <span className="flex items-center justify-center w-4 h-4 rounded-full bg-amber-400/20 text-[10px] leading-none">📩</span>
                  <span className="text-[10px] font-semibold text-amber-200/90">Ask to request</span>
                </button>
              )}
              {canned.map((c) => (
                <button
                  key={c._id}
                  type="button"
                  onClick={() => pasteText(c.text)}
                  title={`Paste: ${c.text}`}
                  className="group/q flex items-center gap-1 pl-1 pr-2 py-0.5 rounded-full border border-white/10 bg-white/[0.05] hover:border-white/25 hover:bg-white/[0.12] transition-colors"
                >
                  <span className="flex items-center justify-center w-4 h-4 rounded-full bg-white/[0.08] group-hover/q:bg-white/[0.16] text-[10px] leading-none transition-colors">
                    {c.symbol}
                  </span>
                  <span className="text-[10px] font-medium text-[#cbd5e1] group-hover/q:text-white transition-colors">
                    {c.label}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* AI draft — its OWN box. Tap to copy it into the message box below;
              it never auto-fills the compose box and is never sent on its own. */}
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
                  onClick={() => pasteText(draft)}
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

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a reply…"
            rows={3}
            // text-[16px]: iOS Safari zooms the page when a focused input is
            // <16px — keep it exactly 16 to stop the zoom-on-type.
            className="w-full resize-y rounded-xl bg-black/35 border border-white/10 px-3.5 py-2.5 text-[16px] text-[#eef1f5] placeholder-[#5b6170] focus:outline-none focus:border-white/25 focus:ring-2 focus:ring-white/[0.04]"
          />
          <div className="flex items-center gap-2">
            {!draft && !drafting && (
              <button
                onClick={onGenerate}
                className="text-xs px-3 py-2 rounded-lg bg-white/[0.06] text-[#c5cad3] hover:bg-white/[0.12] disabled:opacity-50"
              >
                ✨ Draft (AI)
              </button>
            )}
            <span className="text-[11px] text-[#6b7280] hidden sm:block">Nothing sends until you hit Send</span>
            <button
              onClick={onSend}
              disabled={sending || !text.trim()}
              className="ml-auto text-[13px] font-semibold px-6 py-2 rounded-lg text-white disabled:opacity-40 transition-transform active:scale-[0.98]"
              style={{ background: accent, boxShadow: `0 4px 14px -4px ${accent}99` }}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          {note && (
            <div className={`text-xs ${note.startsWith("✓") ? "text-emerald-400" : "text-amber-400"}`}>{note}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── widget ────────────────────────────────────────────────────────

export function ReplyInbox() {
  const { activeAccountSlug } = useAccount();
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

  const [openId, setOpenId] = useState<string | null>(null);
  const [acted, setActed] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [mounted, setMounted] = useState(false);
  // Default to "To reply" so chats I already answered (owner spoke last) DON'T
  // clutter the view — only new requests + renters waiting on me.
  const [filter, setFilter] = useState<"todo" | "requests" | "all">("todo");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "waiting">("newest");
  const [testMode, setTestMode] = useState(false);
  const [showManager, setShowManager] = useState(false);

  useEffect(() => setMounted(true), []);
  // Yield to a tapped notification: when the SW asks to deep-link to a thread,
  // close this widget's own modal so the deep-link host (z-[300]) is the only
  // chat showing — otherwise a stale widget modal would sit behind it.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string } | undefined)?.type === "deep-link") setOpenId(null);
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const onActed = (id: string) => setActed((p) => new Set(p).add(id));
  const all = (queue ?? []).filter((t) => !acted.has(t.thread_id));
  // A request still "needs me" only until I've replied/approved (owner-last).
  const pendingRequest = (t: ReplyTileData) =>
    t.kind === "request" && t.last_sender !== "owner" && !isResolvedClosed(t);
  const requests = all.filter(pendingRequest).length;
  const todo = all.filter((t) => awaitingMe(t)).length;
  const visible = all.filter((t) =>
    filter === "all" ? true : filter === "requests" ? pendingRequest(t) : awaitingMe(t),
  );
  const sorted = [...visible].sort((a, b) => {
    if (sortBy === "newest") return (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0);
    if (sortBy === "oldest") return (a.last_activity_at ?? 0) - (b.last_activity_at ?? 0);
    // "waiting": longest-unanswered first — renters waiting on me, oldest message up top.
    const aw = a.last_sender === "renter" ? 0 : 1;
    const bw = b.last_sender === "renter" ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return (a.last_renter_msg_at ?? 0) - (b.last_renter_msg_at ?? 0);
  });
  // `open` resolves against the RAW queue (not `all`/visible) so approving or
  // declining a card — which drops it from `all` via onActed — does NOT close
  // the chat overlay. Only the × button closes it.
  const open = openId ? (queue ?? []).find((t) => t.thread_id === openId) ?? null : null;

  return (
    <Card>
      <style>{`
        @keyframes rgGlow { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 18px -4px var(--u); } }
        @keyframes rgBlink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0.3; } }
        @keyframes rgMoney { 0%,100% { box-shadow: 0 0 18px -8px rgba(251,191,36,0.55); } 50% { box-shadow: 0 0 30px -4px rgba(251,191,36,0.95); } }
      `}</style>
      {/* Header — aperture mark + title + request pill + controls */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-400/20 to-sky-500/[0.05] border border-sky-400/20 flex items-center justify-center shrink-0">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#56c7fb" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6 6l2.5 2.5M18 18l-2.5-2.5M18 6l-2.5 2.5M6 18l2.5-2.5" strokeWidth="1.4" opacity="0.65" />
          </svg>
        </div>
        <div>
          <div className="text-[15.5px] font-semibold text-[#f2f4f8] leading-none tracking-[-0.01em]">Quick Reply</div>
          <div className="text-[11px] text-[#6b7280] mt-[5px] leading-none">renters waiting on you</div>
        </div>
        {requests > 0 && (
          <span className="ml-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-orange-500/12 text-orange-300 ring-1 ring-orange-400/25 tabular-nums">
            {requests} request{requests > 1 ? "s" : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap justify-end">
          <button
            onClick={() => updateSettings({ availability_include_pending: !includePending })}
            title="When on, not-yet-confirmed (pending) requests also count as occupying stock in the availability / double-booking check."
            className={`text-[11px] font-medium px-2.5 py-1.5 rounded-lg transition-colors ${
              includePending
                ? "bg-sky-500/12 text-sky-300 ring-1 ring-sky-400/25"
                : "bg-white/[0.05] text-[#9ca3af] hover:bg-white/[0.09]"
            }`}
          >
            <span className="sm:hidden">⏳</span>
            <span className="hidden sm:inline">{includePending ? "⏳ Pending counted" : "Pending off"}</span>
          </button>
          <button
            onClick={() => setShowManager(true)}
            title="See + edit each account's saved quick texts (delivery, location, bank details…)."
            className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-white/[0.05] text-[#9ca3af] hover:bg-white/[0.09] transition-colors"
          >
            <span className="sm:hidden">✏️</span>
            <span className="hidden sm:inline">✏️ Quick texts</span>
          </button>
          <button
            onClick={() => setTestMode((x) => !x)}
            title="When on, Approve/Decline/Send only simulate — nothing is sent to renters."
            className={`text-[11px] font-medium px-2.5 py-1.5 rounded-lg transition-colors ${
              testMode
                ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30"
                : "bg-white/[0.05] text-[#9ca3af] hover:bg-white/[0.09]"
            }`}
          >
            <span className="sm:hidden">🧪</span>
            <span className="hidden sm:inline">{testMode ? "🧪 Test mode ON" : "Test mode"}</span>
          </button>
        </div>
      </div>

      {/* Filter + sort */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        {/* Filter — segmented control (spreads full-width on mobile) */}
        <div className="flex sm:inline-flex items-center justify-between sm:justify-start gap-0.5 p-1 rounded-xl bg-black/30 border border-white/[0.06]">
          {([
            { k: "todo", label: "To reply", n: todo },
            { k: "requests", label: "Requests", n: requests },
            { k: "all", label: "All", n: all.length },
          ] as const).map((f) => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k)}
              className={`text-[12px] px-3.5 py-1.5 rounded-lg transition-colors ${
                filter === f.k
                  ? "bg-white/[0.10] text-white font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                  : "text-[#8b8fa3] font-medium hover:text-white"
              }`}
            >
              {f.label}
              {f.n ? (
                <span className={`ml-1 ${filter === f.k ? "text-[#9ca3af] font-normal" : "opacity-50"}`}>{f.n}</span>
              ) : null}
            </button>
          ))}
        </div>
        {/* Sort */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          title="Sort the list"
          className="w-full sm:w-auto text-[12px] px-2.5 py-2 sm:py-1.5 rounded-lg bg-black/30 border border-white/[0.06] text-[#cbd0d8] hover:bg-white/[0.05] focus:outline-none cursor-pointer"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="waiting">Longest waiting</option>
        </select>
      </div>
      {queue === undefined ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 max-h-[44rem] overflow-y-auto p-0.5">
          {sorted.map((tile) => (
            <ReplyCard
              key={tile.thread_id}
              tile={tile}
              now={now}
              onOpen={() => setOpenId(tile.thread_id)}
              onActed={onActed}
              dryRun={testMode}
            />
          ))}
        </div>
      )}
      {mounted && open && (
        <ReplyModal tile={open} onClose={() => setOpenId(null)} onActed={onActed} dryRun={testMode} />
      )}
      {mounted && showManager && (
        <CannedManager accountSlug={activeAccountSlug} onClose={() => setShowManager(false)} />
      )}
    </Card>
  );
}
