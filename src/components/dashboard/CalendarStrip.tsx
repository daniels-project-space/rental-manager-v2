"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

const TODAY = () => new Date().toISOString().slice(0, 10);

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(dateStr: string) {
  const d = new Date(dateStr);
  return {
    day: d.toLocaleString("en", { weekday: "short" }),
    num: d.getDate(),
  };
}

function AccountChip({
  name,
  accountSlug,
  overdue,
}: {
  name: string;
  accountSlug?: string;
  overdue?: boolean;
}) {
  const color = accountSlug === "dbcinema" ? "#6ea8fe" : "#22c55e";
  return (
    <span
      className="inline-block text-xs px-1.5 py-0.5 rounded truncate max-w-[90px]"
      style={{
        background: overdue ? "rgba(239,68,68,0.15)" : `${color}22`,
        color: overdue ? "#ef4444" : color,
        borderLeft: `2px solid ${overdue ? "#ef4444" : color}`,
      }}
      title={name}
    >
      {overdue && "⚠ "}{name}
    </span>
  );
}

export function CalendarStrip() {
  const { activeAccountSlug } = useAccount();
  const today = TODAY();
  const [expanded, setExpanded] = useState<string | null>(null);

  const data = useQuery(api.calendar.getCalendarStrip, {
    accountSlug: activeAccountSlug,
    startDate: today,
    days: 5,
  });

  return (
    <Card>
      <CardHeader title="5-Day Calendar" />
      {data === undefined ? (
        <div className="grid grid-cols-5 gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonBlock key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-2">
          {data.map((day) => {
            const isToday = day.date === today;
            const isExpanded = expanded === day.date;
            const { day: dLabel, num } = dayLabel(day.date);
            const totalEvents = day.pickups.length + day.returns.length;

            return (
              <div key={day.date}>
                <button
                  onClick={() => setExpanded(isExpanded ? null : day.date)}
                  className="w-full text-left rounded-xl p-2 transition-colors hover:bg-white/5"
                  style={{
                    border: isToday
                      ? "1px solid rgba(110,168,254,0.5)"
                      : "1px solid rgba(255,255,255,0.08)",
                    boxShadow: isToday
                      ? "0 0 12px rgba(110,168,254,0.15)"
                      : "none",
                    background: isToday ? "rgba(110,168,254,0.05)" : "transparent",
                  }}
                >
                  <div className="text-xs text-[#8b8fa3]">{dLabel}</div>
                  <div
                    className="text-lg font-bold"
                    style={{ color: isToday ? "#6ea8fe" : "#e4e6eb" }}
                  >
                    {num}
                  </div>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {day.pickups.length > 0 && (
                      <span className="text-xs px-1 rounded" style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>
                        ↑{day.pickups.length}
                      </span>
                    )}
                    {day.returns.length > 0 && (
                      <span className="text-xs px-1 rounded" style={{ background: "rgba(110,168,254,0.15)", color: "#6ea8fe" }}>
                        ↓{day.returns.length}
                      </span>
                    )}
                    {totalEvents === 0 && (
                      <span className="text-xs text-[#8b8fa3]">—</span>
                    )}
                  </div>
                </button>

                {/* Expanded day detail */}
                {isExpanded && (
                  <div className="mt-1 space-y-1">
                    {day.pickups.map((p) => (
                      <AccountChip
                        key={String(p.reservationId)}
                        name={p.itemNames[0] ?? "?"}
                        accountSlug={p.accountSlug}
                      />
                    ))}
                    {day.returns.map((r) => (
                      <AccountChip
                        key={String(r.reservationId)}
                        name={r.itemNames[0] ?? "?"}
                        accountSlug={r.accountSlug}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
