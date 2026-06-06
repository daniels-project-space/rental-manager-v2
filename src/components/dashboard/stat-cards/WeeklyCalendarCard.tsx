"use client";
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

// Lazy-load the full-week Gantt overlay so it doesn't bloat the initial bundle.
// Mirrors CalendarStrip's launcher — this card is just a second entry point to
// the same "calendar overlay".
const CalendarGantt = lazy(() =>
  import("../CalendarGantt").catch(() => ({
    default: () => (
      <div className="p-6 text-center text-[#8b8fa3] text-sm">
        Weekly Calendar overlay unavailable.
      </div>
    ),
  })),
);

/** "Today" in the business timezone (Europe/London), "YYYY-MM-DD". */
function londonToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

/** Monday (YYYY-MM-DD) of the week containing the given YYYY-MM-DD date. */
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

function fmtShort(ymd: string): string {
  return new Date(ymd + "T00:00:00Z").toLocaleString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const WD = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * Compact weekly-calendar stat card. Shows a 7-day preview of the current week
 * (per-day booking counts, today highlighted) and, on click, opens the existing
 * CalendarGantt "calendar overlay" — the same overlay CalendarStrip launches
 * from its "Weekly View" button.
 */
export default function WeeklyCalendarCard() {
  const { activeAccountSlug } = useAccount();
  const today = londonToday();
  const weekStart = useMemo(() => getMondayOf(today), [today]);
  const [open, setOpen] = useState(false);

  const data = useQuery(api.calendar.getWeeklyCalendar, {
    accountSlug: activeAccountSlug,
    weekStartDate: weekStart,
  });

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const day of data?.days ?? []) {
      map[day.date] = day.reservations?.length ?? 0;
    }
    return map;
  }, [data]);

  const weekEnd = addDays(weekStart, 6);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="stat-card w-full text-left transition-colors hover:bg-white/[0.03] cursor-pointer"
        style={{
          background: "rgba(14,17,28,0.35)",
          backdropFilter: "blur(24px) saturate(1.5)",
          borderRadius: 16,
          padding: 16,
          borderLeft: "3px solid #6ea8fe",
          minHeight: 140,
          display: "flex",
          flexDirection: "column",
        }}
        aria-label="Open weekly calendar overlay"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#8b8fa3]">
            📅 Weekly Calendar
          </span>
          <span className="text-[10px] text-[#6ea8fe]">Open ›</span>
        </div>

        {data === undefined ? (
          <SkeletonBlock className="h-16 w-full" />
        ) : (
          <div className="grid grid-cols-7 gap-1 flex-1 items-stretch">
            {Array.from({ length: 7 }).map((_, i) => {
              const date = addDays(weekStart, i);
              const n = counts[date] ?? 0;
              const isToday = date === today;
              const dayNum = Number(date.slice(8, 10));
              return (
                <div
                  key={date}
                  className="rounded-md flex flex-col items-center justify-start py-1 gap-0.5"
                  style={{
                    border: isToday
                      ? "1px solid rgba(110,168,254,0.5)"
                      : "1px solid rgba(255,255,255,0.06)",
                    background: isToday ? "rgba(110,168,254,0.08)" : "transparent",
                  }}
                >
                  <span className="text-[9px] text-[#8b8fa3]">{WD[i]}</span>
                  <span
                    className="text-[12px] font-semibold leading-none"
                    style={{ color: isToday ? "#6ea8fe" : "#e4e6eb" }}
                  >
                    {dayNum}
                  </span>
                  {n > 0 ? (
                    <span
                      className="text-[9px] font-bold px-1 rounded-full leading-tight"
                      style={{ background: "rgba(34,197,94,0.18)", color: "#22c55e" }}
                    >
                      {n}
                    </span>
                  ) : (
                    <span className="text-[9px] text-[#8b8fa3]/40">–</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-2 text-[10px] text-[#8b8fa3]">
          {fmtShort(weekStart)} – {fmtShort(weekEnd)}
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
