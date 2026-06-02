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
}

interface GanttItem {
  item_id: string | null;
  item_name: string;
  image_url: string | null;
  account_slug: string | null;
  account_color: "blue" | "purple";
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

// Navigation cap: current week .. +4 weeks (~1 month) ahead. No past weeks.
const WEEK_AHEAD_CAP = 28;

/** Clamp a Monday-ISO into [this week, +4 weeks]. ISO date strings compare
 *  lexicographically, so string `<`/`>` is a valid date order here. */
function clampWeek(iso: string): string {
  const min = mondayOfThisWeek();
  const max = addDays(min, WEEK_AHEAD_CAP);
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

function accountColor(ac: "blue" | "purple"): string {
  return ac === "purple" ? "#a855f7" : "#3b82f6";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ItemAvatar({ name, imageUrl, ring }: { name: string; imageUrl: string | null; ring: string }) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className="zoom-img w-8 h-8 rounded-md object-cover flex-shrink-0"
        style={{ border: `1.5px solid ${ring}` }}
      />
    );
  }
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 text-xs font-bold"
      style={{ background: `${ring}33`, color: ring, border: `1.5px solid ${ring}` }}
    >
      {initial}
    </div>
  );
}

// ── Block geometry + lane packing ──────────────────────────────────────────
// Each item row can hold several bookings. When their date ranges overlap they
// MUST go on separate lanes (sub-rows) or the labels render on top of each
// other (the old single-lane layout did exactly that). We greedily pack blocks
// into the fewest lanes and grow the row height to fit.
const COL_GAP = 4;
const DAY_MS = 86400000;

interface BlockGeom {
  block: Block;
  left: number;
  width: number;
  clampedStart: number;
  clampedEnd: number;
}

/** Pixel geometry for a block within the visible week, or null if off-week. */
function blockGeom(block: Block, weekStart: string, colWidth: number): BlockGeom | null {
  if (!block.start_date || !block.end_date) return null;
  const weekStartDay = isoToDate(weekStart).getTime();
  const weekEndDay = weekStartDay + 6 * DAY_MS;
  const blockStart = isoToDate(block.start_date).getTime();
  // Bar END honors the effective (negotiated) return date (return_date ?? end_date).
  const blockEnd = isoToDate(block.return_date ?? block.end_date).getTime();
  if (blockEnd < weekStartDay || blockStart > weekEndDay) return null; // not in view

  const clampedStart = Math.max(blockStart, weekStartDay);
  const clampedEnd = Math.min(blockEnd, weekEndDay);
  const startIdx = Math.round((clampedStart - weekStartDay) / DAY_MS);
  const daySpan = Math.round((clampedEnd - clampedStart) / DAY_MS) + 1;
  const left = startIdx * colWidth + COL_GAP;
  const width = Math.max(daySpan * colWidth - COL_GAP * 2, colWidth * 0.5);
  return { block, left, width, clampedStart, clampedEnd };
}

/** Greedy lane assignment: a block reuses the first lane whose previous block
 *  has already ended; otherwise it opens a new lane. Returns each block with
 *  its lane index plus the total lane count for the row. */
function packLanes(blocks: Block[], weekStart: string, colWidth: number): {
  placed: Array<BlockGeom & { lane: number }>;
  laneCount: number;
} {
  const geoms = blocks
    .map((b) => blockGeom(b, weekStart, colWidth))
    .filter((g): g is BlockGeom => g !== null)
    .sort((a, b) => a.clampedStart - b.clampedStart || a.clampedEnd - b.clampedEnd);

  const laneEnds: number[] = []; // clampedEnd of the last block on each lane
  const placed = geoms.map((g) => {
    let lane = laneEnds.findIndex((end) => end < g.clampedStart);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(g.clampedEnd); }
    else laneEnds[lane] = g.clampedEnd;
    return { ...g, lane };
  });
  return { placed, laneCount: Math.max(1, laneEnds.length) };
}

interface BlockProps {
  block: Block;
  itemName: string;
  left: number;
  width: number;
  top: number;
  height: number;
  accent: string;      // account color — left stripe so the owner reads at a glance
  ongoing: boolean;    // today falls within this rental → highlight as live
  onSelect: (b: Block) => void;
  liveProgress: number | null;
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

function GanttBlock({ block, itemName, left, width, top, height, accent, ongoing, onSelect, liveProgress }: BlockProps) {
  const ss = statusStyle(block.order_step);
  const showProgress =
    block.order_step === "DELIVERED" && liveProgress !== null && liveProgress < 100;

  const hasRenter = !!block.renter_name && block.renter_name.trim().length > 0 && block.renter_name.trim() !== "?";
  const renterLabel = hasRenter ? block.renter_name!.trim() : orderStepLabel(block.order_step);
  const time = block.pickup_time ? block.pickup_time.slice(0, 5) : null; // "18:00:00" → "18:00"

  // Tooltip carries the full context the compact block omits.
  const tooltipText = [
    renterLabel,
    itemName,
    block.start_date && block.end_date ? `${block.start_date} → ${block.end_date}` : null,
    time ? `pickup ${time}` : null,
    ongoing ? "ONGOING" : null,
  ].filter(Boolean).join(" • ");

  // Single readable line: renter (left) + time (right). The item name is the
  // row label, so it's intentionally not repeated inside the block. The left
  // stripe is the ACCOUNT color (owner reads which account at a glance); the
  // fill/border is the STATUS color. Ongoing rentals get a glow ring.
  return (
    <div
      className="absolute rounded-md cursor-pointer overflow-hidden flex items-center gap-1.5 pl-2.5 pr-2 select-none transition-all hover:brightness-125"
      style={{
        left,
        width,
        top,
        height,
        background: ss.bg,
        border: `1px solid ${ss.border}`,
        borderLeft: `4px solid ${accent}`,
        boxShadow: ongoing
          ? `0 0 0 1.5px ${ss.border}, 0 0 10px ${ss.border}aa`
          : undefined,
      }}
      title={tooltipText}
      onClick={() => onSelect(block)}
    >
      {ongoing && (
        <span
          className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
          style={{ background: ss.text, boxShadow: `0 0 6px ${ss.text}` }}
        />
      )}
      <span
        className="text-[11px] font-semibold truncate flex-1 leading-none"
        style={{
          color: ss.text,
          textDecoration: ss.strikethrough ? "line-through" : undefined,
          fontStyle: hasRenter ? undefined : "italic",
          opacity: hasRenter ? undefined : 0.8,
        }}
      >
        {renterLabel}
      </span>
      {time && (
        <span
          className="text-[10px] font-mono flex-shrink-0 leading-none tabular-nums"
          style={{ color: ss.text, opacity: 0.75 }}
        >
          {time}
        </span>
      )}
      {showProgress && (
        <div
          className="absolute left-0 bottom-0 h-0.5 rounded-full"
          style={{
            width: `${Math.min(100, liveProgress ?? 0)}%`,
            background: "linear-gradient(90deg, #3b82f6, #10b981)",
          }}
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
function BlockDetail({ block, itemName, accent, onClose }: { block: Block; itemName: string; accent: string; onClose: () => void }) {
  const ss = statusStyle(block.order_step);
  const fmtMethod = (m: string | null) =>
    m === "delivery" ? "🚚 Delivery" : m === "collection" ? "🤝 Collection" : m;
  const rows: Array<[string, string | null | undefined]> = [
    ["Status", orderStepLabel(block.order_step)],
    ["Renter", block.renter_name && block.renter_name !== "?" ? block.renter_name : "—"],
    ["From", block.start_date],
    // Effective (negotiated) return so an extended rental's detail matches its bar.
    ["To", block.return_date ?? block.end_date],
    ["Pickup", [block.pickup_time?.slice(0, 5), fmtMethod(block.pickup_method)].filter(Boolean).join(" · ") || null],
    ["Return", [block.return_time?.slice(0, 5), fmtMethod(block.return_method)].filter(Boolean).join(" · ") || null],
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
          <div className="text-[11px] text-gray-400 truncate mt-0.5" title={itemName}>{itemName}</div>
        </div>
        <button
          className="text-gray-400 hover:text-white text-lg leading-none flex-shrink-0"
          onClick={onClose}
          aria-label="Close detail"
        >
          ×
        </button>
      </div>
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
const LABEL_WIDTH = 200; // px for left item label column
const LANE_HEIGHT = 26; // px per booking lane within a row
const ROW_PAD = 5; // vertical padding inside each item row
const MIN_ROW_HEIGHT = 44; // floor so a single-lane row still fits the avatar

/** Row height for an item, sized to its lane count. */
function rowHeightFor(laneCount: number): number {
  return Math.max(MIN_ROW_HEIGHT, laneCount * LANE_HEIGHT + ROW_PAD * 2);
}

export default function CalendarGantt({ open, onClose, weekStartIso, accountSlug }: Props): React.ReactElement | null {
  const [weekStart, setWeekStart] = useState<string>(() => weekStartIso ?? mondayOfThisWeek());
  const [selectedBlock, setSelectedBlock] = useState<{ block: Block; itemName: string; accent: string } | null>(null);
  // live progress map: reservation_id → computed progress
  const [liveProgress, setLiveProgress] = useState<Record<string, number>>({});
  // Measured width of the scroll area so 7 day-columns fill it (no horizontal
  // scroll) instead of a fixed 150px/col that overflowed a 1200px modal.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);

  const data = useQuery(
    api.calendar.getGanttWeek,
    open ? { weekStartIso: weekStart, accountSlug: accountSlug ?? undefined } : "skip"
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

  // Nav bounds — disable Prev at the current week, Next at +4 weeks.
  const minWeek = mondayOfThisWeek();
  const atMinWeek = weekStart <= minWeek;
  const atMaxWeek = weekStart >= addDays(minWeek, WEEK_AHEAD_CAP);

  const hasAnyBlocks = data?.items.some((i) => i.blocks.length > 0) ?? false;

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
              No bookings this week
            </div>
          ) : (
            <div style={{ minWidth: LABEL_WIDTH + totalGridWidth }}>
              {/* Column header row */}
              <div
                className="flex sticky top-0 z-10"
                style={{ background: "rgba(10,14,28,0.98)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
              >
                {/* Item label header */}
                <div
                  className="flex-shrink-0 flex items-center px-4 text-xs text-gray-500 uppercase tracking-wider font-medium"
                  style={{ width: LABEL_WIDTH, borderRight: "1px solid rgba(255,255,255,0.05)" }}
                >
                  Item
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
                        borderLeft: isToday ? undefined : undefined,
                        borderRight: isToday ? undefined : "1px solid rgba(255,255,255,0.04)",
                        boxShadow: isToday ? "inset 1px 0 0 rgba(59,130,246,0.35), inset -1px 0 0 rgba(59,130,246,0.35)" : undefined,
                      }}
                    >
                      {label}
                      {isToday && (
                        <span
                          className="ml-1.5 w-1.5 h-1.5 rounded-full inline-block"
                          style={{ background: "#3b82f6" }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Item rows */}
              {data.items
                .filter((item) => item.blocks.length > 0)
                .map((item) => {
                  // Pack overlapping bookings into lanes so labels never collide.
                  const { placed, laneCount } = packLanes(item.blocks, weekStart, colWidth);
                  const rh = rowHeightFor(laneCount);
                  const acc = accountColor(item.account_color);
                  return (
                  <div
                    key={item.item_id ?? item.item_name}
                    className="flex"
                    style={{
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                      height: rh,
                    }}
                  >
                    {/* Left label — account-tinted so DB vs Leo reads at a glance */}
                    <div
                      className="flex-shrink-0 flex items-center gap-2 px-3"
                      style={{
                        width: LABEL_WIDTH,
                        borderLeft: `3px solid ${acc}`,
                        background: `${acc}0d`,
                        borderRight: "1px solid rgba(255,255,255,0.05)",
                      }}
                    >
                      <ItemAvatar name={item.item_name} imageUrl={item.image_url} ring={acc} />
                      <span
                        className="text-[11px] text-gray-200 truncate leading-tight font-medium"
                        title={item.item_name}
                      >
                        {item.item_name}
                      </span>
                    </div>

                    {/* Gantt track */}
                    <div
                      className="relative flex-1"
                      style={{ width: totalGridWidth }}
                    >
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
                                ? "rgba(59,130,246,0.11)"
                                : i % 2 === 0
                                ? "rgba(255,255,255,0.01)"
                                : undefined,
                            borderLeft: undefined,
                            borderRight: iso === today ? undefined : "1px solid rgba(255,255,255,0.03)",
                            boxShadow: iso === today ? "inset 1px 0 0 rgba(59,130,246,0.35), inset -1px 0 0 rgba(59,130,246,0.35)" : undefined,
                          }}
                        />
                      ))}

                      {/* Booking blocks — one per lane, positioned by geometry */}
                      {placed.map(({ block, left, width, lane }) => {
                        const effEnd = block.return_date ?? block.end_date;
                        const ongoing = !!block.start_date && !!effEnd &&
                          block.start_date <= today && today <= effEnd;
                        return (
                          <GanttBlock
                            key={block.reservation_id}
                            block={block}
                            itemName={item.item_name}
                            left={left}
                            width={width}
                            top={ROW_PAD + lane * LANE_HEIGHT}
                            height={LANE_HEIGHT - 6}
                            accent={acc}
                            ongoing={ongoing}
                            onSelect={(b) => setSelectedBlock({ block: b, itemName: item.item_name, accent: acc })}
                            liveProgress={liveProgress[block.reservation_id] ?? null}
                          />
                        );
                      })}
                    </div>
                  </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* Booking detail — docked to the modal so it never clips off-screen */}
        {selectedBlock && (
          <BlockDetail
            block={selectedBlock.block}
            itemName={selectedBlock.itemName}
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
