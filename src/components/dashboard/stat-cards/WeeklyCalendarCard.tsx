"use client";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Lazy-load the full weekly Gantt overlay so it doesn't bloat the initial bundle.
const CalendarGantt = lazy(() =>
  import("../CalendarGantt").catch(() => ({
    default: () => (
      <div className="p-6 text-center text-[#8b8fa3] text-sm">Weekly Calendar overlay unavailable.</div>
    ),
  })),
);

function londonToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
function getMondayOf(ymd: string): string {
  const d = new Date(ymd + "T00:00:00Z");
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}
function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WD = ["M", "T", "W", "T", "F", "S", "S"];

type AvailCell = { date: string; free: number; total: number; booked: number; free_from?: string | null };
type AvailItem = { item_id: string; name: string; qty: number; availability: AvailCell[] };

/**
 * Weekly Calendar widget: keyword-search an item to see, on each weekday, how
 * many units are FREE that day; otherwise the weekdays show that day's booking
 * count. A small calendar icon (top-right) opens the full Gantt timeline.
 */
export default function WeeklyCalendarCard() {
  const { activeAccountSlug } = useAccount();
  const today = londonToday();
  const weekStart = useMemo(() => getMondayOf(today), [today]);
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQuery(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  // Default view: booking counts per day. (Always present so the week renders.)
  const week = useQuery(api.calendar.getWeeklyCalendar, {
    accountSlug: activeAccountSlug,
    weekStartDate: weekStart,
  });
  // Search view: per-day availability for the matched item.
  const search = useQuery(
    api.calendar.searchCalendarInventory,
    query ? { query, weekStartIso: weekStart, accountSlug: activeAccountSlug } : "skip",
  ) as { items: AvailItem[] } | undefined;

  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const bookingByDate = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of week?.days ?? []) m[d.date] = d.reservations?.length ?? 0;
    return m;
  }, [week]);

  const matched = query ? search?.items?.[0] : undefined;
  const moreCount = query ? Math.max(0, (search?.items?.length ?? 0) - 1) : 0;
  const availByDate = useMemo(() => {
    const m = new Map<string, AvailCell>();
    for (const c of matched?.availability ?? []) m.set(c.date, c);
    return m;
  }, [matched]);

  const searching = !!query;
  const loading = searching ? search === undefined : week === undefined;

  return (
    <>
      <div
        className="stat-card w-full flex flex-col"
        style={{
          background: "rgba(14,17,28,0.35)",
          backdropFilter: "blur(24px) saturate(1.5)",
          borderRadius: 16,
          padding: 14,
          borderLeft: "3px solid #6ea8fe",
          minHeight: 140,
        }}
      >
        {/* Search + mini calendar launcher */}
        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[#8b8fa3] text-xs">🔍</span>
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="Search item availability…"
              className="w-full text-[12px] rounded-lg pl-7 pr-6 py-1.5"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
            />
            {raw && (
              <button
                onClick={() => setRaw("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#8b8fa3] hover:text-white text-sm"
                aria-label="Clear"
              >
                ×
              </button>
            )}
          </div>
          <button
            onClick={() => setOpen(true)}
            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-base hover:bg-white/10 transition-colors"
            style={{ border: "1px solid rgba(110,168,254,0.4)", color: "#6ea8fe" }}
            title="Open the full weekly timeline"
            aria-label="Open weekly timeline"
          >
            📅
          </button>
        </div>

        {/* Matched-item label (what the numbers below refer to) */}
        {searching && matched && (
          <div className="text-[10px] text-[#8b8fa3] mb-1 truncate">
            <span className="text-[#e4e6eb] font-medium">{matched.name}</span> · {matched.qty} owned · free / day
            {moreCount > 0 && <span className="text-[#6ea8fe]"> · +{moreCount} more</span>}
          </div>
        )}

        {loading ? (
          <SkeletonBlock className="h-16 w-full" />
        ) : searching && !matched ? (
          <div className="flex-1 flex items-center justify-center text-[11px] text-[#8b8fa3]">
            No owned item matches “{query}”.
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-1 flex-1 items-stretch">
            {dates.map((date, i) => {
              const isToday = date === today;
              const dayNum = Number(date.slice(8, 10));
              const cell = availByDate.get(date);
              const freeFrom = cell?.free_from ?? null;
              const showFrom = !!freeFrom && (cell?.free ?? 0) <= 0;
              // value + colour
              let value: string;
              let color = "#8b8fa3";
              if (searching && matched && cell) {
                const free = cell.free;
                value = String(free);
                color = free <= 0 ? (showFrom ? "#fbbf24" : "#f87171") : free < cell.total ? "#fbbf24" : "#34d399";
              } else if (!searching) {
                const n = bookingByDate[date] ?? 0;
                value = n > 0 ? String(n) : "–";
                color = n > 0 ? "#22c55e" : "#8b8fa3";
              } else {
                value = "–";
              }
              return (
                <div
                  key={date}
                  className="rounded-md flex flex-col items-center justify-center py-1 gap-0.5"
                  style={{
                    border: isToday ? "1px solid rgba(110,168,254,0.5)" : "1px solid rgba(255,255,255,0.06)",
                    background: isToday ? "rgba(110,168,254,0.08)" : "transparent",
                  }}
                  title={
                    searching && matched && cell
                      ? `${cell.free} of ${cell.total} free · ${date}${showFrom ? ` · 1 free from ${freeFrom}` : ""}`
                      : `${bookingByDate[date] ?? 0} bookings · ${date}`
                  }
                >
                  <span className="text-[9px] text-[#8b8fa3]">{WD[i]}</span>
                  <span className="text-[11px] font-semibold leading-none" style={{ color: isToday ? "#6ea8fe" : "#e4e6eb" }}>
                    {dayNum}
                  </span>
                  <span className="text-[13px] font-bold leading-none tabular-nums" style={{ color }}>
                    {value}
                  </span>
                  {showFrom && <span className="text-[7px] leading-none" style={{ color: "#fbbf24" }}>{`fr ${freeFrom}`}</span>}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-1.5 text-[9px] text-[#8b8fa3]">
          {searching ? "units free each day" : "bookings each day · search an item for availability"}
        </div>
      </div>

      {open && (
        <Suspense fallback={null}>
          <CalendarGantt
            open={open}
            onClose={() => setOpen(false)}
            weekStartIso={weekStart}
            accountSlug={activeAccountSlug ?? undefined}
          />
        </Suspense>
      )}
    </>
  );
}
