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

// ── Geometry — time-accurate bars + reservation grouping ───────────────────
const DAY_MS = 86400000;

/** Fraction of a day (0..1) for a "HH:MM[:SS]" time, or `fallback` if absent. */
function timeFrac(t: string | null, fallback: number): number {
  if (!t) return fallback;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  return Math.min(1, (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 1440);
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
  const startMs = isoToDate(block.start_date).getTime() + timeFrac(block.pickup_time, 0) * DAY_MS;
  // No return time → assume end of day so the bar still covers the return day.
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
}

/** Collapse the item-centric gantt payload into one row per reservation, so a
 *  renter who booked several items shows once with all their thumbnails — the
 *  same booking-centric view as the small dashboard calendar. */
function groupByReservation(items: GanttItem[], weekStart: string, colWidth: number, today: string): ResRow[] {
  const map = new Map<string, ResRow>();
  for (const item of items) {
    for (const block of item.blocks) {
      const geom = barGeom(block, weekStart, colWidth);
      if (!geom) continue;
      let row = map.get(block.reservation_id);
      if (!row) {
        const effReturn = block.return_date ?? block.end_date;
        const ongoing = !!block.start_date && !!effReturn && block.start_date <= today && today <= effReturn;
        // Colour by the reservation's account (item.account_color is always
        // blue — the items table has no account_slug). Leo → purple, else blue.
        const accColor: "blue" | "purple" = block.account_slug === "leo" ? "purple" : "blue";
        row = {
          reservationId: block.reservation_id,
          block,
          acc: accountColor(accColor),
          items: [],
          left: geom.left,
          width: geom.width,
          ongoing,
        };
        map.set(block.reservation_id, row);
      }
      if (!row.items.some((it) => it.name === item.item_name)) {
        row.items.push({ name: item.item_name, image: item.image_url });
      }
    }
  }
  return [...map.values()].sort((a, b) => {
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
  const shown = items.slice(0, 5);
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
}

// One time-accurate bar per reservation. Left stripe = account color, fill =
// status, glow + dot = ongoing. The bar physically ends at the return time.
function ReservationBar({ row, height, isNext, onSelect, liveProgress }: BarProps) {
  const { block, acc, ongoing } = row;
  const ss = statusStyle(block.order_step);
  const showProgress = block.order_step === "DELIVERED" && liveProgress !== null && liveProgress < 100;
  const hasRenter = !!block.renter_name && block.renter_name.trim() !== "" && block.renter_name.trim() !== "?";
  const renterLabel = hasRenter ? block.renter_name!.trim() : orderStepLabel(block.order_step);
  const pickup = block.pickup_time ? block.pickup_time.slice(0, 5) : null;
  const ret = block.return_time ? block.return_time.slice(0, 5) : null;
  const wide = row.width > 130;
  const tooltip = [
    renterLabel,
    row.items.map((i) => i.name).join(", "),
    block.start_date ? `${block.start_date} → ${block.return_date ?? block.end_date}` : null,
    pickup ? `pickup ${pickup}` : null,
    ret ? `return ${ret}` : null,
    ongoing ? "ONGOING" : null,
  ].filter(Boolean).join(" • ");

  return (
    <div
      className={`absolute rounded-md cursor-pointer overflow-hidden flex items-center gap-1.5 pl-2 pr-1.5 select-none transition-all hover:brightness-125${isNext ? " gantt-next-pulse" : ""}`}
      style={{
        left: row.left,
        width: row.width,
        top: (RES_ROW_HEIGHT - height) / 2,
        height,
        background: ss.bg,
        border: `1px solid ${isNext ? "#fbbf24" : ss.border}`,
        borderLeft: `4px solid ${acc}`,
        boxShadow: ongoing && !isNext ? `0 0 0 1.5px ${ss.border}, 0 0 10px ${ss.border}aa` : undefined,
      }}
      title={tooltip}
      onClick={onSelect}
    >
      {ongoing && (
        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={{ background: ss.text, boxShadow: `0 0 6px ${ss.text}` }} />
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
      {wide && ret && (
        <span className="text-[10px] font-mono flex-shrink-0 leading-none tabular-nums" style={{ color: ss.text, opacity: 0.8 }}>
          ↩{ret}
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
const LABEL_WIDTH = 250; // px for left "renter + thumbnails" column
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

  // The immediate next upcoming rental (soonest pickup still in the future) —
  // its bar pulses so the next thing to happen always draws the eye.
  let nextUpcomingId: string | null = null;
  let bestStartMs = Infinity;
  for (const row of resRows) {
    if (!row.block.start_date) continue;
    const startMs = isoToDate(row.block.start_date).getTime() + timeFrac(row.block.pickup_time, 0) * DAY_MS;
    if (startMs > nowMs && startMs < bestStartMs) { bestStartMs = startMs; nextUpcomingId = row.reservationId; }
  }

  // Red "now" marker — x within the visible week, only when today is in range.
  const nowDays = (nowMs - isoToDate(weekStart).getTime()) / DAY_MS;
  const showNow = nowDays >= 0 && nowDays <= 7;
  const nowLeft = LABEL_WIDTH + nowDays * colWidth;
  const nowTime = new Date(nowMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

  // Nav bounds — disable Prev at the current week, Next at +4 weeks.
  const minWeek = mondayOfThisWeek();
  const atMinWeek = weekStart <= minWeek;
  const atMaxWeek = weekStart >= addDays(minWeek, WEEK_AHEAD_CAP);

  const hasAnyBlocks = resRows.length > 0;

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

              {/* Reservation rows + the sweeping red "now" line */}
              <div className="relative">
                {resRows.map((row) => {
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
