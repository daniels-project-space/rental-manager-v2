"use client";
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";

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

/** Tiny 1×1 launcher → opens the full weekly Gantt timeline overlay. */
export default function WeeklyCalendarCard() {
  const { activeAccountSlug } = useAccount();
  const today = londonToday();
  const weekStart = useMemo(() => getMondayOf(today), [today]);
  const [open, setOpen] = useState(false);

  const data = useQuery(api.calendar.getWeeklyCalendar, {
    accountSlug: activeAccountSlug,
    weekStartDate: weekStart,
  });
  const todayCount = useMemo(() => {
    const d = data?.days?.find((x) => x.date === today);
    return d ? d.reservations?.length ?? 0 : null;
  }, [data, today]);

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
        className="stat-card w-full h-full text-center transition-colors hover:bg-white/[0.04] cursor-pointer flex flex-col items-center justify-center gap-0.5"
        style={{
          background: "rgba(14,17,28,0.35)",
          backdropFilter: "blur(24px) saturate(1.5)",
          borderRadius: 16,
          padding: 12,
          borderLeft: "3px solid #6ea8fe",
          minHeight: 140,
        }}
        aria-label="Open weekly calendar timeline"
        title="Open the weekly timeline"
      >
        <div className="text-2xl leading-none">📅</div>
        <div className="text-[12px] font-semibold text-[#e4e6eb] leading-none mt-1">Calendar</div>
        <div className="text-[10px] text-[#8b8fa3] leading-none mt-0.5">
          {todayCount === null ? "this week" : `${todayCount} today`}
        </div>
        <div className="text-[10px] text-[#6ea8fe] mt-1.5">open timeline ›</div>
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
