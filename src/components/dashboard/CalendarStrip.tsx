"use client";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Lazy-import Gantt — won't fail if file doesn't exist yet
const CalendarGantt = lazy(() =>
  import("./CalendarGantt").catch(() => ({
    default: () => (
      <div className="p-6 text-center text-[#8b8fa3] text-sm">
        Weekly Calendar coming soon.
      </div>
    ),
  }))
);

// ── Types inferred from convex/calendar.ts return shape ─────────────────────
type ChipData = {
  reservationId: string;
  itemNames: (string | undefined)[];
  renterName: string;
  accountSlug: string | undefined;
  accountColor: string;
  status: string | undefined;
  pickupTime: string | null;
  returnTime: string | null;
  pickupMethod: string | null;
  returnMethod: string | null;
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

/** "Mon 13" */
function dayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.toLocaleString("en", { weekday: "short" });
  return `${day} ${d.getDate()}`;
}

/** Sum gross earnings hint: we don't have revenue in the strip data directly,
 *  so we skip the £ chip — could be wired later via a separate earnings field.
 *  For now show chip count instead as a fallback. */

// ── Availability dot logic ───────────────────────────────────────────────────
function AvailDot({ pickups, returns, holds }: { pickups: ChipData[]; returns: ChipData[]; holds: HoldData[] }) {
  const total = pickups.length + returns.length + holds.length;
  if (total === 0) {
    return <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1" title="Free" />;
  }
  // amber if some bookings; red if all holds (fully blocked)
  const allHeld = pickups.length === 0 && returns.length === 0 && holds.length > 0;
  const color = allHeld ? "bg-red-500" : "bg-amber-400";
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      <span className="text-[10px] text-[#8b8fa3]">{total}</span>
    </span>
  );
}

// ── Mini event dots (up to 3 + overflow) ─────────────────────────────────────
function EventDots({ pickups, returns, holds }: { pickups: ChipData[]; returns: ChipData[]; holds: HoldData[] }) {
  const all: { color: string; pending: boolean; key: string }[] = [
    ...pickups.map((p) => ({
      color: resolveColor(p.accountColor),
      pending: p.status === "pending_review",
      key: `p-${p.reservationId}`,
    })),
    ...returns.map((r) => ({
      color: resolveColor(r.accountColor),
      pending: r.status === "pending_review",
      key: `r-${r.reservationId}`,
    })),
    ...holds.map((h) => ({
      color: "#f59e0b",
      pending: false,
      key: `h-${h.holdId}`,
    })),
  ];
  const visible = all.slice(0, 3);
  const overflow = all.length - 3;
  return (
    <div className="flex items-center gap-0.5 flex-wrap mt-1">
      {visible.map((e) =>
        e.pending ? (
          <span
            key={e.key}
            className="inline-block w-2 h-2 rounded-full"
            style={{ border: `1.5px solid #f59e0b`, background: "transparent" }}
          />
        ) : (
          <span
            key={e.key}
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: e.color }}
          />
        )
      )}
      {overflow > 0 && (
        <span className="text-[10px] text-[#8b8fa3]">+{overflow}</span>
      )}
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function ProgressBar({
  progressPercent,
  barRef,
}: {
  progressPercent: number | null;
  barRef: (el: HTMLDivElement | null) => void;
}) {
  if (progressPercent === null || progressPercent >= 100) return null;
  return (
    <div className="mt-1.5 h-1 rounded-full bg-slate-700/60 overflow-hidden">
      <div
        ref={barRef}
        className="h-full rounded-full"
        style={{
          width: `${Math.max(0, progressPercent)}%`,
          background: "linear-gradient(90deg, #3b82f6, #10b981)",
          transition: "width 1s linear",
        }}
      />
    </div>
  );
}

// ── Single chip in the expanded drawer ───────────────────────────────────────
function StripChip({
  chip,
  type,
}: {
  chip: ChipData;
  type: "pickup" | "return";
}) {
  const color = resolveColor(chip.accountColor);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Store data attrs for live recompute
  const startAttr = useRef<string>("");
  const endAttr = useRef<string>("");

  // Live progress recompute — updates DOM directly, no Convex re-query
  useEffect(() => {
    if (chip.progressPercent === null || chip.progressPercent >= 100) return;

    // We don't have ISO pickup_at / return_at strings from strip data,
    // so we drive from progressPercent directly (already server-computed).
    // If the parent recomputes via setInterval, the chip re-renders naturally
    // via Convex subscription. For intra-render updates store a synthetic
    // start/end based on date + time strings if available.
    const el = barRef.current;
    if (!el) return;

    const interval = setInterval(() => {
      // Re-derive from data attrs set below
      const startMs = Number(el.dataset.start);
      const endMs = Number(el.dataset.end);
      if (!startMs || !endMs) return;
      const now = Date.now();
      const pct = Math.min(100, Math.max(0, ((now - startMs) / (endMs - startMs)) * 100));
      el.style.width = `${pct}%`;
    }, 300_000);

    return () => clearInterval(interval);
  }, [chip.progressPercent]);

  // Set data attributes on the bar div for the interval handler
  const setBarRef = (el: HTMLDivElement | null) => {
    barRef.current = el;
    if (el && chip.progressPercent !== null) {
      // Synthetic epoch based on today + time strings
      const today = new Date().toISOString().slice(0, 10);
      const parseTime = (t: string | null, dateStr: string): number => {
        if (!t) return 0;
        const [h, m] = t.split(":").map(Number);
        const d = new Date(`${dateStr}T00:00:00`);
        d.setHours(h, m, 0, 0);
        return d.getTime();
      };
      const startMs = parseTime(chip.pickupTime, today);
      const endMs = parseTime(chip.returnTime, today);
      if (startMs && endMs) {
        el.dataset.start = String(startMs);
        el.dataset.end = String(endMs);
      }
    }
  };

  const itemLabel = chip.itemNames.filter(Boolean).join(", ") || "—";
  const isDelivery = chip.pickupMethod === "delivery" || chip.returnMethod === "delivery";
  const showProgress =
    chip.progressPercent !== null &&
    chip.progressPercent >= 1 &&
    chip.progressPercent <= 99 &&
    chip.status === "DELIVERED";

  return (
    <div
      className="flex gap-2.5 p-2 rounded-lg"
      style={{ background: "rgba(255,255,255,0.03)", borderLeft: `3px solid ${color}` }}
    >
      {/* Thumbnail */}
      <div
        className="w-10 h-10 rounded-lg flex-shrink-0 overflow-hidden"
        style={{ background: "rgba(255,255,255,0.06)" }}
      >
        {chip.imageUrl ? (
          <img
            src={chip.imageUrl}
            alt={itemLabel}
            className="w-full h-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-xs font-bold"
            style={{ color, background: `${color}22` }}
          >
            {chip.renterName?.[0]?.toUpperCase() ?? "?"}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {/* Account dot */}
          <span
            className="inline-block w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: color }}
          />
          <span className="text-sm font-medium text-[#e4e6eb] truncate">
            {chip.renterName && chip.renterName !== "?"
              ? chip.renterName
              : chip.status === "pending_review" || chip.status === "REQUEST" || chip.status === "APPROVED"
                ? "Pending"
                : chip.accountSlug
                  ? `${chip.accountSlug} · ${chip.itemNames.filter(Boolean)[0] ?? "—"}`
                  : "?"}
          </span>
          {isDelivery && (
            <span className="text-xs ml-auto flex-shrink-0" title="Delivery">🚚</span>
          )}
        </div>

        <div className="text-xs text-[#8b8fa3] truncate mb-0.5">{itemLabel}</div>

        <div className="flex gap-2 text-xs text-[#8b8fa3]">
          {chip.pickupTime && (
            <span>🕐 Pickup {chip.pickupTime}</span>
          )}
          {chip.returnTime && (
            <span>🕐 Return {chip.returnTime}</span>
          )}
        </div>

        {showProgress && (
          <ProgressBar progressPercent={chip.progressPercent!} barRef={setBarRef} />
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
  const totalEvents = day.pickups.length + day.returns.length + day.holds.length;

  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 text-left rounded-xl p-3 transition-all duration-150 select-none"
      style={{
        width: "120px",
        minHeight: "140px",
        border: isToday
          ? "2px solid #3b82f6"
          : "1px solid rgba(255,255,255,0.08)",
        boxShadow: isToday
          ? "0 0 12px rgba(59,130,246,0.4), 0 0 24px rgba(59,130,246,0.15)"
          : isExpanded
            ? "0 4px 16px rgba(0,0,0,0.3)"
            : "none",
        background: isExpanded
          ? "rgba(59,130,246,0.07)"
          : isToday
            ? "rgba(59,130,246,0.05)"
            : "rgba(14,17,28,0.35)",
        transform: isExpanded ? "scale(1.02)" : "scale(1)",
      }}
    >
      {/* Date + Today pill */}
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="text-xs font-semibold"
          style={{ color: isToday ? "#3b82f6" : "#e4e6eb" }}
        >
          {dayLabel(day.date)}
        </span>
        {isToday && (
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: "rgba(59,130,246,0.2)", color: "#3b82f6" }}
          >
            Today
          </span>
        )}
      </div>

      {/* Availability dot */}
      <div className="mb-1">
        <AvailDot pickups={day.pickups} returns={day.returns} holds={day.holds} />
      </div>

      {/* Mini event dots */}
      <EventDots pickups={day.pickups} returns={day.returns} holds={day.holds} />

      {/* Bottom: pickup/return count badges */}
      <div className="flex gap-1 mt-auto pt-2 flex-wrap">
        {day.pickups.length > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}
          >
            ↑{day.pickups.length}
          </span>
        )}
        {day.returns.length > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6" }}
          >
            ↓{day.returns.length}
          </span>
        )}
        {day.holds.length > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
          >
            ●{day.holds.length}
          </span>
        )}
        {totalEvents === 0 && (
          <span className="text-[10px] text-[#8b8fa3]">—</span>
        )}
      </div>
    </button>
  );
}

// ── Expanded drawer for a day ─────────────────────────────────────────────────
function DayDrawer({ day }: { day: DayData }) {
  const hasAny = day.pickups.length + day.returns.length + day.holds.length > 0;
  return (
    <div
      className="w-full rounded-xl p-3 space-y-2"
      style={{
        background: "rgba(14,17,28,0.6)",
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(12px)",
      }}
    >
      {!hasAny && (
        <p className="text-xs text-[#8b8fa3] text-center py-2">No events this day</p>
      )}

      {day.pickups.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[#8b8fa3] mb-1.5 font-semibold">
            Pickups ({day.pickups.length})
          </div>
          <div className="space-y-1.5">
            {day.pickups.map((p) => (
              <StripChip key={String(p.reservationId)} chip={p} type="pickup" />
            ))}
          </div>
        </div>
      )}

      {day.returns.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-[#8b8fa3] mb-1.5 font-semibold">
            Returns ({day.returns.length})
          </div>
          <div className="space-y-1.5">
            {day.returns.map((r) => (
              <StripChip key={String(r.reservationId)} chip={r} type="return" />
            ))}
          </div>
        </div>
      )}

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
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function CalendarStrip() {
  const { activeAccountSlug } = useAccount();
  const today = TODAY_ISO();

  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [ganttOpen, setGanttOpen] = useState(false);

  const data = useQuery(api.calendar.getCalendarStrip, {
    accountSlug: activeAccountSlug,
    startDate: today,
    days: 7,
  });

  function toggleDay(date: string) {
    setExpandedDate((prev) => (prev === date ? null : date));
  }

  const expandedDay = data?.find((d) => d.date === expandedDate) ?? null;

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
          {data.map((day) => (
            <DayCard
              key={day.date}
              day={day as DayData}
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
