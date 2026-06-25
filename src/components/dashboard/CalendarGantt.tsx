"use client";
import React, { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Block {
  reservation_id: string;
  start_date: string | undefined;
  end_date: string | undefined;
  /**
   * Effective (negotiated) return date — backend getGanttWeek emits this
   * (return_date ?? end_date). Bar placement / progress prefer it so a
   * chat-extended rental's bar reaches the negotiated return, matching the
   * Active tab's ongoing window. Raw end_date stays for invoicing/length math.
   */
  return_date: string | null | undefined;
  renter_name: string | null;
  order_step: string | null;
  pickup_time: string | null;
  return_time: string | null;
  pickup_method: string | null;
  return_method: string | null;
  progress_percent: number | null;
  account_slug?: string | null;
  // Contiguous same-renter + same-item bookings share this id → one merged bar.
  logical_group_id?: string;
  // Account-correct listing photo for this reservation's resolved item.
  image_url?: string | null;
}

interface GanttItem {
  item_id: string | null;
  item_name: string;
  image_url: string | null;
  account_slug: string | null;
  account_color: "blue" | "purple" | "orange";
  blocks: Block[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  weekStartIso?: string;
  accountSlug?: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
/**
 * "Today" in the business timezone (Europe/London), "YYYY-MM-DD". Inlined
 * twin of convex/lib/effectiveDates.ts:londonToday so the Gantt anchors +
 * today-marker classify on the same calendar day as the backend Active tab,
 * instead of UTC (which can lag just after London midnight). DST-correct.
 */
function londonToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

function mondayOfThisWeek(): string {
  // Anchor on the London-business day, then derive the Monday via UTC-parsed
  // date-only arithmetic (no instant drift).
  const anchor = new Date(londonToday() + "T00:00:00Z");
  const day = anchor.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  anchor.setUTCDate(anchor.getUTCDate() + diff);
  return anchor.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Navigation cap: ~1 year back .. +4 weeks (~1 month) ahead.
const WEEK_AHEAD_CAP = 28;
const WEEK_BEHIND_CAP = 364;

/** Clamp a Monday-ISO into [this week - ~1 year, +4 weeks]. ISO date strings
 *  compare lexicographically, so string `<`/`>` is a valid date order here. */
function clampWeek(iso: string): string {
  const thisMonday = mondayOfThisWeek();
  const min = addDays(thisMonday, -WEEK_BEHIND_CAP);
  const max = addDays(thisMonday, WEEK_AHEAD_CAP);
  if (iso < min) return min;
  if (iso > max) return max;
  return iso;
}

function isoToDate(iso: string): Date {
  return new Date(iso + "T00:00:00Z");
}

function formatWeekRange(weekStart: string): string {
  const start = isoToDate(weekStart);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}

function dayHeaders(weekStart: string): Array<{ label: string; iso: string }> {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((label, i) => {
    const iso = addDays(weekStart, i);
    const num = isoToDate(iso).getUTCDate();
    return { label: `${label} ${num}`, iso };
  });
}

// ---------------------------------------------------------------------------
// Status color
// ---------------------------------------------------------------------------
type StatusStyle = { bg: string; border: string; text: string; strikethrough?: boolean };

function statusStyle(orderStep: string | null): StatusStyle {
  // Colour scheme reflects the OWNER's view of action state:
  //   amber  — renter action pending (request waiting OR payment pending)
  //   pink   — paid + verifying (real pending — needs no owner action but worth surfacing)
  //   blue   — confirmed/out (booked or in-progress)
  //   green  — done (returned/reviewed)
  //   grey   — cancelled/failed
  switch (orderStep) {
    case "REQUEST":
    case "APPROVED":
    case "FUNDS_RESERVED":  // active=FUNDS_RESERVED means renter must pay
      return { bg: "rgba(245,158,11,0.18)", border: "#f59e0b", text: "#fbbf24" };
    case "VERIFIED":  // active=VERIFIED means paid + currently verifying
      return { bg: "rgba(236,72,153,0.18)", border: "#ec4899", text: "#f472b6" };
    case "BOOKED_AFTER_VERIFIED":
      return { bg: "rgba(59,130,246,0.18)", border: "#3b82f6", text: "#60a5fa" };
    case "DELIVERED":
      return { bg: "rgba(59,130,246,0.12)", border: "#3b82f6", text: "#60a5fa" };
    case "RETURNED":
    case "REVIEWED":
      return { bg: "rgba(16,185,129,0.18)", border: "#10b981", text: "#34d399" };
    case "CANCELED":
    case "VERIFICATION_FAILED":
      return { bg: "rgba(107,114,128,0.15)", border: "#6b7280", text: "#9ca3af", strikethrough: true };
    default:
      return { bg: "rgba(107,114,128,0.12)", border: "#6b7280", text: "#9ca3af" };
  }
}

function accountColor(ac: "blue" | "purple" | "orange"): string {
  return ac === "purple" ? "#a855f7" : ac === "orange" ? "#f97316" : "#3b82f6";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// ── Geometry — time-accurate bars + reservation grouping ───────────────────
const DAY_MS = 86400000;

/** Fraction of a day (0..1) for a "HH:MM[:SS]" time, or `fallback` if absent. */
// The expanded calendar compresses each day column to BUSINESS HOURS — 9am to
// 10pm — so bar positions reflect the working day instead of a mostly-empty 24h.
const DAY_WINDOW_START_MIN = 9 * 60; // 09:00
const DAY_WINDOW_END_MIN = 22 * 60; // 22:00

/** Fraction (0..1) of a "HH:MM" time within the 9am–10pm window, clamped to the
 *  window edges; `fallback` when no time (0 = window start, 1 = window end). */
function timeFrac(t: string | null, fallback: number): number {
  if (!t) return fallback;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return Math.max(
    0,
    Math.min(1, (mins - DAY_WINDOW_START_MIN) / (DAY_WINDOW_END_MIN - DAY_WINDOW_START_MIN)),
  );
}

interface BarGeom { left: number; width: number; }

/** Pixel geometry for a reservation bar, positioned to the actual pickup time
 *  on the start day and the actual return time on the return day (sub-day
 *  precision). null if the rental doesn't intersect the visible week. */
function barGeom(block: Block, weekStart: string, colWidth: number): BarGeom | null {
  if (!block.start_date) return null;
  const effReturn = block.return_date ?? block.end_date;
  if (!effReturn) return null;
  const weekStartMs = isoToDate(weekStart).getTime();
  const weekEndMs = weekStartMs + 7 * DAY_MS;
  // Time-accurate bars: positioned to the actual pickup time on the start day and
  // the return time on the return day (sub-day precision via the 9am–10pm
  // business-hours window) so the bar's placement MATCHES the booked times.
  // Interior away-days are spanned fully — the bar is one continuous rect.
  const startMs = isoToDate(block.start_date).getTime() + timeFrac(block.pickup_time, 0) * DAY_MS;
  // No return time → end of day so the bar still covers the return day.
  const endMs = isoToDate(effReturn).getTime() + timeFrac(block.return_time, 1) * DAY_MS;
  if (endMs <= weekStartMs || startMs >= weekEndMs) return null;
  const startDays = Math.max(0, (startMs - weekStartMs) / DAY_MS);
  const endDays = Math.min(7, (endMs - weekStartMs) / DAY_MS);
  return { left: startDays * colWidth, width: Math.max((endDays - startDays) * colWidth, 8) };
}

// order_step = ACTIVE (next-to-do) step — see src/lib/order_step_semantics.ts.
function orderStepLabel(step: string | null): string {
  switch (step) {
    case "REQUEST": return "Request";          // owner must accept
    case "APPROVED":                            // renter must pay
    case "FUNDS_RESERVED": return "Awaiting";   // renter must pay
    case "VERIFIED": return "Verifying";        // paid, doing ID/doc check
    case "BOOKED_AFTER_VERIFIED": return "Confirmed";
    case "DELIVERED": return "Out";
    case "RETURNED": return "Returning";
    case "REVIEWED": return "Done";
    case "CANCELED": return "Cancelled";
    case "VERIFICATION_FAILED": return "Failed";
    default: return "Booking";
  }
}

interface ResItem { name: string; image: string | null; }
interface ResRow {
  reservationId: string;
  block: Block;            // representative block (dates / renter / status)
  acc: string;             // account color hex
  items: ResItem[];
  left: number;
  width: number;
  ongoing: boolean;
  memberCount: number;     // # of bookings merged into this one logical rental
}

/** Collapse the item-centric gantt payload into one row per reservation, so a
 *  renter who booked several items shows once with all their thumbnails — the
 *  same booking-centric view as the small dashboard calendar. */
function groupByReservation(items: GanttItem[], weekStart: string, colWidth: number, today: string): ResRow[] {
  // Collect every member block + item per LOGICAL group. Contiguous
  // same-renter/same-item bookings share a logical_group_id (backend), so they
  // collapse into ONE row spanning earliest pickup → latest return.
  const groups = new Map<string, { blocks: Block[]; items: ResItem[]; shown: Set<string>; resIds: Set<string> }>();
  for (const item of items) {
    for (const block of item.blocks) {
      if (!block.start_date) continue;
      const gid = block.logical_group_id ?? block.reservation_id;
      let g = groups.get(gid);
      if (!g) { g = { blocks: [], items: [], shown: new Set(), resIds: new Set() }; groups.set(gid, g); }
      g.blocks.push(block);
      g.resIds.add(block.reservation_id);
      // Per-reservation (account-correct) listing photo; dedupe by IMAGE so a
      // multi-item set shows ONE thumbnail, not one per resolved item.
      const img = block.image_url ?? item.image_url;
      const key = img ?? `n:${item.item_name}`;
      if (!g.shown.has(key)) {
        g.shown.add(key);
        g.items.push({ name: item.item_name, image: img ?? null });
      }
    }
  }
  const rows: ResRow[] = [];
  for (const [gid, g] of groups) {
    // earliest-pickup + latest-return members define the merged span.
    const startMember = g.blocks.reduce((a, b) => ((a.start_date ?? "") <= (b.start_date ?? "") ? a : b));
    const endMember = g.blocks.reduce((a, b) => {
      const ea = a.return_date ?? a.end_date ?? a.start_date ?? "";
      const eb = b.return_date ?? b.end_date ?? b.start_date ?? "";
      return ea >= eb ? a : b;
    });
    const spanEnd = endMember.return_date ?? endMember.end_date ?? endMember.start_date!;
    // representative member for renter/status: the one live today, else earliest.
    const rep = g.blocks.find((b) => {
      const e = b.return_date ?? b.end_date;
      return !!b.start_date && !!e && b.start_date <= today && today <= e;
    }) ?? startMember;
    // Confirmed handover times can sit on a DIFFERENT member than the one that
    // defines the span date (a grouped booking where only one order carries the
    // negotiated time, e.g. Nartay's early-pickup order). Pull the earliest
    // CONFIRMED pickup + latest CONFIRMED return across the group so the bar
    // shows real times instead of landing in the "not defined" slot.
    const byPickup = [...g.blocks].sort((a, b) =>
      (a.start_date ?? "").localeCompare(b.start_date ?? ""),
    );
    const byReturn = [...g.blocks].sort((a, b) => {
      const ea = a.return_date ?? a.end_date ?? a.start_date ?? "";
      const eb = b.return_date ?? b.end_date ?? b.start_date ?? "";
      return eb.localeCompare(ea);
    });
    const definedMethod = (v?: string | null): v is string => !!v && v !== "unknown";
    const pickupTime = byPickup.find((b) => b.pickup_time)?.pickup_time ?? startMember.pickup_time ?? null;
    const returnTime = byReturn.find((b) => b.return_time)?.return_time ?? endMember.return_time ?? null;
    const pickupMethod = byPickup.find((b) => definedMethod(b.pickup_method))?.pickup_method ?? startMember.pickup_method ?? null;
    const returnMethod = byReturn.find((b) => definedMethod(b.return_method))?.return_method ?? endMember.return_method ?? null;
    // Synthetic block spanning the whole rental, carrying the earliest pickup
    // time and the latest return time so the bar's end labels read correctly.
    const merged: Block = {
      reservation_id: gid,
      logical_group_id: gid,
      start_date: startMember.start_date,
      end_date: endMember.end_date,
      return_date: spanEnd,
      renter_name: rep.renter_name,
      order_step: rep.order_step,
      pickup_time: pickupTime,
      return_time: returnTime,
      pickup_method: pickupMethod,
      return_method: returnMethod,
      progress_percent: rep.progress_percent,
      account_slug: rep.account_slug,
    };
    const geom = barGeom(merged, weekStart, colWidth);
    if (!geom) continue;
    const ongoing = !!startMember.start_date && startMember.start_date <= today && today <= spanEnd;
    const accColor: "blue" | "purple" | "orange" =
      rep.account_slug === "leo" ? "purple" : rep.account_slug === "diogo" ? "orange" : "blue";
    rows.push({
      reservationId: gid,
      block: merged,
      acc: accountColor(accColor),
      items: g.items,
      left: geom.left,
      width: geom.width,
      ongoing,
      memberCount: g.resIds.size,
    });
  }
  return rows.sort((a, b) => {
    const ka = (a.block.start_date ?? "") + (a.block.pickup_time ?? "");
    const kb = (b.block.start_date ?? "") + (b.block.pickup_time ?? "");
    return ka.localeCompare(kb) || (a.block.renter_name ?? "").localeCompare(b.block.renter_name ?? "");
  });
}

// Overlapping item thumbnails for a reservation row (mirrors the small
// calendar). Large by default; hovering shows a big preview rendered in a
// viewport-clamped portal so it's never clipped by the scroll container.
const PREVIEW_SIZE = 280;
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function ResThumbs({ items, ring }: { items: ResItem[]; ring: string }) {
  const shown = items.slice(0, 6);
  const extra = items.length - shown.length;
  const [preview, setPreview] = useState<{ src: string; name: string; cx: number; cy: number } | null>(null);

  const onEnter = (src: string, name: string) => (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setPreview({ src, name, cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  };
  const onLeave = () => setPreview(null);

  return (
    <div className="flex items-center">
      {shown.map((it, i) =>
        it.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={it.image}
            alt=""
            title={it.name}
            className="w-14 h-14 rounded-lg object-cover first:ml-0 -ml-3 cursor-zoom-in transition-transform hover:-translate-y-0.5"
            style={{ border: `2px solid ${ring}`, background: "#0b0f1c" }}
            onMouseEnter={onEnter(it.image, it.name)}
            onMouseLeave={onLeave}
          />
        ) : (
          <div
            key={i}
            title={it.name}
            className="w-14 h-14 rounded-lg flex items-center justify-center text-sm font-bold first:ml-0 -ml-3"
            style={{ border: `2px solid ${ring}`, background: `${ring}33`, color: ring }}
          >
            {it.name.charAt(0).toUpperCase()}
          </div>
        ),
      )}
      {extra > 0 && <span className="ml-1.5 text-[11px] text-gray-400 flex-shrink-0">+{extra}</span>}

      {/* Hover preview — portal to body, clamped inside the viewport so it
          never gets cut off by the calendar's scroll container. */}
      {preview && typeof window !== "undefined" &&
        createPortal(
          <div
            className="fixed z-[200] pointer-events-none rounded-xl overflow-hidden"
            style={{
              left: clamp(preview.cx - PREVIEW_SIZE / 2, 8, window.innerWidth - PREVIEW_SIZE - 8),
              top: clamp(preview.cy - PREVIEW_SIZE / 2, 8, window.innerHeight - PREVIEW_SIZE - 8),
              width: PREVIEW_SIZE,
              height: PREVIEW_SIZE,
              border: `2px solid ${ring}`,
              boxShadow: "0 24px 70px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08)",
              background: "#0b0f1c",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.src} alt={preview.name} className="w-full h-full object-contain" />
            <div className="absolute bottom-0 inset-x-0 px-2 py-1 text-[11px] text-gray-200 truncate" style={{ background: "rgba(0,0,0,0.7)" }}>
              {preview.name}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

interface BarProps {
  row: ResRow;
  height: number;
  isNext: boolean;     // the immediate next upcoming rental → always pulses
  onSelect: () => void;
  liveProgress: number | null;
  today: string;       // YYYY-MM-DD (London) — for the pickup/return-today glow
  weekStart: string;   // visible week start — gate time labels to the real day
}

// One time-accurate bar per reservation. Left stripe = account color, fill =
// status, glow + dot = ongoing. The bar physically ends at the return time.
function ReservationBar({ row, height, isNext, onSelect, liveProgress, today, weekStart }: BarProps) {
  const { block, acc, ongoing } = row;
  const ss = statusStyle(block.order_step);
  const showProgress = block.order_step === "DELIVERED" && liveProgress !== null && liveProgress < 100;
  const hasRenter = !!block.renter_name && block.renter_name.trim() !== "" && block.renter_name.trim() !== "?";
  const renterLabel = hasRenter ? block.renter_name!.trim() : orderStepLabel(block.order_step);
  const pickup = block.pickup_time ? block.pickup_time.slice(0, 5) : null;
  const ret = block.return_time ? block.return_time.slice(0, 5) : null;
  const showTimes = row.width > 70;
  // Pickup or return happening TODAY → cyan glow, distinct from the amber
  // next-upcoming pulse and the status "ongoing" glow.
  const pickupDay = block.start_date;
  const returnDay = block.return_date ?? block.end_date;
  const pickupToday = !!pickupDay && pickupDay === today;
  const returnToday = !!returnDay && returnDay === today;
  const todayEvent = pickupToday || returnToday;
  // A time label belongs ONLY on its real pickup/return day. If that day is
  // outside the visible week, the bar is clamped to the week edge — don't paint
  // the time there (it would read as a pickup/return on the wrong day).
  const weekEnd = addDays(weekStart, 6);
  const pickupInWeek = !!pickupDay && pickupDay >= weekStart && pickupDay <= weekEnd;
  const returnInWeek = !!returnDay && returnDay >= weekStart && returnDay <= weekEnd;
  const tooltip = [
    renterLabel,
    row.items.map((i) => i.name).join(", "),
    block.start_date ? `${block.start_date} → ${block.return_date ?? block.end_date}` : null,
    pickup ? `pickup ${pickup}` : null,
    ret ? `return ${ret}` : null,
    ongoing ? "ONGOING" : null,
    row.memberCount > 1 ? `${row.memberCount} bookings merged into one rental` : null,
  ].filter(Boolean).join(" • ");

  return (
    <div
      className={`absolute rounded-md cursor-pointer overflow-hidden flex items-center gap-1.5 pl-2 pr-1.5 select-none transition-all hover:brightness-125${isNext ? " gantt-next-pulse" : todayEvent ? " gantt-today-glow" : ""}`}
      style={{
        left: row.left,
        width: row.width,
        top: (RES_ROW_HEIGHT - height) / 2,
        height,
        background: ss.bg,
        border: `1px solid ${isNext ? "#fbbf24" : ss.border}`,
        borderLeft: `4px solid ${acc}`,
        boxShadow: ongoing && !isNext && !todayEvent ? `0 0 0 1.5px ${ss.border}, 0 0 10px ${ss.border}aa` : undefined,
      }}
      title={tooltip}
      onClick={onSelect}
    >
      {ongoing && (
        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: ss.text, boxShadow: `0 0 6px ${ss.text}` }} />
      )}
      {/* Merged-rental indicator: N bookings chained into one continuous bar */}
      {row.memberCount > 1 && (
        <span
          className="flex-shrink-0 text-[9px] font-bold leading-none px-1 rounded-sm tabular-nums"
          style={{ background: ss.text, color: ss.bg }}
          title={`${row.memberCount} bookings merged into one rental`}
        >
          ⛓{row.memberCount}
        </span>
      )}
      {/* Pickup time pinned to the START of the bar — only on the pickup day */}
      {showTimes && pickup && pickupInWeek && (
        <span
          className="text-[10.5px] font-mono flex-shrink-0 leading-none tabular-nums"
          style={{
            color: pickupToday ? "#67e8f9" : ss.text,
            opacity: pickupToday ? 1 : 0.8,
            fontWeight: pickupToday ? 700 : 600,
            textShadow: pickupToday ? "0 0 6px rgba(34,211,238,0.9)" : undefined,
          }}
          title={`Out ${pickup}${pickupToday ? " — today" : ""}`}
        >
          ↑{pickup}
        </span>
      )}
      <span
        className="text-[11px] font-semibold truncate flex-1 leading-none text-center"
        style={{
          color: ss.text,
          textDecoration: ss.strikethrough ? "line-through" : undefined,
          fontStyle: hasRenter ? undefined : "italic",
          opacity: hasRenter ? undefined : 0.8,
        }}
      >
        {renterLabel}
      </span>
      {/* Drop-off time pinned to the END of the bar — only on the return day */}
      {showTimes && ret && returnInWeek && (
        <span
          className="text-[10.5px] font-mono flex-shrink-0 leading-none tabular-nums"
          style={{
            color: returnToday ? "#67e8f9" : ss.text,
            opacity: returnToday ? 1 : 0.8,
            fontWeight: returnToday ? 700 : 600,
            textShadow: returnToday ? "0 0 6px rgba(34,211,238,0.9)" : undefined,
          }}
          title={`Back ${ret}${returnToday ? " — today" : ""}`}
        >
          {ret}↓
        </span>
      )}
      {showProgress && (
        <div
          className="absolute left-0 bottom-0 h-0.5 rounded-full"
          style={{ width: `${Math.min(100, liveProgress ?? 0)}%`, background: "linear-gradient(90deg, #3b82f6, #10b981)" }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded chip detail panel
// ---------------------------------------------------------------------------
// Docked at the modal's bottom-right (fixed within the modal, NOT per-row) so
// it can never clip off the edge the way the old right-0/top-0 popover did.
function BlockDetail({ block, items, accent, onClose }: { block: Block; items: ResItem[]; accent: string; onClose: () => void }) {
  const ss = statusStyle(block.order_step);
  const fmtMethod = (m: string | null) =>
    m === "delivery" ? "🚚 Delivery" : m === "collection" ? "🤝 Collection" : m;
  const fmtDay = (d: string | null | undefined) =>
    d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : null;
  const rows: Array<[string, string | null | undefined]> = [
    ["Status", orderStepLabel(block.order_step)],
    ["Renter", block.renter_name && block.renter_name !== "?" ? block.renter_name : "—"],
    // Effective (negotiated) return so an extended rental's detail matches its bar.
    ["↑ Out", [fmtDay(block.start_date), block.pickup_time?.slice(0, 5), fmtMethod(block.pickup_method)].filter(Boolean).join(" · ") || null],
    ["↓ Back", [fmtDay(block.return_date ?? block.end_date), block.return_time?.slice(0, 5), fmtMethod(block.return_method)].filter(Boolean).join(" · ") || null],
    ["Progress", block.progress_percent != null ? `${block.progress_percent}%` : null],
  ];
  return (
    <div
      className="absolute bottom-4 right-4 z-30 rounded-xl p-4 shadow-2xl w-[270px] max-h-[60%] overflow-auto"
      style={{
        background: "rgba(14,17,28,0.99)",
        border: `1px solid ${ss.border}`,
        boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between mb-2 gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: accent }} />
            <span className="text-sm font-bold truncate" style={{ color: ss.text }}>
              {block.renter_name && block.renter_name !== "?" ? block.renter_name : "Booking"}
            </span>
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {items.length} item{items.length === 1 ? "" : "s"}
          </div>
        </div>
        <button
          className="text-gray-400 hover:text-white text-lg leading-none flex-shrink-0"
          onClick={onClose}
          aria-label="Close detail"
        >
          ×
        </button>
      </div>
      {/* Item list with thumbnails */}
      {items.length > 0 && (
        <div className="flex flex-col gap-1 mb-2 pb-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-1.5 min-w-0">
              {it.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.image} alt="" className="w-5 h-5 rounded object-cover flex-shrink-0" style={{ background: "#0b0f1c" }} />
              ) : (
                <span className="w-5 h-5 rounded flex-shrink-0" style={{ background: `${accent}33` }} />
              )}
              <span className="text-[11px] text-gray-300 truncate" title={it.name}>{it.name}</span>
            </div>
          ))}
        </div>
      )}
      {rows
        .filter(([, v]) => v != null && v !== "")
        .map(([label, val]) => (
          <div key={label} className="flex gap-2 text-xs mb-1">
            <span className="text-gray-500 w-14 flex-shrink-0">{label}</span>
            <span className="text-gray-200 break-words">{val}</span>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const COL_WIDTH = 150; // px per day column (fallback before width is measured)
const LABEL_WIDTH = 300; // px for left "renter + thumbnails" column
const RES_ROW_HEIGHT = 84; // one reservation per row (renter + large thumbnails)
const BAR_HEIGHT = 28; // fixed bar height, vertically centered in the row

export default function CalendarGantt({ open, onClose, weekStartIso, accountSlug }: Props): React.ReactElement | null {
  const [weekStart, setWeekStart] = useState<string>(() => weekStartIso ?? mondayOfThisWeek());
  const [selectedBlock, setSelectedBlock] = useState<{ block: Block; items: ResItem[]; accent: string } | null>(null);
  // live progress map: reservation_id → computed progress
  const [liveProgress, setLiveProgress] = useState<Record<string, number>>({});
  // Current instant — ticks every minute so the red "now" line sweeps the day.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Measured width of the scroll area so 7 day-columns fill it (no horizontal
  // scroll) instead of a fixed 150px/col that overflowed a 1200px modal.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  // W08 search — filter rentals by item name / tag and (lazily) show per-day
  // availability. The query string is debounced before hitting the backend so
  // typing doesn't churn Convex subscriptions.
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const searching = q.length > 0;
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(id);
  }, [q]);

  const data = useQuery(
    api.calendar.getGanttWeek,
    open ? { weekStartIso: weekStart, accountSlug: accountSlug ?? undefined } : "skip"
  );

  // Inventory search (name / tag) + per-day availability + the reservations
  // that touch the matched items. Fetched ONLY while searching ("search-only"),
  // so the default calendar pays nothing.
  const searchResult = useQuery(
    api.calendar.searchCalendarInventory,
    open && debouncedQ.length > 0
      ? { query: debouncedQ, weekStartIso: weekStart, accountSlug: accountSlug ?? undefined }
      : "skip",
  );

  // Sync prop weekStartIso if it changes while open (clamped to the nav window)
  useEffect(() => {
    if (weekStartIso) setWeekStart(clampWeek(weekStartIso));
  }, [weekStartIso]);

  // ESC to close; arrow keys step weeks within the [this week, +4 weeks] cap
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setWeekStart((w) => clampWeek(addDays(w, -7)));
      if (e.key === "ArrowRight") setWeekStart((w) => clampWeek(addDays(w, 7)));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Compute live progress for DELIVERED blocks (5-min interval)
  const computeProgress = useCallback(() => {
    if (!data?.items) return;
    const now = Date.now();
    const map: Record<string, number> = {};
    for (const item of data.items) {
      for (const block of item.blocks) {
        if (block.order_step === "DELIVERED" && block.start_date && block.end_date) {
          const start = isoToDate(block.start_date as string).getTime();
          // Effective return for the progress denominator so an extended rental's
          // bar fills toward the negotiated return, matching its placement.
          const end = isoToDate((block.return_date ?? block.end_date) as string).getTime() + 86400000; // inclusive
          const total = end - start;
          if (total > 0) {
            map[block.reservation_id] = Math.min(100, Math.round(((now - start) / total) * 100));
          }
        }
      }
    }
    setLiveProgress(map);
  }, [data]);

  useEffect(() => {
    computeProgress();
    const timer = setInterval(computeProgress, 300_000);
    return () => clearInterval(timer);
  }, [computeProgress]);

  // Close selected block detail when week changes
  useEffect(() => {
    setSelectedBlock(null);
  }, [weekStart]);

  // Measure the grid scroll area so columns fill the available width.
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current;
    if (!el) return;
    const update = () => setGridWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, data]);

  // Tick the "now" marker every minute while open.
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [open]);

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).classList.contains("gantt-backdrop")) onClose();
  };

  if (!open) return null;

  const today = londonToday();
  const headers = dayHeaders(weekStart);
  // Fit 7 columns into the measured width (min 96px so they stay legible and
  // scroll only on very small screens). Falls back to COL_WIDTH pre-measure.
  const colWidth = gridWidth > 0 ? Math.max(96, Math.floor((gridWidth - LABEL_WIDTH) / 7)) : COL_WIDTH;
  const totalGridWidth = colWidth * 7;

  // Booking-centric rows: one per reservation, all its items grouped together.
  const resRows = data ? groupByReservation(data.items, weekStart, colWidth, today) : [];
  // While searching, restrict the bars to rentals that touch a matched item
  // (mapped via the calendar_holds ledger on the backend).
  const matchedInv = searching ? searchResult?.items ?? [] : [];
  const relatedResIds = searching ? new Set(searchResult?.reservationIds ?? []) : null;
  const visibleResRows = relatedResIds
    ? resRows.filter((r) => relatedResIds.has(r.reservationId))
    : resRows;
  const searchLoading = searching && searchResult === undefined;

  // The immediate next upcoming rental (soonest pickup still in the future) —
  // its bar pulses so the next thing to happen always draws the eye.
  let nextUpcomingId: string | null = null;
  let bestStartMs = Infinity;
  for (const row of resRows) {
    if (!row.block.start_date) continue;
    const startMs = isoToDate(row.block.start_date).getTime() + timeFrac(row.block.pickup_time, 0) * DAY_MS;
    if (startMs > nowMs && startMs < bestStartMs) { bestStartMs = startMs; nextUpcomingId = row.reservationId; }
  }

  // Red "now" marker — placed inside today's column using the SAME 9am–10pm
  // business-hours compression as the bars, so it lines up with them.
  const nowTime = new Date(nowMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
  const todayIdx = Math.round((isoToDate(today).getTime() - isoToDate(weekStart).getTime()) / DAY_MS);
  const [nowH, nowM] = nowTime.split(":").map((s) => parseInt(s, 10));
  const nowBizFrac = Math.max(0, Math.min(1, (nowH * 60 + nowM - DAY_WINDOW_START_MIN) / (DAY_WINDOW_END_MIN - DAY_WINDOW_START_MIN)));
  const showNow = todayIdx >= 0 && todayIdx <= 6;
  const nowLeft = LABEL_WIDTH + (todayIdx + nowBizFrac) * colWidth;

  // Nav bounds — disable Prev at ~1 year back, Next at +4 weeks.
  const minWeek = addDays(mondayOfThisWeek(), -WEEK_BEHIND_CAP);
  const atMinWeek = weekStart <= minWeek;
  const atMaxWeek = weekStart >= addDays(mondayOfThisWeek(), WEEK_AHEAD_CAP);

  // When searching, gate on matched inventory; the loading state shows its own
  // message (see empty branch) rather than a premature "no match".
  const hasAnyBlocks = searching ? matchedInv.length > 0 : resRows.length > 0;

  const content = (
    <div
      className="gantt-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }}
      onClick={handleBackdropClick}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden shadow-2xl"
        style={{
          width: "95vw",
          maxWidth: 1480,
          height: "90vh",
          background: "rgba(10,14,28,0.98)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---- Header ---- */}
        <div
          className="flex items-center justify-between px-6 py-4 flex-shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}
        >
          <div>
            <h2 className="text-white font-bold text-lg leading-tight">Weekly Calendar</h2>
            <p className="text-gray-400 text-sm mt-0.5">{formatWeekRange(weekStart)}</p>
          </div>
          <button
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors text-xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ---- Sub-header navigation ---- */}
        <div
          className="flex items-center gap-2 px-6 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
        >
          <button
            className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-300"
            onClick={() => setWeekStart((w) => clampWeek(addDays(w, -7)))}
            disabled={atMinWeek}
          >
            ← Prev Week
          </button>
          <button
            className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
            onClick={() => setWeekStart(mondayOfThisWeek())}
          >
            Today
          </button>
          <button
            className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-300"
            onClick={() => setWeekStart((w) => clampWeek(addDays(w, 7)))}
            disabled={atMaxWeek}
          >
            Next Week →
          </button>

          {/* W08 search — filter rentals by item name or tag; shows availability */}
          <div className="relative flex items-center ml-3" style={{ width: 240, maxWidth: "38vw" }}>
            <svg
              className="absolute left-2.5 pointer-events-none"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgba(255,255,255,0.45)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item or tag…"
              className="w-full text-sm text-gray-100 rounded-lg outline-none placeholder:text-gray-500"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.10)",
                padding: "6px 26px 6px 30px",
              }}
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 text-gray-400 hover:text-white text-base leading-none"
              >
                ×
              </button>
            )}
          </div>
          {searching && !searchLoading && (
            <span className="text-[11px] text-gray-500 whitespace-nowrap hidden sm:inline">
              {matchedInv.length} item{matchedInv.length === 1 ? "" : "s"} · {visibleResRows.length} rental
              {visibleResRows.length === 1 ? "" : "s"}
            </span>
          )}

          {/* Legend — accounts (left stripe color) + booking status (fill). */}
          <div className="ml-auto hidden md:flex items-center gap-3 text-[11px] text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#3b82f6" }} />
              DB Cinema
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#a855f7" }} />
              Leo Adams
            </span>
            <span className="w-px h-3.5 bg-white/15" />
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: "#fbbf24" }} />
              Awaiting
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: "#60a5fa" }} />
              Out
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: "#34d399" }} />
              Done
            </span>
          </div>
        </div>

        {/* ---- Grid area ---- */}
        <div ref={gridRef} className="flex-1 overflow-auto">
          {data === undefined ? (
            // Loading skeleton
            <div className="flex flex-col gap-2 p-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-12 rounded-lg animate-pulse"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                />
              ))}
            </div>
          ) : !hasAnyBlocks ? (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm">
              {searching
                ? searchLoading
                  ? "Searching…"
                  : `No “${search.trim()}” rentals this week`
                : "No bookings this week"}
            </div>
          ) : (
            <div style={{ minWidth: LABEL_WIDTH + totalGridWidth }}>
              {/* Column header row */}
              <div
                className="flex sticky top-0 z-30"
                style={{ background: "rgba(10,14,28,0.98)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
              >
                {/* Renter/items label header */}
                <div
                  className="flex-shrink-0 flex items-center px-4 text-xs text-gray-500 uppercase tracking-wider font-medium"
                  style={{ width: LABEL_WIDTH, borderRight: "1px solid rgba(255,255,255,0.05)" }}
                >
                  Renter / Items
                </div>
                {/* Day headers */}
                {headers.map(({ label, iso }) => {
                  const isToday = iso === today;
                  return (
                    <div
                      key={iso}
                      className="flex-shrink-0 flex items-center justify-center text-xs font-medium py-3"
                      style={{
                        width: colWidth,
                        color: isToday ? "#3b82f6" : "#6b7280",
                        background: isToday ? "rgba(59,130,246,0.12)" : undefined,
                        borderRight: iso === today ? undefined : "1px solid rgba(255,255,255,0.04)",
                        boxShadow: isToday ? "inset 1px 0 0 rgba(59,130,246,0.35), inset -1px 0 0 rgba(59,130,246,0.35)" : undefined,
                      }}
                    >
                      {label}
                      {isToday && (
                        <span className="ml-1.5 w-1.5 h-1.5 rounded-full inline-block" style={{ background: "#3b82f6" }} />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* W08 — per-day unit availability for the searched item(s) */}
              {searching && matchedInv.length > 0 && (
                <div style={{ borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
                  {matchedInv.map((it) => {
                    const acc = "#3b82f6";
                    const cells = it.availability;
                    const total = it.qty;
                    return (
                      <div
                        key={it.item_id}
                        className="flex"
                        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", height: RES_ROW_HEIGHT }}
                      >
                        <div
                          className="flex-shrink-0 flex flex-col justify-center px-3"
                          style={{
                            width: LABEL_WIDTH,
                            borderLeft: `3px solid ${acc}`,
                            background: `${acc}14`,
                            borderRight: "1px solid rgba(255,255,255,0.05)",
                          }}
                        >
                          <span
                            className="text-[11px] text-gray-100 truncate leading-tight font-semibold"
                            title={it.name}
                          >
                            {it.name}
                          </span>
                          <span className="text-[10px] leading-tight" style={{ color: "#94a3b8" }}>
                            {(it as { owned?: boolean }).owned === false
                              ? "listed · not owned"
                              : `${total} unit${total === 1 ? "" : "s"} · free/day`}
                          </span>
                        </div>
                        <div className="relative flex" style={{ width: totalGridWidth }}>
                          {headers.map(({ iso }, i) => {
                            const cell = cells.find((c) => c.date === iso);
                            const free = cell?.free;
                            const pending = (cell as { pending?: number } | undefined)?.pending ?? 0;
                            const tot = cell?.total;
                            const freeFrom =
                              (cell as { free_from?: string | null } | undefined)?.free_from ?? null;
                            const showFrom = !!freeFrom && (free ?? 0) <= 0;
                            const isToday = iso === today;
                            let color = "#9ca3af";
                            let bg: string | undefined = isToday
                              ? "rgba(59,130,246,0.08)"
                              : i % 2 === 0
                              ? "rgba(255,255,255,0.01)"
                              : undefined;
                            if (free !== undefined && tot !== undefined) {
                              if (free <= 0) {
                                if (showFrom) {
                                  // Booked by date, but a unit returns mid-day.
                                  color = "#fbbf24";
                                  bg = "rgba(251,191,36,0.10)";
                                } else {
                                  color = "#f87171";
                                  bg = "rgba(248,113,113,0.10)";
                                }
                              } else if (free < tot) {
                                color = "#fbbf24";
                              } else {
                                color = "#34d399";
                              }
                            }
                            return (
                              <div
                                key={iso}
                                className="flex-shrink-0 flex flex-col items-center justify-center"
                                style={{ width: colWidth, background: bg, borderRight: "1px solid rgba(255,255,255,0.03)" }}
                                title={cell ? `${free} of ${tot} free · ${iso}${showFrom ? ` · 1 free from ${freeFrom}` : ""}` : `no data · ${iso}`}
                              >
                                <span className="text-sm font-bold tabular-nums leading-none" style={{ color }}>
                                  {free !== undefined ? free : "–"}
                                  {pending > 0 && <span className="text-[9px] font-semibold" style={{ color: "#a78bfa" }}>{` (-${pending})`}</span>}
                                </span>
                                {showFrom ? (
                                  <span className="text-[8px] leading-none mt-0.5" style={{ color: "#fbbf24" }}>
                                    {`fr ${freeFrom}`}
                                  </span>
                                ) : tot !== undefined ? (
                                  <span className="text-[9px] leading-none mt-0.5" style={{ color: "#64748b" }}>
                                    /{tot}
                                  </span>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Reservation rows + the sweeping red "now" line */}
              <div className="relative">
                {visibleResRows.map((row) => {
                  const renter = row.block.renter_name && row.block.renter_name.trim() !== "" && row.block.renter_name.trim() !== "?"
                    ? row.block.renter_name.trim()
                    : orderStepLabel(row.block.order_step);
                  return (
                    <div
                      key={row.reservationId}
                      className="flex"
                      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", height: RES_ROW_HEIGHT }}
                    >
                      {/* Left label — renter + item thumbnails. A bold account-
                          colored band (left bar + fading tint + dot) makes the
                          two accounts read apart clearly in the sidebar. */}
                      <div
                        className="flex-shrink-0 flex flex-col justify-center gap-1 pl-3 pr-3"
                        style={{
                          width: LABEL_WIDTH,
                          borderLeft: `6px solid ${row.acc}`,
                          background: `linear-gradient(90deg, ${row.acc}3d 0%, ${row.acc}1f 45%, ${row.acc}0a 100%)`,
                          borderRight: `1px solid ${row.acc}55`,
                        }}
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ background: row.acc, boxShadow: `0 0 5px ${row.acc}` }}
                          />
                          <span className="text-[11px] text-gray-100 truncate leading-none font-semibold" title={renter}>
                            {renter}
                          </span>
                        </span>
                        <ResThumbs items={row.items} ring={row.acc} />
                      </div>

                      {/* Track */}
                      <div className="relative flex-1" style={{ width: totalGridWidth }}>
                        {/* Day column backgrounds */}
                        {headers.map(({ iso }, i) => (
                          <div
                            key={iso}
                            className="absolute top-0 bottom-0"
                            style={{
                              left: i * colWidth,
                              width: colWidth,
                              background:
                                iso === today
                                  ? "rgba(59,130,246,0.08)"
                                  : i % 2 === 0
                                  ? "rgba(255,255,255,0.01)"
                                  : undefined,
                              borderRight: "1px solid rgba(255,255,255,0.03)",
                            }}
                          />
                        ))}

                        {/* The reservation bar — time-accurate */}
                        <ReservationBar
                          row={row}
                          height={BAR_HEIGHT}
                          isNext={row.reservationId === nextUpcomingId}
                          onSelect={() => setSelectedBlock({ block: row.block, items: row.items, accent: row.acc })}
                          liveProgress={liveProgress[row.reservationId] ?? null}
                          today={today}
                          weekStart={weekStart}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* Red "now" line — sweeps across as the day passes (this week only) */}
                {showNow && (
                  <div
                    className="absolute top-0 bottom-0 z-40 pointer-events-none"
                    style={{ left: nowLeft, width: 2, background: "#ef4444", boxShadow: "0 0 8px rgba(239,68,68,0.85)" }}
                  >
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full" style={{ background: "#ef4444" }} />
                    <div
                      className="absolute top-1.5 left-1/2 -translate-x-1/2 px-1 rounded text-[9px] font-bold leading-tight whitespace-nowrap"
                      style={{ background: "#ef4444", color: "#fff" }}
                    >
                      {nowTime}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Booking detail — docked to the modal so it never clips off-screen */}
        {selectedBlock && (
          <BlockDetail
            block={selectedBlock.block}
            items={selectedBlock.items}
            accent={selectedBlock.accent}
            onClose={() => setSelectedBlock(null)}
          />
        )}
      </div>
    </div>
  );

  // Portal to body to escape any stacking context
  if (typeof window === "undefined") return null;
  return createPortal(content, document.body);
}
