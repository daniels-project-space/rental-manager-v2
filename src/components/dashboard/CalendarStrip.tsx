"use client";
import { lazy, Suspense, useEffect, useState } from "react";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
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
  /** Effective (negotiated) pickup date; falls back to startDate server-side. */
  pickupDate?: string | null;
  endDate?: string | null;
  /** Effective (negotiated) return date; falls back to endDate server-side. */
  returnDate?: string | null;
  pickupTime: string | null;
  returnTime: string | null;
  pickupMethod: string | null;
  returnMethod: string | null;
  grossPaidGbp?: number | null;
  notes?: string | null;
  imageUrl: string | null;
  /** Alt text from the SAME item that provided imageUrl (server-side). */
  imageAlt?: string | null;
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
  orange: "#f97316",
  emerald: "#10b981", // dbcinema_web (DB Cinema website)
};

function resolveColor(accountColor: string | undefined): string {
  return ACCOUNT_COLORS[accountColor ?? "blue"] ?? "#3b82f6";
}

/**
 * "Today" in the business timezone (Europe/London), "YYYY-MM-DD".
 * Inlined twin of convex/lib/effectiveDates.ts:londonToday (same
 * inline-mirror convention as the predicates helpers). DST-correct via Intl —
 * NOT a fixed offset. Used so the strip anchor + status classify on the same
 * calendar day as the backend Active tab (which also uses London), instead
 * of UTC which can lag just after London midnight.
 */
function TODAY_ISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

/** Add n days to a YYYY-MM-DD date (UTC-parsed, no instant drift). */
function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the week containing the given date — for the
 *  Gantt handoff, which is Monday-aligned while this strip anchors on today. */
function mondayOf(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
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

/** Live progress label + percent for a booking.
 *
 * STATUS (upcoming/active/completed) is decided by a date-STRING compare of the
 * effective pickup/return dates against the London-business "today", so it
 * matches the backend Active tab exactly (isOngoing: pick<=today<=ret;
 * isUpcoming: pick>today). Previously status came from browser-LOCAL instant
 * math (Date.now() vs start/end ms), which disagreed with the UTC-based Active
 * tab just after London midnight (a rental read active here but upcoming
 * there). The PERCENTAGE within an active rental stays time-interpolated for a
 * smooth live bar.
 */
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
  // Fully TIME-aware now (was day-based): before the pickup MOMENT = upcoming
  // (the red lead-up), after the return MOMENT = returned (green), between = out.
  if (now < startMs) {
    const mins = Math.round((startMs - now) / 60000);
    const label =
      mins <= 0 ? "Starting"
      : mins < 60 ? `Starts in ${mins}m`
      : mins < 1440 ? `Starts in ${Math.round(mins / 60)}h`
      : `Starts in ${Math.ceil(mins / 1440)}d`;
    return { pct: 0, label, status: "upcoming" };
  }
  if (now >= endMs) {
    return { pct: 100, label: "Returned", status: "completed" };
  }
  // Active: picked up, not yet returned. PCT is time-interpolated, clamped [1,99].
  const pct =
    endMs > startMs
      ? Math.min(99, Math.max(1, Math.round(((now - startMs) / (endMs - startMs)) * 100)))
      : 1;
  const hoursLeft = Math.round((endMs - now) / 3_600_000);
  const label = hoursLeft <= 0
    ? "Due"
    : hoursLeft < 24 ? `${hoursLeft}h remaining` : `${Math.ceil(hoursLeft / 24)}d remaining`;
  return { pct, label, status: "active" };
}

/** Compact countdown string: "2d 3h", "3h 20m", "45m", "now". */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * The soonest UPCOMING pickup on a day (not yet started) → a lead-up to the
 * pickup: a red bar whose fill grows as the pickup approaches (over a 72h
 * horizon) + a live countdown. Returns null when nothing on the day is still
 * ahead of its pickup time.
 */
function nextPickupLeadup(pickups: ChipData[]): { fillPct: number; countdown: string; soon: boolean } | null {
  const now = Date.now();
  let bestMs = Infinity;
  for (const c of pickups) {
    const eff = c.pickupDate ?? c.startDate ?? null;
    if (!eff) continue;
    const d = new Date(eff + "T00:00:00");
    if (c.pickupTime) {
      const [h, m] = c.pickupTime.split(":").map(Number);
      d.setHours(h, m || 0, 0, 0);
    }
    const ms = d.getTime();
    if (ms > now && ms < bestMs) bestMs = ms;
  }
  if (bestMs === Infinity) return null;
  const untilMs = bestMs - now;
  const untilH = untilMs / 3_600_000;
  const fillPct = Math.max(6, Math.min(100, Math.round((1 - untilH / 72) * 100)));
  return { fillPct, countdown: fmtCountdown(untilMs), soon: untilH <= 6 };
}

/**
 * Soonest still-upcoming pickup OR return on a day, in ms (Infinity if the day
 * has nothing left ahead of now). Used to sort the strip so the day with the
 * next pickup/return is first.
 */
function dayNextEventMs(day: DayData): number {
  const now = Date.now();
  let best = Infinity;
  const consider = (dateStr: string | null | undefined, timeStr: string | null) => {
    if (!dateStr) return;
    const d = new Date(dateStr + "T00:00:00");
    if (timeStr) {
      const [h, m] = timeStr.split(":").map(Number);
      d.setHours(h, m || 0, 0, 0);
    } else {
      d.setHours(23, 59, 59, 999);
    }
    const ms = d.getTime();
    if (ms >= now && ms < best) best = ms;
  };
  for (const c of day.pickups) consider(c.pickupDate ?? c.startDate, c.pickupTime);
  for (const c of day.returns ?? []) consider(c.returnDate ?? c.endDate, c.returnTime);
  return best;
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
      <ItemThumb item={item} size={34} />
      <span className="text-[11px] text-[#e4e6eb] truncate flex-1">{item.name}</span>
      {item.qty > 1 && (
        <span className="text-[10px] text-[#8b8fa3] flex-shrink-0">× {item.qty}</span>
      )}
    </div>
  );
}

// Distinct method pills — courier truck for delivery, handshake for
// collection, gear-icon for unknown. Pickup pills are teal-tinted; return
// pills are violet-tinted, so even when both are present you can tell the
// direction without reading the label.
function MethodPill({
  direction,
  method,
}: {
  direction: "pickup" | "return";
  method: string;
}) {
  const isDelivery = method === "delivery";
  const isCollection = method === "collection";
  const tone =
    direction === "pickup"
      ? { bg: "rgba(34,197,94,0.12)", color: "#22c55e", border: "rgba(34,197,94,0.32)" }
      : { bg: "rgba(168,85,247,0.12)", color: "#c084fc", border: "rgba(168,85,247,0.32)" };
  // Delivery is louder: amber regardless of direction, bold border.
  const deliveryTone = {
    bg: "rgba(245,158,11,0.22)",
    color: "#fbbf24",
    border: "rgba(245,158,11,0.55)",
  };
  const t = isDelivery ? deliveryTone : tone;
  const icon = isDelivery ? "🚚" : isCollection ? "🤝" : "❓";
  const label =
    direction === "pickup" ? "Pickup" : "Return";
  const verb = isDelivery ? "delivered" : isCollection ? "collected" : "unknown";
  const dirArrow = direction === "pickup" ? "↓" : "↑";
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
      style={{
        background: t.bg,
        color: t.color,
        border: `1px solid ${t.border}`,
      }}
      title={`${label} ${verb}`}
    >
      <span style={{ fontWeight: 700, opacity: 0.7 }}>{dirArrow}</span>
      <span style={{ fontSize: 12, lineHeight: 1 }}>{icon}</span>
      <span>{label}</span>
    </span>
  );
}

// ── Live tick — forces re-render every `ms` while `active` is true. ─────────
//  Used by the progress timeline so the now-marker creeps without needing a
//  Convex re-fetch. Idle-rental cards never start the interval.
function useTick(ms: number, active: boolean) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

// ── Time formatting helpers used by the timeline ────────────────────────────
function fmt12Short(time: string | null): string {
  if (!time) return "TBD";
  const m = time.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return time;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min}${ampm}`;
}
function dayShort(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleString("en", { day: "numeric", month: "short" });
}

// ── Progress timeline ──────────────────────────────────────────────────────
//  Replaces the flat 1-px bar with a richer ticker:
//   ┌─────────────────────────────────────────────────────┐
//   │ ▶ 11:00AM · 11 May          10:00AM · 13 May ◀     │
//   │ ════════════●─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
//   │ ● 1d 14h remaining                            45%   │
//   └─────────────────────────────────────────────────────┘
function ProgressTimeline({
  chip,
  progress,
}: {
  chip: ChipData;
  progress: { pct: number; label: string; status: "upcoming" | "active" | "completed" };
}) {
  const isActive = progress.status === "active";
  const isCompleted = progress.status === "completed";
  const isUpcoming = progress.status === "upcoming";

  // RED lead-up: how close we are to the pickup MOMENT (fills over a 72h horizon).
  const pickupMs = (() => {
    const d0 = chip.pickupDate ?? chip.startDate;
    if (!d0) return null;
    const d = new Date(d0 + "T00:00:00");
    if (chip.pickupTime && /^\d\d:\d\d/.test(chip.pickupTime)) {
      const [h, m] = chip.pickupTime.split(":").map(Number);
      d.setHours(h, m || 0, 0, 0);
    }
    return d.getTime();
  })();
  const untilPickupH = pickupMs != null ? (pickupMs - Date.now()) / 3_600_000 : 72;
  const leadFill = Math.max(6, Math.min(100, Math.round((1 - untilPickupH / 72) * 100)));
  const soon = isUpcoming && untilPickupH <= 6;
  // Tick fast in the final stretch of a lead-up, else once a minute while live.
  useTick(soon ? 1000 : 60_000, isActive || isUpcoming);

  // Bar fill + colour by lifecycle: RED lead-up → BLUE while out (incl. away —
  // it's still an ongoing rental) → GREEN once returned. The GREY for away lives
  // on the CARD BACKGROUND, not the bar (Daniel).
  const fillPct = isUpcoming ? leadFill : progress.pct;
  const fillGradient = isCompleted
    ? "linear-gradient(90deg, #16a34a 0%, #22c55e 100%)"
    : isUpcoming
      ? "linear-gradient(90deg, #f87171 0%, #ef4444 100%)"
      : "linear-gradient(90deg, #3b82f6 0%, #06b6d4 50%, #10b981 100%)";
  const fillShadow = isCompleted
    ? "0 0 8px rgba(34,197,94,0.4)"
    : isUpcoming
      ? soon ? "0 0 8px rgba(239,68,68,0.85)" : "0 0 6px rgba(239,68,68,0.45)"
      : "0 0 10px rgba(59,130,246,0.55), inset 0 0 6px rgba(255,255,255,0.18)";
  const labelColor = isCompleted ? "#22c55e" : isUpcoming ? "#f87171" : "#60a5fa";
  const labelIcon = isCompleted ? "✓" : isUpcoming ? "⏱" : "●";

  return (
    <div className="mt-2.5">
      {/* Top: pickup ─── return endpoints */}
      <div className="flex items-baseline justify-between text-[9px] font-medium uppercase tracking-wider mb-1.5">
        <span className="text-emerald-300/90 flex items-center gap-1">
          <span className="text-emerald-400">▶</span>
          <span className="font-mono text-emerald-200 text-[13px] font-semibold">{fmt12Short(chip.pickupTime)}</span>
          <span className="text-[#6b6f80]">·</span>
          <span className="text-[#9ca3af]">{dayShort(chip.startDate)}</span>
        </span>
        <span className="text-violet-300/90 flex items-center gap-1">
          <span className="text-[#9ca3af]">{dayShort(chip.returnDate ?? chip.endDate)}</span>
          <span className="text-[#6b6f80]">·</span>
          <span className="font-mono text-violet-200 text-[13px] font-semibold">{fmt12Short(chip.returnTime)}</span>
          <span className="text-violet-400">◀</span>
        </span>
      </div>

      {/* Bar + now marker */}
      <div
        className="relative h-2 rounded-full"
        style={{
          background: "rgba(255,255,255,0.06)",
          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.4)",
        }}
      >
        {/* Filled portion */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${soon ? "animate-pulse" : ""}`}
          style={{
            width: `${fillPct}%`,
            background: fillGradient,
            boxShadow: fillShadow,
            transition: "width 800ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
        {/* Shimmer overlay for active (out) rentals — not for a static away bar */}
        {isActive && (
          <div
            className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
            style={{
              width: `${fillPct}%`,
              background:
                "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.28) 50%, transparent 100%)",
              backgroundSize: "200% 100%",
              animation: "rental-shimmer 2.2s linear infinite",
              mixBlendMode: "overlay",
            }}
          />
        )}
        {/* Now marker — sits on top of bar at progress.pct (active out rentals) */}
        {isActive && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2"
            style={{
              left: `${progress.pct}%`,
              width: 14,
              height: 14,
              transition: "left 800ms cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <div
              className="w-full h-full rounded-full"
              style={{
                background: "#fff",
                border: "2px solid #3b82f6",
                boxShadow:
                  "0 0 0 3px rgba(59,130,246,0.25), 0 0 12px rgba(59,130,246,0.7), 0 0 22px rgba(59,130,246,0.45)",
                animation: "rental-now-pulse 1.6s ease-in-out infinite",
              }}
            />
          </div>
        )}
        {/* Completed checkmark at right edge */}
        {isCompleted && (
          <div
            className="absolute top-1/2 right-0 -translate-y-1/2 translate-x-1/3 flex items-center justify-center"
            style={{ width: 18, height: 18 }}
          >
            <div
              className="rounded-full flex items-center justify-center text-[10px] font-bold text-white"
              style={{
                width: 18,
                height: 18,
                background: "linear-gradient(135deg, #22c55e, #16a34a)",
                boxShadow: "0 0 0 2px rgba(34,197,94,0.25), 0 2px 6px rgba(34,197,94,0.4)",
              }}
            >
              ✓
            </div>
          </div>
        )}
      </div>

      {/* Bottom: status + percent */}
      <div className="flex items-center justify-between mt-1.5 text-[10px]">
        <span
          className="font-medium flex items-center gap-1"
          style={{ color: labelColor }}
        >
          <span className={isActive ? "animate-pulse" : ""}>{labelIcon}</span>
          {progress.label}
          {isUpcoming && chip.pickupTime && (
            <span className="text-[#6b6f80] ml-1">
              · pickup {fmt12Short(chip.pickupTime)}
            </span>
          )}
        </span>
        <span
          className="font-mono text-[#6b6f80]"
          style={{ letterSpacing: "0.5px" }}
        >
          {progress.pct.toString().padStart(2, "0")}%
        </span>
      </div>
    </div>
  );
}

// ── V1-style rich booking card ───────────────────────────────────────────────
function BookingCard({ chip }: { chip: ChipData }) {
  const color = resolveColor(chip.accountColor);
  const accounts = useStableQuery(api.accounts.list);
  const accountMeta = (accounts as Array<{slug:string;display_name:string;profile_image_url:string|null}>|undefined)?.find((a) => a.slug === chip.accountSlug);
// (item dropdown state removed — items now render as a single tile row)

  const kind = chip.kind ?? "pickup";
  // Per-account avatar accent + short label (was a binary leo-vs-everything,
  // which silently mis-coloured diogo and dbcinema_web as DB blue).
  const acctShort =
    chip.accountSlug === "leo" ? "Leo"
    : chip.accountSlug === "diogo" ? "Diogo"
    : chip.accountSlug === "dbcinema_web" ? "Web"
    : "DB";
  const isPickupDelivery = chip.pickupMethod === "delivery";
  const isReturnDelivery = chip.returnMethod === "delivery";

  // Every booking entry is tagged with its leg type (pickup / return / away).
  // Previously only delivery legs + "away" got a badge, which silently left ALL
  // collection pickups/returns untagged. The delivery truck is appended when the
  // leg is a delivery so that signal is preserved. Colours: pickup green, return
  // red, away grey.
  const showBadge = true;
  const badgeText =
    kind === "away"
      ? "AWAY"
      : kind === "pickup"
        ? (isPickupDelivery ? "PICKUP 🚚" : "PICKUP")
        : (isReturnDelivery ? "RETURN 🚚" : "RETURN");
  const badgeStyle: React.CSSProperties =
    kind === "pickup"
      ? { background: "rgba(34,197,94,0.16)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }
      : kind === "return"
        ? { background: "rgba(239,68,68,0.16)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)" }
        : { background: "rgba(107,114,128,0.16)", color: "#9ca3af", border: "1px solid rgba(107,114,128,0.3)" };

  const items = chip.items ?? [];
  // Effective (negotiated) pickup date — falls back to startDate. Used for
  // progress + the pickup label so they match the chip's calendar placement
  // (Phase 2/3: negotiated pickup_date moves the rental to that day).
  const effPickupDate = chip.pickupDate ?? chip.startDate ?? null;
  // Effective (negotiated) return date — falls back to endDate. Anchors the
  // return label + progress so the AWAY card doesn't ghost the return onto the
  // Hygglo end_date when a later negotiated return_date exists.
  const effReturnDate = chip.returnDate ?? chip.endDate ?? null;
  const range = fmtRange(chip.startDate, chip.endDate);
  const pickupLabel = fmtTimeWithDate(chip.pickupTime, effPickupDate);
  const returnLabel = fmtTimeWithDate(chip.returnTime, effReturnDate);
  const progress = computeProgress(effPickupDate, effReturnDate, chip.pickupTime, chip.returnTime);
  const noteLines = splitNotes(chip.notes);
  // Card accent by lifecycle so the whole card reads at a glance (Daniel):
  // RED = lead-up to pickup, BLUE = out, GREEN = returned, GREY = away all day.
  const lifeState = kind === "away" ? "away" : progress.status;
  const stateAccent =
    lifeState === "completed" ? "#22c55e"
    : lifeState === "upcoming" ? "#ef4444"
    : lifeState === "away" ? "#9ca3af"
    : "#3b82f6";
  // Whole-card background tint: GREEN once returned, GREY while away/out-all-day
  // (the bar itself stays blue for away). Otherwise the neutral card.
  const stateBg =
    lifeState === "completed"
      ? "linear-gradient(135deg, rgba(34,197,94,0.16) 0%, rgba(22,101,52,0.07) 100%)"
      : lifeState === "away"
        ? "linear-gradient(135deg, rgba(148,163,184,0.15) 0%, rgba(71,85,105,0.06) 100%)"
        : "linear-gradient(135deg, rgba(20,24,40,0.65) 0%, rgba(14,17,28,0.45) 100%)";

  // (Method pills rendered inline as <MethodPill /> per direction below.)

  const renterDisplay =
    chip.renterName && chip.renterName !== "?"
      ? chip.renterName
      : chip.status === "pending_review" || chip.orderStep === "REQUEST" || chip.orderStep === "APPROVED"
        ? "Pending"
        : "?";

  return (
    <div
      className="flex gap-3 p-3 rounded-xl transition-colors hover:bg-white/[0.05]"
      style={{
        background: stateBg,
        border: "1px solid rgba(255,255,255,0.06)",
        borderLeft: `4px solid ${stateAccent}`,
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 18px rgba(0,0,0,0.32)",
      }}
    >
      {/* Thumbnail — rounded on the img itself so hover-zoom doesn't clip */}
      {chip.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={chip.imageUrl}
          alt={chip.imageAlt ?? items[0]?.name ?? ""}
          className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
          loading="lazy"
          style={{ background: "rgba(255,255,255,0.06)" }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      ) : (
        <div
          className="w-14 h-14 rounded-lg flex-shrink-0 flex items-center justify-center text-base font-bold"
          style={{ color, background: `${color}22` }}
          data-no-zoom
        >
          {renterDisplay[0]?.toUpperCase() ?? "?"}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-w-0">
        {/* Top row: badge | account chip | renter | £ */}
        <div className="flex items-center gap-2 flex-wrap">
          {showBadge && (
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={badgeStyle}
            >
              {badgeText}
            </span>
          )}
          {accountMeta?.profile_image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={accountMeta.profile_image_url}
              alt={accountMeta.display_name}
              className="rounded-full object-cover flex-shrink-0"
              style={{ width: 22, height: 22, border: `2px solid ${color}` }}
              loading="lazy"
              data-no-zoom
              title={accountMeta.display_name}
            />
          ) : (
            <span
              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
              style={{
                background: `${color}2e`,
                color,
              }}
            >
              {acctShort}
            </span>
          )}
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
          {/* Pickup/drop-off inline labels — delivery legs only, so a collection/
              unknown booking stays untagged (its times still show in the
              timeline below). Range + identity always remain visible. */}
          {isPickupDelivery && (
            <>
              <span className="text-[#3a3d4a]">·</span>
              <span>
                <span className="text-[#6b6f80] uppercase tracking-wider mr-1">pickup</span>
                <span className="text-[#c9cdd5] font-medium">{pickupLabel}</span>
              </span>
            </>
          )}
          {isReturnDelivery && (
            <>
              <span className="text-[#3a3d4a]">·</span>
              <span>
                <span className="text-[#6b6f80] uppercase tracking-wider mr-1">return</span>
                <span className="text-[#c9cdd5] font-medium">{returnLabel}</span>
              </span>
            </>
          )}
          {/* Method pills — delivery only (amber truck). Collection/unknown
              render no pill, matching the delivery-only tag rule. */}
          {isPickupDelivery && (
            <MethodPill direction="pickup" method="delivery" />
          )}
          {isReturnDelivery && (
            <MethodPill direction="return" method="delivery" />
          )}
        </div>

        {/* Items — horizontal tile row, hover-zoom each thumbnail */}
        {items.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {items.map((it, i) => (
              <div
                key={(it.itemId ?? "") + i}
                className="flex-shrink-0"
                title={it.name + (it.qty > 1 ? ` × ${it.qty}` : "")}
              >
                <div className="relative">
                  <ItemThumb item={it} size={36} />
                  {it.qty > 1 && (
                    <span
                      className="absolute -top-1 -right-1 text-[9px] font-bold px-1 rounded-full"
                      style={{ background: "#070910", color: "#e4e6eb", border: "1px solid rgba(255,255,255,0.18)" }}
                    >
                      ×{it.qty}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Progress timeline — synced to actual pickup/return times, live ticks */}
        {progress.label && <ProgressTimeline chip={chip} progress={progress} />}

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
  // Bare day tile (Daniel): the tiles carry NOTHING but the date — all the
  // per-rental info + colour lives on the cards in the drawer below. Days with
  // any activity are shown at full opacity so you know which to open.
  const { wd, num } = dayLabelSplit(day.date);
  const hasAny =
    day.pickups.length + day.returns.length + (day.away?.length ?? 0) + day.holds.length > 0;

  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 text-left rounded-xl p-2.5 transition-all duration-150 select-none"
      style={{
        width: "72px",
        minHeight: "72px",
        border: "1px solid rgba(255,255,255,0.08)",
        outline: isToday ? "2px solid #3b82f6" : undefined,
        outlineOffset: isToday ? "-1px" : undefined,
        boxShadow: isToday
          ? "inset 0 0 0 2px #3b82f6, 0 0 12px rgba(59,130,246,0.4)"
          : isExpanded
            ? "0 4px 16px rgba(0,0,0,0.3)"
            : "none",
        background: isExpanded
          ? "rgba(59,130,246,0.07)"
          : isToday
            ? "rgba(59,130,246,0.05)"
            : "rgba(14,17,28,0.35)",
        opacity: hasAny || isToday ? 1 : 0.5,
        transform: isExpanded ? "scale(1.02)" : "scale(1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8b8fa3]">
        {wd}
      </div>
      <div
        className="text-xl font-bold leading-none mt-0.5"
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
    </button>
  );
}

// ── Expanded drawer for a day ─────────────────────────────────────────────────
function DayDrawer({ day }: { day: DayData }) {
  const away = day.away ?? [];
  // Order by the card's event time on this day: pickups by pickup time, returns
  // by return time (untimed after timed), and away/out-all-day items last.
  const bookingTime = (b: ChipData): string => {
    if ((b.kind ?? "pickup") === "away") return "99:99";
    const t = b.kind === "return" ? b.returnTime : b.pickupTime;
    return t && /^\d\d:\d\d/.test(t) ? t : "98:00";
  };
  const allBookings: ChipData[] = [...day.pickups, ...day.returns, ...away].sort(
    (a, b) => bookingTime(a).localeCompare(bookingTime(b)),
  );
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
        <div className="space-y-3">
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

  // Week navigation: 0 = current week (7-day window anchored on today), capped
  // at +4 weeks (~1 month) ahead. Past navigation allowed up to ~1 year back.
  const MAX_WEEK_OFFSET = 4;
  const MIN_WEEK_OFFSET = -52;
  const [weekOffset, setWeekOffset] = useState(0);
  const stripStart = addDaysIso(today, weekOffset * 7);
  const stripEnd = addDaysIso(stripStart, 6);
  const canPrev = weekOffset > MIN_WEEK_OFFSET;
  const canNext = weekOffset < MAX_WEEK_OFFSET;

  // Auto-expand today on load so the drawer shows up without a click.
  const [expandedDate, setExpandedDate] = useState<string | null>(today);
  const [ganttOpen, setGanttOpen] = useState(false);

  const data = useStableQuery(api.calendar.getCalendarStrip, {
    accountSlug: activeAccountSlug,
    startDate: stripStart,
    days: 7,
  });

  function toggleDay(date: string) {
    setExpandedDate((prev) => (prev === date ? null : date));
  }

  const expandedDay =
    (data as DayData[] | undefined)?.find((d) => d.date === expandedDate) ?? null;

  return (
    <Card>
      {/* Title row: name + legend (legend hides when the widget is narrow) + Weekly View */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-sm font-semibold text-[#e4e6eb] flex-shrink-0">
          Rental Calendar
        </span>
        <div className="flex items-center gap-2 min-w-0">
          <div className="hidden lg:flex items-center gap-1.5 text-[10px] text-[#8b8fa3]">
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
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg transition-all duration-150 hover:bg-blue-500/10 hover:border-blue-400/60 active:scale-95"
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

      {/* Week navigation — its own row so the arrows stay visible at any widget
          width (the dashboard column is narrow and used to clip them). Forward
          up to +4 weeks, back arrow returns toward today. */}
      <div
        className="flex items-center justify-between gap-2 mb-3 rounded-lg px-1 py-1"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={() => setWeekOffset((o) => Math.max(MIN_WEEK_OFFSET, o - 1))}
          disabled={!canPrev}
          aria-label="Previous week"
          className="px-3 py-1 rounded-md text-base leading-none text-[#c9cdd5] transition-colors disabled:opacity-25 disabled:cursor-not-allowed enabled:hover:text-white enabled:hover:bg-white/10"
        >
          ‹
        </button>
        <span className="text-xs font-medium text-[#c9cdd5] tabular-nums whitespace-nowrap">
          {dayShort(stripStart)} – {dayShort(stripEnd)}
          <span className="text-[#6b6f80] ml-1.5">
            {weekOffset === 0 ? "· this week" : `· +${weekOffset}w`}
          </span>
        </span>
        <button
          onClick={() => setWeekOffset((o) => Math.min(MAX_WEEK_OFFSET, o + 1))}
          disabled={!canNext}
          aria-label="Next week"
          className="px-3 py-1 rounded-md text-base leading-none text-[#c9cdd5] transition-colors disabled:opacity-25 disabled:cursor-not-allowed enabled:hover:text-white enabled:hover:bg-white/10"
        >
          ›
        </button>
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
          {[...(data as DayData[])]
            .sort((a, b) => {
              // Day with the soonest upcoming pickup/return first; days with
              // nothing left ahead (Infinity) fall to the end, kept in date order.
              const ea = dayNextEventMs(a);
              const eb = dayNextEventMs(b);
              if (ea !== eb) return ea - eb;
              return a.date.localeCompare(b.date);
            })
            .map((day) => (
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
            weekStartIso={mondayOf(stripStart)}
            accountSlug={activeAccountSlug ?? undefined}
          />
        </Suspense>
      )}
    </Card>
  );
}
