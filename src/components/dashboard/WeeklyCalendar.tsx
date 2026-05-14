"use client";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { ReservationDetailModal } from "@/components/dashboard/ReservationDetailModal";
import type { Id } from "../../../convex/_generated/dataModel";

function getMonday(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
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

function fmtTime(t: string | null | undefined): string {
  if (!t) return "—";
  // Hygglo stores "HH:MM". Render as H:MMam/pm.
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${min}${ampm}`;
}

function fmtRange(start: string, end: string): string {
  const a = new Date(start);
  const b = new Date(end);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const aStr = a.toLocaleString("en", { month: "short", day: "numeric" });
  const bStr = sameMonth
    ? b.getDate().toString()
    : b.toLocaleString("en", { month: "short", day: "numeric" });
  // Hygglo inclusive day count
  const days = Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000) + 1);
  return `${aStr} → ${bStr} (${days}d)`;
}

function fmtGbp(n: number | null | undefined): string {
  if (n == null) return "—";
  return "£" + Math.round(n).toLocaleString("en-GB");
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: "#22c55e",
  pending_review: "#f59e0b",
  completed: "#6ea8fe",
};

const ACCOUNT_COLORS: Record<string, string> = {
  dbcinema: "#6ea8fe", // blue
  leo: "#a855f7",      // purple
};
function accountColor(slug: string | null | undefined) {
  return slug ? ACCOUNT_COLORS[slug] ?? "#22c55e" : "#22c55e";
}

type Reservation = NonNullable<
  ReturnType<typeof useQuery<typeof api.calendar.getWeeklyCalendar>>
>["days"][number]["reservations"][number];

export function WeeklyCalendar() {
  const { activeAccountSlug } = useAccount();
  const [weekStart, setWeekStart] = useState(() => getMonday(new Date()));
  const [openResId, setOpenResId] = useState<Id<"reservations"> | null>(null);

  const data = useQuery(api.calendar.getWeeklyCalendar, {
    accountSlug: activeAccountSlug,
    weekStartDate: weekStart,
  });

  const weekEnd = addDays(weekStart, 6);
  const today = new Date().toISOString().slice(0, 10);

  // Deduplicate reservations by reservationId for the day-by-day reduce so we don't
  // show the same rental 4 times if it spans 4 days.
  const cellsByDay = useMemo(() => {
    if (!data) return new Map<string, Reservation[]>();
    const m = new Map<string, Reservation[]>();
    for (const day of data.days) {
      m.set(day.date, day.reservations);
    }
    return m;
  }, [data]);

  return (
    <>
      <Card className="hidden md:block">
        <CardHeader
          title="Weekly Calendar"
          actions={
            <div className="flex items-center gap-2 text-xs text-[#8b8fa3]">
              <button
                onClick={() => setWeekStart(addDays(weekStart, -7))}
                className="px-2 py-0.5 rounded hover:text-[#e4e6eb] transition-colors"
                aria-label="Previous week"
              >
                ‹
              </button>
              <span>
                {fmtDate(weekStart)} – {fmtDate(weekEnd)}
              </span>
              <button
                onClick={() => setWeekStart(addDays(weekStart, 7))}
                className="px-2 py-0.5 rounded hover:text-[#e4e6eb] transition-colors"
                aria-label="Next week"
              >
                ›
              </button>
              <button
                onClick={() => setWeekStart(getMonday(new Date()))}
                className="px-2 py-0.5 rounded hover:text-[#e4e6eb] transition-colors ml-1"
              >
                Today
              </button>
            </div>
          }
        />

        {data === undefined ? (
          <SkeletonBlock className="h-40 w-full" />
        ) : (
          <div className="grid grid-cols-7 gap-1 min-h-[160px]">
            {data.days.map((day) => {
              const isToday = day.date === today;
              const { wd, num } = dayShort(day.date);
              const reservations = cellsByDay.get(day.date) ?? [];
              return (
                <div
                  key={day.date}
                  className="rounded-lg p-1.5 flex flex-col gap-1"
                  style={{
                    border: isToday
                      ? "1px solid rgba(110,168,254,0.4)"
                      : "1px solid rgba(255,255,255,0.06)",
                    background: isToday ? "rgba(110,168,254,0.04)" : "transparent",
                    minHeight: 140,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[#8b8fa3]">{wd}</span>
                    {reservations.length > 0 && (
                      <span className="text-[10px] text-[#8b8fa3]">{reservations.length}</span>
                    )}
                  </div>
                  <div
                    className="text-sm font-semibold mb-1"
                    style={{ color: isToday ? "#6ea8fe" : "#e4e6eb" }}
                  >
                    {num}
                  </div>
                  {reservations.length === 0 && day.holds.length === 0 ? (
                    <span className="text-xs text-[#8b8fa3]/50">–</span>
                  ) : (
                    <>
                      {reservations.slice(0, 4).map((r) => {
                        const color = accountColor(r.accountSlug);
                        const statusColor = STATUS_COLORS[r.status] ?? "#8b8fa3";
                        const firstImage = r.items?.[0]?.imageUrl;
                        const itemCount = r.items?.length ?? r.itemNames.length;
                        const badge =
                          r.dayType === "pickup"
                            ? "PICKUP"
                            : r.dayType === "return"
                            ? "RETURN"
                            : "AWAY";
                        const timeStr =
                          r.dayType === "pickup"
                            ? fmtTime(r.pickupTime)
                            : r.dayType === "return"
                            ? fmtTime(r.returnTime)
                            : null;
                        return (
                          <button
                            key={String(r.reservationId)}
                            onClick={() => setOpenResId(r.reservationId as Id<"reservations">)}
                            className="text-left text-xs rounded px-1 py-0.5 transition-colors hover:brightness-125"
                            style={{
                              borderLeft: `3px solid ${color}`,
                              background: `${statusColor}1a`,
                              color: "#e4e6eb",
                            }}
                            title={`${r.renterName} — ${r.itemNames.join(", ")}`}
                          >
                            <div className="flex items-center gap-1">
                              {firstImage ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={firstImage}
                                  alt=""
                                  className="w-5 h-5 rounded object-cover flex-shrink-0"
                                  loading="lazy"
                                />
                              ) : (
                                <span
                                  className="w-5 h-5 rounded inline-flex items-center justify-center text-[9px] flex-shrink-0"
                                  style={{ background: `${color}33`, color }}
                                >
                                  {itemCount}
                                </span>
                              )}
                              <span className="truncate flex-1">{r.renterName}</span>
                            </div>
                            <div className="flex items-center justify-between text-[9px] text-[#8b8fa3] mt-0.5">
                              <span style={{ color }}>{badge}</span>
                              {timeStr && <span>{timeStr}</span>}
                            </div>
                          </button>
                        );
                      })}
                      {reservations.length > 4 && (
                        <span className="text-xs text-[#8b8fa3]">
                          +{reservations.length - 4} more
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

      {openResId && (
        <ReservationDetailModal
          reservationId={openResId}
          onClose={() => setOpenResId(null)}
        />
      )}
    </>
  );
}

// Legacy inline modal removed in favour of the shared ReservationDetailModal.
function _RemovedInlineModalStub() {
  return null;
}
