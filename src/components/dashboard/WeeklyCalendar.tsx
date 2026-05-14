"use client";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

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
  const [openRes, setOpenRes] = useState<Reservation | null>(null);

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
                            onClick={() => setOpenRes(r)}
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

      {openRes && (
        <ReservationDetailModal reservation={openRes} onClose={() => setOpenRes(null)} />
      )}
    </>
  );
}

function ReservationDetailModal({
  reservation: r,
  onClose,
}: {
  reservation: Reservation;
  onClose: () => void;
}) {
  const color = accountColor(r.accountSlug);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border bg-[#0b0e18] shadow-2xl overflow-hidden"
        style={{ borderColor: "rgba(255,255,255,0.1)", maxHeight: "85dvh" }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-4 py-3 border-b"
          style={{ borderColor: "rgba(255,255,255,0.08)" }}
        >
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
                style={{ background: `${color}22`, color }}
              >
                {r.accountSlug ?? "all"}
              </span>
              <span className="text-[10px] uppercase tracking-wider text-slate-400">
                {r.status.replace("_", " ")}
              </span>
            </div>
            <h3 className="text-base font-semibold text-slate-100">{r.renterName}</h3>
            <p className="text-xs text-slate-400">{fmtRange(r.startDate!, r.endDate!)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          className="overflow-y-auto p-4 space-y-4"
          style={{ maxHeight: "calc(85dvh - 65px)" }}
        >
          {/* Times + methods */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div
              className="rounded-lg p-2.5"
              style={{ background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.2)" }}
            >
              <div className="text-[10px] uppercase tracking-wider text-emerald-300 mb-1">
                Pickup
              </div>
              <div className="text-slate-200 font-medium">{fmtTime(r.pickupTime)}</div>
              {r.pickupMethod && (
                <div className="text-[11px] text-slate-400 mt-0.5">
                  {r.pickupMethod === "delivery" ? "🚚 Delivery" : "Self pickup"}
                </div>
              )}
            </div>
            <div
              className="rounded-lg p-2.5"
              style={{ background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.2)" }}
            >
              <div className="text-[10px] uppercase tracking-wider text-violet-300 mb-1">
                Return
              </div>
              <div className="text-slate-200 font-medium">{fmtTime(r.returnTime)}</div>
              {r.returnMethod && (
                <div className="text-[11px] text-slate-400 mt-0.5">
                  {r.returnMethod === "delivery" ? "🚚 Delivery" : "Self return"}
                </div>
              )}
            </div>
          </div>

          {/* Earnings */}
          {(r.grossPaidGbp ?? r.netToOwnerGbp) != null && (
            <div className="flex items-center justify-between text-xs px-2.5 py-2 rounded-lg border border-white/5">
              <span className="text-slate-400">Earnings</span>
              <span className="text-slate-200 font-medium">
                <span className="text-emerald-300">{fmtGbp(r.netToOwnerGbp)}</span>
                {r.grossPaidGbp != null && (
                  <span className="text-slate-500 ml-2">net · {fmtGbp(r.grossPaidGbp)} gross</span>
                )}
              </span>
            </div>
          )}

          {/* Items */}
          <section>
            <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">
              Items ({r.items?.length ?? r.itemNames.length})
            </h4>
            <ul className="space-y-1.5">
              {(r.items ?? r.itemNames.map((name) => ({ name, imageUrl: null, qty: 1 }))).map(
                (it, idx) => (
                  <li
                    key={idx}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-white/5 hover:bg-white/[0.03]"
                  >
                    {it.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={it.imageUrl}
                        alt=""
                        className="w-10 h-10 rounded object-cover flex-shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded flex-shrink-0 flex items-center justify-center text-[10px] text-slate-500"
                        style={{ background: "rgba(255,255,255,0.04)" }}
                      >
                        no img
                      </div>
                    )}
                    <span className="text-sm text-slate-200 flex-1 truncate">{it.name}</span>
                    {it.qty != null && it.qty > 1 && (
                      <span className="text-[11px] text-slate-400">×{it.qty}</span>
                    )}
                  </li>
                ),
              )}
            </ul>
          </section>

          {/* Notes */}
          {r.notes && r.notes.trim().length > 0 && (
            <section>
              <h4 className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">Notes</h4>
              <p
                className="text-xs text-slate-300 whitespace-pre-wrap px-2.5 py-2 rounded-lg"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                {r.notes}
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
