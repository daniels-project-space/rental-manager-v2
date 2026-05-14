"use client";
import { lazy, Suspense, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Lazy-load the full-week Gantt overlay so it doesn't bloat the initial bundle.
const CalendarGantt = lazy(() =>
  import("./CalendarGantt").catch(() => ({
    default: () => (
      <div className="p-6 text-center text-[#8b8fa3] text-sm">
        Weekly Calendar overlay unavailable.
      </div>
    ),
  })),
);

// ── Types inferred from convex/calendar.ts return shape ─────────────────────
type ChipData = {
  reservationId: string;
  kind?: "pickup" | "return" | "away";
  items: Array<{
    itemId: string | null;
    name: string;
    imageUrl: string | null;
    qty: number;
    resolved: boolean;
  }>;
  renterName: string;
  accountSlug: string | undefined;
  accountColor: string;
  status: string | undefined;
  orderStep?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  pickupTime: string | null;
  returnTime: string | null;
  pickupMethod: string | null;
  returnMethod: string | null;
  grossPaidGbp?: number | null;
  netToOwnerGbp?: number | null;
  notes?: string | null;
  imageUrl: string | null;
  progressPercent: number | null;
};

type HoldData = {
  holdId: string;
  itemId: string;
  itemName: string;
  holdItemName: string | null;
  holdRenterName: string | null;
  reservationId: string | undefined;
  renterName: string;
  accountSlug: string | undefined;
  status: string | undefined;
};

type DayData = {
  date: string;
  pickups: ChipData[];
  returns: ChipData[];
  away?: ChipData[];
  holds: HoldData[];
};

// ── Constants ────────────────────────────────────────────────────────────────
const ACCOUNT_COLORS: Record<string, string> = {
  blue: "#3b82f6",
  purple: "#a855f7",
};

function resolveColor(accountColor: string | undefined): string {
  return ACCOUNT_COLORS[accountColor ?? "blue"] ?? "#3b82f6";
}

function TODAY_ISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "MON" / 13 split — used by big day-card layout. */
function dayLabelSplit(dateStr: string): { wd: string; num: number } {
  const d = new Date(dateStr + "T00:00:00");
  return {
    wd: d.toLocaleString("en", { weekday: "short" }).toUpperCase(),
    num: d.getDate(),
  };
}

/** "11:00 AM, 11 May" — pickup/return inline label. */
function fmtTimeWithDate(time: string | null, isoDate: string | null): string {
  if (!time || !isoDate) return time ?? "tbd";
  const d = new Date(isoDate + "T00:00:00");
  const m = time.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return time;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const dateStr = d.toLocaleString("en", { day: "numeric", month: "short" });
  return `${h}:${min} ${ampm}, ${dateStr}`;
}

/** "11 May → 13 May (3d)" — inclusive day count. */
function fmtRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return "";
  const a = new Date(start + "T00:00:00");
  const b = new Date(end + "T00:00:00");
  const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
  const aStr = a.toLocaleString("en", { day: "numeric", month: "short" });
  if (start === end) return `${aStr} (1d)`;
  const bStr = b.toLocaleString("en", { day: "numeric", month: "short" });
  return `${aStr} → ${bStr} (${days}d)`;
}

/** "£48" — rounded, no decimals. */
function fmtGbp(n: number | null | undefined): string {
  if (n == null) return "";
  return "£" + Math.round(n).toLocaleString("en-GB");
}

/** "Wednesday, 13 May" */
function fmtFullDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleString("en", { weekday: "long", day: "numeric", month: "long" });
}

/** Live progress label + percent for a booking. */
function computeProgress(
  start: string | null | undefined,
  end: string | null | undefined,
  pickupTime: string | null,
  returnTime: string | null,
): { pct: number; label: string; status: "upcoming" | "active" | "completed" } {
  if (!start || !end) return { pct: 0, label: "", status: "upcoming" };
  const startD = new Date(start + "T00:00:00");
  if (pickupTime) {
    const [h, m] = pickupTime.split(":").map(Number);
    startD.setHours(h, m || 0, 0, 0);
  }
  const endD = new Date(end + "T00:00:00");
  if (returnTime) {
    const [h, m] = returnTime.split(":").map(Number);
    endD.setHours(h, m || 0, 0, 0);
  } else {
    endD.setHours(23, 59, 59, 999);
  }
  const startMs = startD.getTime();
  const endMs = endD.getTime();
  const now = Date.now();
  if (now < startMs) {
    const hours = Math.round((startMs - now) / 3_600_000);
    const label = hours < 24 ? `Starts in ${hours}h` : `Starts in ${Math.ceil(hours / 24)}d`;
    return { pct: 0, label, status: "upcoming" };
  }
  if (now >= endMs) {
    return { pct: 100, label: "Completed", status: "completed" };
  }
  const pct = Math.min(99, Math.max(1, Math.round(((now - startMs) / (endMs - startMs)) * 100)));
  const hoursLeft = Math.round((endMs - now) / 3_600_000);
  const label = hoursLeft < 24 ? `${hoursLeft}h remaining` : `${Math.ceil(hoursLeft / 24)}d remaining`;
  return { pct, label, status: "active" };
}

/** Split a `notes` blob into bullet lines (handles newline + "• "/"- " prefixes). */
function splitNotes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n|(?:^|\s)[•\-]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}


// ── Per-item thumbnail + row helpers ─────────────────────────────────────────
type ChipItem = ChipData["items"][number];

function ItemThumb({ item, size = 28 }: { item: ChipItem; size?: number }) {
  if (item.imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.imageUrl}
        alt=""
        className="rounded object-cover flex-shrink-0"
        loading="lazy"
        style={{ width: size, height: size }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div
      className="rounded flex items-center justify-center flex-shrink-0 text-[10px]"
      style={{
        width: size,
        height: size,
        background: "rgba(255,255,255,0.04)",
        color: "#6b6f80",
      }}
    >
      —
    </div>
  );
}

function ItemRow({ item }: { item: ChipItem }) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <ItemThumb item={item} size={28} />
      <span className="text-[11px] text-[#e4e6eb] truncate flex-1">{item.name}</span>
      {item.qty > 1 && (
        <span className="text-[10px] text-[#8b8fa3] flex-shrink-0">× {item.qty}</span>
      )}
    </div>
  );
}

// ── V1-style rich booking card ───────────────────────────────────────────────
function BookingCard({ chip }: { chip: ChipData }) {
  const color = resolveColor(chip.accountColor);
  const [expanded, setExpanded] = useState(false);

  const kind = chip.kind ?? "pickup";
  const isLeo = chip.accountSlug === "leo";
  const isPickupDelivery = chip.pickupMethod === "delivery";
  const isReturnDelivery = chip.returnMethod === "delivery";

  const badgeText =
    kind === "pickup"
      ? isPickupDelivery
        ? "🚚 DELIVERY"
        : "PICKUP"
      : kind === "return"
        ? isReturnDelivery
          ? "🚚 DELIVERY"
          : "RETURN"
        : "AWAY";
  const badgeStyle: React.CSSProperties =
    kind === "pickup"
      ? { background: "rgba(34,197,94,0.16)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }
      : kind === "return"
        ? { background: "rgba(168,85,247,0.16)", color: "#c084fc", border: "1px solid rgba(168,85,247,0.3)" }
        : { background: "rgba(107,114,128,0.16)", color: "#9ca3af", border: "1px solid rgba(107,114,128,0.3)" };

  const items = chip.items ?? [];
  const range = fmtRange(chip.startDate, chip.endDate);
  const pickupLabel = fmtTimeWithDate(chip.pickupTime, chip.startDate ?? null);
  const returnLabel = fmtTimeWithDate(chip.returnTime, chip.endDate ?? null);
  const progress = computeProgress(chip.startDate, chip.endDate, chip.pickupTime, chip.returnTime);
  const noteLines = splitNotes(chip.notes);

  // Collection / delivery tag
  let collectionTag: { text: string; tone: "delivery" | "collection" } | null = null;
  if (isPickupDelivery && isReturnDelivery) {
    collectionTag = { text: "🚚 Delivery (both ways)", tone: "delivery" };
  } else if (isPickupDelivery) {
    collectionTag = { text: "🚚 Delivery: pickup", tone: "delivery" };
  } else if (isReturnDelivery) {
    collectionTag = { text: "🚚 Delivery: return", tone: "delivery" };
  } else if (chip.pickupMethod === "collection" && chip.returnMethod === "collection") {
    collectionTag = { text: "Collection (both ways)", tone: "collection" };
  } else if (chip.pickupMethod === "collection") {
    collectionTag = { text: "Pickup: collection", tone: "collection" };
  } else if (chip.returnMethod === "collection") {
    collectionTag = { text: "Return: collection", tone: "collection" };
  }

  const progressColor =
    progress.status === "completed" ? "#22c55e" : progress.status === "active" ? "#3b82f6" : "#6b7280";

  const renterDisplay =
    chip.renterName && chip.renterName !== "?"
      ? chip.renterName
      : chip.status === "pending_review" || chip.orderStep === "REQUEST" || chip.orderStep === "APPROVED"
        ? "Pending"
        : "?";

  return (
    <div
      className="flex gap-3 p-2.5 rounded-lg"
      style={{ background: "rgba(255,255,255,0.03)", borderLeft: `3px solid ${color}` }}
    >
      {/* Thumbnail */}
      <div
        className="w-14 h-14 rounded-lg flex-shrink-0 overflow-hidden"
        style={{ background: "rgba(255,255,255,0.06)" }}
      >
        {chip.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={chip.imageUrl}
            alt={items[0]?.name ?? ""}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-base font-bold"
            style={{ color, background: `${color}22` }}
          >
            {renterDisplay[0]?.toUpperCase() ?? "?"}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        {/* Top row: badge | account chip | renter | £ */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
            style={badgeStyle}
          >
            {badgeText}
          </span>
          <span
            className="text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{
              background: isLeo ? "rgba(168,85,247,0.18)" : "rgba(110,168,254,0.18)",
              color: isLeo ? "#c084fc" : "#6ea8fe",
            }}
          >
            {isLeo ? "Leo" : "DB"}
          </span>
          <span className="text-sm font-semibold text-[#e4e6eb] truncate">{renterDisplay}</span>
          {chip.grossPaidGbp != null && (
            <span className="ml-auto text-sm font-bold" style={{ color: "#22c55e" }}>
              {fmtGbp(chip.grossPaidGbp)}
            </span>
          )}
        </div>

        {/* Meta row: range + pickup/return inline + collection tag */}
        <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-[#8b8fa3]">
          {range && <span>{range}</span>}
          {(chip.pickupTime || chip.returnTime || chip.startDate || chip.endDate) && (
            <>
              <span className="text-[#3a3d4a]">·</span>
              <span>
                <span className="text-[#6b6f80] uppercase tracking-wider mr-1">pickup</span>
                <span className="text-[#c9cdd5] font-medium">{pickupLabel}</span>
              </span>
              <span className="text-[#3a3d4a]">|</span>
              <span>
                <span className="text-[#6b6f80] uppercase tracking-wider mr-1">return</span>
                <span className="text-[#c9cdd5] font-medium">{returnLabel}</span>
              </span>
            </>
          )}
          {collectionTag && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full"
              style={
                collectionTag.tone === "delivery"
                  ? { background: "rgba(245,158,11,0.12)", color: "#fbbf24" }
                  : { background: "rgba(255,255,255,0.06)", color: "#9ca3af" }
              }
            >
              {collectionTag.text}
            </span>
          )}
        </div>

        {/* Item dropdown — per-item thumbnail + canonical name */}
        {items.length > 0 && (
          <div className="mt-1.5">
            {items.length === 1 ? (
              <ItemRow item={items[0]} />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setExpanded((x) => !x)}
                  className="w-full text-left text-[11px] px-2 py-1.5 rounded flex items-center gap-2 transition-colors hover:bg-white/[0.07]"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <ItemThumb item={items[0]} size={20} />
                  <span className="text-[#e4e6eb] truncate flex-1">
                    {items[0].name}
                    {items[0].qty > 1 && (
                      <span className="text-[#8b8fa3] ml-1">× {items[0].qty}</span>
                    )}
                  </span>
                  <span className="text-[#8b8fa3] flex-shrink-0">+{items.length - 1}</span>
                  <span className="text-[#8b8fa3] flex-shrink-0">{expanded ? "▴" : "▾"}</span>
                </button>
                {expanded && (
                  <div className="mt-1 space-y-1">
                    {items.slice(1).map((it, i) => (
                      <ItemRow key={(it.itemId ?? "") + i} item={it} />
                    ))}
                  </div>
                )}
              </>
            )}
            {items.some((i) => !i.resolved) && (
              <div className="mt-1 text-[9px] text-amber-300/70 italic">
                Items pending resolution — names refresh within 5 min
              </div>
            )}
          </div>
        )}

        {/* Progress bar with label */}
        {progress.label && (
          <div className="mt-2">
            <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${progress.pct}%`,
                  background: progressColor,
                  transition: "width 1s linear",
                }}
              />
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px]">
              <span style={{ color: progressColor }}>{progress.label}</span>
              <span className="text-[#6b6f80]">{progress.pct}%</span>
            </div>
          </div>
        )}

        {/* Notes */}
        {noteLines.length > 0 && (
          <div
            className="mt-2 rounded-md px-2.5 py-1.5"
            style={{ background: "rgba(110,168,254,0.06)", borderLeft: "2px solid #6ea8fe" }}
          >
            <div className="text-[10px] font-semibold text-[#6ea8fe] mb-0.5">📋 Notes</div>
            {noteLines.map((n, i) => (
              <div key={i} className="text-[11px] text-[#c9cdd5] leading-relaxed">
                • {n}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Day card ─────────────────────────────────────────────────────────────────
function DayCard({
  day,
  isToday,
  isExpanded,
  onClick,
}: {
  day: DayData;
  isToday: boolean;
  isExpanded: boolean;
  onClick: () => void;
}) {
  const away = day.away ?? [];
  const totalEvents = day.pickups.length + day.returns.length + away.length + day.holds.length;
  const { wd, num } = dayLabelSplit(day.date);

  // Per-card color dots: green = pickup, red = return, blue = away (matches v1 screenshot).
  const dots: string[] = [];
  if (day.pickups.length > 0) dots.push("#22c55e");
  if (day.returns.length > 0) dots.push("#ef4444");
  if (away.length > 0) dots.push("#3b82f6");
  if (day.holds.length > 0) dots.push("#f59e0b");

  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 text-left rounded-xl p-3 transition-all duration-150 select-none"
      style={{
        width: "120px",
        minHeight: "140px",
        border: "1px solid rgba(255,255,255,0.08)",
        outline: isToday ? "2px solid #3b82f6" : undefined,
        outlineOffset: isToday ? "-1px" : undefined,
        boxShadow: isToday
          ? "inset 0 0 0 2px #3b82f6, 0 0 12px rgba(59,130,246,0.4), 0 0 24px rgba(59,130,246,0.15)"
          : isExpanded
            ? "0 4px 16px rgba(0,0,0,0.3)"
            : "none",
        background: isExpanded
          ? "rgba(59,130,246,0.07)"
          : isToday
            ? "rgba(59,130,246,0.05)"
            : "rgba(14,17,28,0.35)",
        transform: isExpanded ? "scale(1.02)" : "scale(1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
      }}
    >
      {/* Weekday (small, uppercase, muted) */}
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8b8fa3]">
        {wd}
      </div>
      {/* Date number — large */}
      <div
        className="text-2xl font-bold mt-0.5"
        style={{ color: isToday ? "#3b82f6" : "#e4e6eb" }}
      >
        {num}
      </div>
      {isToday && (
        <span
          className="text-[9px] font-bold px-1.5 py-0.5 rounded-full mt-0.5"
          style={{ background: "rgba(59,130,246,0.2)", color: "#3b82f6" }}
        >
          Today
        </span>
      )}

      {/* Color dots row */}
      {dots.length > 0 && (
        <div className="flex items-center gap-1 mt-2">
          {dots.map((c, i) => (
            <span
              key={i}
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: c }}
            />
          ))}
        </div>
      )}

      {/* Count number below dots */}
      <div className="mt-auto pt-2 text-[11px] text-[#8b8fa3] font-medium">
        {totalEvents > 0 ? totalEvents : "—"}
      </div>
    </button>
  );
}

// ── Expanded drawer for a day ─────────────────────────────────────────────────
function DayDrawer({ day }: { day: DayData }) {
  const away = day.away ?? [];
  const allBookings: ChipData[] = [...day.pickups, ...day.returns, ...away];
  const bookingCount = allBookings.length;
  const totalGross = allBookings.reduce((sum, b) => sum + (b.grossPaidGbp ?? 0), 0);
  const hasAny = bookingCount + day.holds.length > 0;

  return (
    <div
      className="w-full rounded-xl p-3 space-y-3"
      style={{
        background: "rgba(14,17,28,0.6)",
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Header: "Wednesday, 13 May — 5 bookings" */}
      <div
        className="flex items-baseline justify-between pb-2"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <span className="text-sm font-semibold text-[#e4e6eb]">
          {fmtFullDate(day.date)}
          {bookingCount > 0 && (
            <span className="text-[#8b8fa3] font-normal">
              {" "}— {bookingCount} booking{bookingCount === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </div>

      {!hasAny && (
        <p className="text-xs text-[#8b8fa3] text-center py-2">No events this day</p>
      )}

      {/* All bookings (pickups + returns + away) rendered uniformly */}
      {allBookings.length > 0 && (
        <div className="space-y-2">
          {allBookings.map((b) => (
            <BookingCard key={`${b.kind}-${String(b.reservationId)}`} chip={b} />
          ))}
        </div>
      )}

      {/* Holds */}
      {day.holds.length > 0 && (
        <div>
          <div
            className="text-[10px] uppercase tracking-wider mb-1.5 font-semibold"
            style={{ color: "#f59e0b" }}
          >
            Holds ({day.holds.length})
          </div>
          <div className="space-y-1">
            {day.holds.map((h) => (
              <div
                key={String(h.holdId)}
                className="flex items-center gap-2 px-2 py-1 rounded-lg text-xs"
                style={{
                  background: "rgba(245,158,11,0.08)",
                  borderLeft: "3px solid #f59e0b",
                }}
              >
                <span className="text-[#e4e6eb] truncate">{h.holdItemName ?? h.itemName}</span>
                {h.holdRenterName && (
                  <span className="text-[#8b8fa3] ml-auto flex-shrink-0">
                    {h.holdRenterName}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Day summary footer */}
      {bookingCount > 0 && (
        <div
          className="flex items-center gap-3 text-[11px] text-[#8b8fa3] pt-2"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          {day.pickups.length > 0 && (
            <span>{day.pickups.length} pickup{day.pickups.length === 1 ? "" : "s"}</span>
          )}
          {day.returns.length > 0 && (
            <span>{day.returns.length} return{day.returns.length === 1 ? "" : "s"}</span>
          )}
          {away.length > 0 && <span>{away.length} away</span>}
          {totalGross > 0 && (
            <span className="ml-auto font-bold" style={{ color: "#22c55e" }}>
              {fmtGbp(totalGross)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function CalendarStrip() {
  const { activeAccountSlug } = useAccount();
  const today = TODAY_ISO();

  // Auto-expand today on load so the drawer shows up without a click.
  const [expandedDate, setExpandedDate] = useState<string | null>(today);
  const [ganttOpen, setGanttOpen] = useState(false);

  const data = useQuery(api.calendar.getCalendarStrip, {
    accountSlug: activeAccountSlug,
    startDate: today,
    days: 7,
  });

  function toggleDay(date: string) {
    setExpandedDate((prev) => (prev === date ? null : date));
  }

  const expandedDay =
    (data as DayData[] | undefined)?.find((d) => d.date === expandedDate) ?? null;

  return (
    <Card>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-[#e4e6eb]">
          Rental Calendar
        </span>
        <div className="flex items-center gap-2">
          {/* Color legend */}
          <div className="flex items-center gap-1.5 text-[10px] text-[#8b8fa3]">
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              Free
            </span>
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
              Partial
            </span>
            <span className="flex items-center gap-0.5">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
              Full
            </span>
          </div>
          <button
            onClick={() => setGanttOpen(true)}
            className="text-xs px-3 py-1.5 rounded-lg transition-all duration-150 hover:bg-blue-500/10 hover:border-blue-400/60 active:scale-95"
            style={{
              border: "1px solid rgba(59,130,246,0.45)",
              color: "#60a5fa",
              fontWeight: 600,
            }}
          >
            📅 Weekly View
          </button>
        </div>
      </div>

      {/* Strip */}
      {data === undefined ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonBlock key={i} className="flex-shrink-0 h-36 w-[120px]" />
          ))}
        </div>
      ) : (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
        >
          {(data as DayData[]).map((day) => (
            <DayCard
              key={day.date}
              day={day}
              isToday={day.date === today}
              isExpanded={expandedDate === day.date}
              onClick={() => toggleDay(day.date)}
            />
          ))}
        </div>
      )}

      {/* Inline expanded drawer — below the strip */}
      {expandedDay && (
        <div className="mt-2">
          <DayDrawer day={expandedDay as DayData} />
        </div>
      )}

      {/* Gantt overlay (lazy) */}
      {ganttOpen && (
        <Suspense fallback={<SkeletonBlock className="h-48 mt-3" />}>
          <CalendarGantt
            open={ganttOpen}
            onClose={() => setGanttOpen(false)}
            weekStartIso={today}
            accountSlug={activeAccountSlug ?? undefined}
          />
        </Suspense>
      )}
    </Card>
  );
}
