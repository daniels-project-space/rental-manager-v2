"use client";
import React, { useEffect, useState, useCallback } from "react";
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
function mondayOfThisWeek(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diff);
  return mon.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
  switch (orderStep) {
    case "REQUEST":
    case "APPROVED":
      return { bg: "rgba(245,158,11,0.18)", border: "#f59e0b", text: "#fbbf24" };
    case "FUNDS_RESERVED":
    case "VERIFIED":
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

function ItemAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
      />
    );
  }
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold"
      style={{ background: "rgba(59,130,246,0.25)", color: "#60a5fa" }}
    >
      {initial}
    </div>
  );
}

interface BlockProps {
  block: Block;
  itemName: string;
  weekStart: string;
  colWidth: number;
  onSelect: (b: Block) => void;
  liveProgress: number | null;
}

function GanttBlock({ block, itemName, weekStart, colWidth, onSelect, liveProgress }: BlockProps) {
  const COL_GAP = 4;
  const weekStartDay = isoToDate(weekStart).getTime();
  const DAY_MS = 86400000;

  if (!block.start_date || !block.end_date) return null;

  const blockStart = isoToDate(block.start_date).getTime();
  const blockEnd = isoToDate(block.end_date).getTime();

  // Clamp to week boundaries (Mon–Sun)
  const clampedStart = Math.max(blockStart, weekStartDay);
  const weekEndDay = weekStartDay + 6 * DAY_MS;
  const clampedEnd = Math.min(blockEnd, weekEndDay);

  const startIdx = Math.round((clampedStart - weekStartDay) / DAY_MS);
  const daySpan = Math.round((clampedEnd - clampedStart) / DAY_MS) + 1;

  const left = startIdx * colWidth + COL_GAP;
  const width = Math.max(daySpan * colWidth - COL_GAP * 2, colWidth * 0.5);

  const ss = statusStyle(block.order_step);
  const showProgress =
    block.order_step === "DELIVERED" && liveProgress !== null && liveProgress < 100;

  // Renter label: use name if present, else order_step-derived fallback
  function orderStepLabel(step: string | null): string {
    switch (step) {
      case "REQUEST": return "Request";
      case "APPROVED": return "Approved";
      case "FUNDS_RESERVED": return "Booked";
      case "VERIFIED": return "Verified";
      case "BOOKED_AFTER_VERIFIED": return "Confirmed";
      case "DELIVERED": return "Out";
      case "RETURNED": return "Returned";
      case "REVIEWED": return "Done";
      case "CANCELED": return "Cancelled";
      default: return "Booking";
    }
  }
  const hasRenter = block.renter_name && block.renter_name.trim().length > 0 && block.renter_name.trim() !== "?";
  const renterFallback = orderStepLabel(block.order_step);
  const renterShort = hasRenter
    ? ((block.renter_name!).length > 12 ? (block.renter_name!).slice(0, 12) + "…" : block.renter_name!)
    : renterFallback;

  // Tooltip: "{renter} • {item} • {start}→{end}"
  const tooltipText = [
    hasRenter ? block.renter_name : renterFallback,
    itemName,
    block.start_date && block.end_date ? `${block.start_date} → ${block.end_date}` : null,
    block.pickup_time ? `pickup ${block.pickup_time}` : null,
  ].filter(Boolean).join(" • ");

  return (
    <div
      className="absolute top-1 bottom-1 rounded-md cursor-pointer overflow-hidden flex flex-col justify-between px-2 py-1 select-none transition-opacity hover:opacity-90"
      style={{
        left,
        width,
        background: ss.bg,
        border: `1px solid ${ss.border}`,
      }}
      title={tooltipText}
      onClick={() => onSelect(block)}
    >
      <div
        className="text-[11px] font-semibold truncate leading-tight"
        style={{
          color: ss.text,
          textDecoration: ss.strikethrough ? "line-through" : undefined,
          fontStyle: hasRenter ? undefined : "italic",
          opacity: hasRenter ? undefined : 0.75,
          fontSize: hasRenter ? undefined : "10px",
        }}
      >
        {renterShort}
      </div>
      <div className="text-[9px] truncate leading-tight" style={{ color: ss.text, opacity: 0.6 }}>
        {itemName.length > 14 ? itemName.slice(0, 14) + "…" : itemName}
      </div>
      {block.pickup_time && (
        <div className="text-[10px] truncate" style={{ color: ss.text, opacity: 0.75 }}>
          {block.pickup_time}
        </div>
      )}
      {showProgress && (
        <div className="h-1 rounded-full mt-1" style={{ background: "rgba(255,255,255,0.1)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min(100, liveProgress ?? 0)}%`,
              background: "linear-gradient(90deg, #3b82f6, #10b981)",
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded chip detail panel
// ---------------------------------------------------------------------------
function BlockDetail({ block, onClose }: { block: Block; onClose: () => void }) {
  const ss = statusStyle(block.order_step);
  const rows: Array<[string, string | null | undefined]> = [
    ["Status", block.order_step],
    ["Renter", block.renter_name],
    ["From", block.start_date],
    ["To", block.end_date],
    ["Pickup", block.pickup_time ?? block.pickup_method],
    ["Return", block.return_time ?? block.return_method],
    ["Progress", block.progress_percent != null ? `${block.progress_percent}%` : null],
  ];
  return (
    <div
      className="absolute right-0 top-0 z-10 rounded-xl p-4 shadow-2xl min-w-[220px] max-w-xs"
      style={{
        background: "rgba(14,17,28,0.98)",
        border: `1px solid ${ss.border}`,
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold" style={{ color: ss.text }}>
          Booking Detail
        </span>
        <button
          className="text-gray-400 hover:text-white text-lg leading-none"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {rows
        .filter(([, v]) => v != null && v !== "")
        .map(([label, val]) => (
          <div key={label} className="flex gap-2 text-xs mb-1">
            <span className="text-gray-500 w-16 flex-shrink-0">{label}</span>
            <span className="text-gray-200 truncate">{val}</span>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
const COL_WIDTH = 150; // px per day column
const ROW_HEIGHT = 58; // px per item row
const LABEL_WIDTH = 280; // px for left item label column

export default function CalendarGantt({ open, onClose, weekStartIso, accountSlug }: Props): React.ReactElement | null {
  const [weekStart, setWeekStart] = useState<string>(() => weekStartIso ?? mondayOfThisWeek());
  const [selectedBlock, setSelectedBlock] = useState<Block | null>(null);
  // live progress map: reservation_id → computed progress
  const [liveProgress, setLiveProgress] = useState<Record<string, number>>({});

  const data = useQuery(
    api.calendar.getGanttWeek,
    open ? { weekStartIso: weekStart, accountSlug: accountSlug ?? undefined } : "skip"
  );

  // Sync prop weekStartIso if it changes while open
  useEffect(() => {
    if (weekStartIso) setWeekStart(weekStartIso);
  }, [weekStartIso]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setWeekStart((w) => addDays(w, -7));
      if (e.key === "ArrowRight") setWeekStart((w) => addDays(w, 7));
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
          const end = isoToDate(block.end_date as string).getTime() + 86400000; // inclusive
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

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).classList.contains("gantt-backdrop")) onClose();
  };

  if (!open) return null;

  const today = new Date().toISOString().slice(0, 10);
  const headers = dayHeaders(weekStart);
  const totalGridWidth = COL_WIDTH * 7;

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
          width: "90vw",
          maxWidth: 1200,
          height: "80vh",
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
            className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
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
            className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
          >
            Next Week →
          </button>
        </div>

        {/* ---- Grid area ---- */}
        <div className="flex-1 overflow-auto">
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
                        width: COL_WIDTH,
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
                .map((item) => (
                  <div
                    key={item.item_id ?? item.item_name}
                    className="flex"
                    style={{
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                      height: ROW_HEIGHT,
                    }}
                  >
                    {/* Left label */}
                    <div
                      className="flex-shrink-0 flex items-center gap-2.5 px-4"
                      style={{
                        width: LABEL_WIDTH,
                        borderRight: `2px solid ${accountColor(item.account_color)}99`,
                      }}
                    >
                      <ItemAvatar name={item.item_name} imageUrl={item.image_url} />
                      <span
                        className="text-xs text-gray-200 truncate leading-tight font-medium"
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
                            left: i * COL_WIDTH,
                            width: COL_WIDTH,
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

                      {/* Booking blocks */}
                      {item.blocks.map((block) => (
                        <GanttBlock
                          key={block.reservation_id}
                          block={block}
                          itemName={item.item_name}
                          weekStart={weekStart}
                          colWidth={COL_WIDTH}
                          onSelect={setSelectedBlock}
                          liveProgress={liveProgress[block.reservation_id] ?? null}
                        />
                      ))}

                      {/* Expanded detail chip */}
                      {selectedBlock &&
                        item.blocks.some(
                          (b) => b.reservation_id === selectedBlock.reservation_id
                        ) && (
                          <BlockDetail
                            block={selectedBlock}
                            onClose={() => setSelectedBlock(null)}
                          />
                        )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Portal to body to escape any stacking context
  if (typeof window === "undefined") return null;
  return createPortal(content, document.body);
}
