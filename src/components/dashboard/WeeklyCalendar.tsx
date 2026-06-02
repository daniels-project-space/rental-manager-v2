"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

/**
 * "Today" in the business timezone (Europe/London), "YYYY-MM-DD". Inlined
 * twin of convex/lib/effectiveDates.ts:londonToday so the weekly anchor +
 * today-highlight classify on the same calendar day as the backend Active tab
 * (which also uses London), instead of UTC. DST-correct.
 */
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

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString("en", { weekday: "short", month: "short", day: "numeric" });
}

function dayShort(dateStr: string) {
  const d = new Date(dateStr);
  return { wd: d.toLocaleString("en", { weekday: "short" }), num: d.getDate() };
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: "#22c55e",
  pending_review: "#f59e0b",
  completed: "#6ea8fe",
};

export function WeeklyCalendar() {
  const { activeAccountSlug } = useAccount();
  const [weekStart, setWeekStart] = useState(() => getMondayOf(londonToday()));

  const data = useQuery(api.calendar.getWeeklyCalendar, {
    accountSlug: activeAccountSlug,
    weekStartDate: weekStart,
  });

  const weekEnd = addDays(weekStart, 6);
  const today = londonToday();

  // Navigation cap: current week .. +4 weeks (~1 month) ahead. No past weeks.
  const minWeek = getMondayOf(today);
  const maxWeek = addDays(minWeek, 28);
  const canPrev = weekStart > minWeek;
  const canNext = weekStart < maxWeek;

  return (
    <Card className="hidden md:block">
      <CardHeader
        title="Weekly Calendar"
        actions={
          <div className="flex items-center gap-2 text-xs text-[#8b8fa3]">
            <button
              onClick={() => setWeekStart(addDays(weekStart, -7))}
              disabled={!canPrev}
              aria-label="Previous week"
              className="px-2 py-0.5 rounded hover:text-[#e4e6eb] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ‹
            </button>
            <span>
              {fmtDate(weekStart)} – {fmtDate(weekEnd)}
            </span>
            <button
              onClick={() => setWeekStart(addDays(weekStart, 7))}
              disabled={!canNext}
              aria-label="Next week"
              className="px-2 py-0.5 rounded hover:text-[#e4e6eb] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ›
            </button>
          </div>
        }
      />

      {data === undefined ? (
        <SkeletonBlock className="h-40 w-full" />
      ) : (
        <div className="grid grid-cols-7 gap-1 min-h-[140px]">
          {data.days.map((day) => {
            const isToday = day.date === today;
            const { wd, num } = dayShort(day.date);
            return (
              <div
                key={day.date}
                className="rounded-lg p-1.5 flex flex-col gap-1"
                style={{
                  border: isToday
                    ? "1px solid rgba(110,168,254,0.4)"
                    : "1px solid rgba(255,255,255,0.06)",
                  background: isToday ? "rgba(110,168,254,0.04)" : "transparent",
                  minHeight: 120,
                }}
              >
                <div className="text-xs text-[#8b8fa3]">{wd}</div>
                <div
                  className="text-sm font-semibold mb-1"
                  style={{ color: isToday ? "#6ea8fe" : "#e4e6eb" }}
                >
                  {num}
                </div>
                {day.reservations.length === 0 && day.holds.length === 0 ? (
                  <span className="text-xs text-[#8b8fa3]/50">–</span>
                ) : (
                  <>
                    {day.reservations.slice(0, 3).map((r) => {
                      const color = r.accountSlug === "dbcinema" ? "#6ea8fe" : "#22c55e";
                      const statusColor = STATUS_COLORS[r.status] ?? "#8b8fa3";
                      return (
                        <div
                          key={String(r.reservationId)}
                          className="text-xs rounded px-1 py-0.5 truncate"
                          style={{
                            borderLeft: `2px solid ${color}`,
                            background: `${statusColor}15`,
                            color: "#e4e6eb",
                          }}
                          title={r.itemNames.join(", ")}
                        >
                          {r.itemNames[0] ?? "?"}
                        </div>
                      );
                    })}
                    {day.reservations.length > 3 && (
                      <span className="text-xs text-[#8b8fa3]">
                        +{day.reservations.length - 3} more
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
