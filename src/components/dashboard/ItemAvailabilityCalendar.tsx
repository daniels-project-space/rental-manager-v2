"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

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
function dayParts(ymd: string): { wd: string; num: number } {
  const d = new Date(ymd + "T00:00:00Z");
  return { wd: d.toLocaleString("en", { weekday: "short", timeZone: "UTC" }), num: d.getUTCDate() };
}
function fmtShort(ymd: string): string {
  return new Date(ymd + "T00:00:00Z").toLocaleString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

type AvailCell = { date: string; free: number; total: number; booked: number; free_from?: string | null; pending?: number };
type AvailItem = { item_id: string; name: string; qty: number; image_url?: string | null; availability: AvailCell[]; owned?: boolean };

/**
 * Item Availability — a dedicated weekly calendar that does ONE thing: search an
 * item and see how many units are free each day (time-aware, repair-aware), so
 * the owner can answer "can I take this booking?" without opening the full
 * timeline. Backed by calendar.searchCalendarInventory.
 */
export function ItemAvailabilityCalendar() {
  const { activeAccountSlug } = useAccount();
  const today = londonToday();
  const [weekStart, setWeekStart] = useState(() => getMondayOf(today));
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");

  // Debounce the search so we don't hit the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  const data = useQuery(api.calendar.searchCalendarInventory, {
    query,
    weekStartIso: weekStart,
    accountSlug: activeAccountSlug,
  }) as { weekStart: string; dates: string[]; items: AvailItem[] } | undefined;

  const weekEnd = addDays(weekStart, 6);
  const minWeek = getMondayOf(today);
  const maxWeek = addDays(minWeek, 28);
  const canPrev = weekStart > minWeek;
  const canNext = weekStart < maxWeek;

  // Day columns — always 7 from the returned week (present even with no query).
  const dates = useMemo(() => {
    if (data?.dates?.length) return data.dates;
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [data, weekStart]);

  const items = data?.items ?? [];

  return (
    <Card className="hidden md:block">
      <CardHeader
        title="Item Availability"
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
            <span className="tabular-nums">{fmtShort(weekStart)} – {fmtShort(weekEnd)}</span>
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

      {/* Search bar */}
      <div className="mt-1 mb-3 relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8b8fa3] text-sm">🔍</span>
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            const back = e.key === "ArrowUp" || (e.key === "ArrowLeft" && raw === "");
            const fwd = e.key === "ArrowDown" || (e.key === "ArrowRight" && raw === "");
            if (back) { e.preventDefault(); setWeekStart((w) => (w > minWeek ? addDays(w, -7) : w)); }
            else if (fwd) { e.preventDefault(); setWeekStart((w) => (w < maxWeek ? addDays(w, 7) : w)); }
          }}
          placeholder="Search an item — ↑/↓ change week…"
          className="w-full text-sm rounded-lg pl-8 pr-3 py-2"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e6eb" }}
        />
        {raw && (
          <button
            onClick={() => setRaw("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8b8fa3] hover:text-white text-sm"
            aria-label="Clear"
          >
            ×
          </button>
        )}
      </div>

      {/* Day-number header row */}
      <div className="grid grid-cols-[minmax(120px,1.4fr)_repeat(7,1fr)] gap-1 mb-1">
        <div />
        {dates.map((d) => {
          const { wd, num } = dayParts(d);
          const isToday = d === today;
          return (
            <div
              key={d}
              className="flex flex-col items-center py-1 rounded-md"
              style={{ background: isToday ? "rgba(110,168,254,0.1)" : undefined }}
            >
              <span className="text-[9px] uppercase text-[#8b8fa3]">{wd}</span>
              <span className="text-[12px] font-semibold" style={{ color: isToday ? "#6ea8fe" : "#e4e6eb" }}>{num}</span>
            </div>
          );
        })}
      </div>

      {data === undefined ? (
        <SkeletonBlock className="h-24 w-full" />
      ) : !query ? (
        <p className="text-xs text-[#8b8fa3] text-center py-6">
          Type an item above to check how many units are free each day.
        </p>
      ) : items.length === 0 ? (
        <p className="text-xs text-[#8b8fa3] text-center py-6">No item matches “{query}”.</p>
      ) : (
        <div className="space-y-1">
          {items.map((it) => {
            const byDate = new Map(it.availability.map((c) => [c.date, c]));
            return (
              <div key={it.item_id} className="grid grid-cols-[minmax(120px,1.4fr)_repeat(7,1fr)] gap-1 items-center">
                <div className="flex items-center gap-2 min-w-0 pr-1">
                  {it.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.image_url} alt="" className="w-7 h-7 rounded object-cover flex-shrink-0" loading="lazy" />
                  ) : (
                    <div className="w-7 h-7 rounded flex-shrink-0" style={{ background: "rgba(255,255,255,0.06)" }} />
                  )}
                  <div className="min-w-0">
                    <div className="text-[12px] text-[#e4e6eb] truncate font-medium">{it.name}</div>
                    <div className="text-[9px]" style={{ color: it.owned === false ? "#a78bfa" : "#8b8fa3" }}>{it.owned === false ? "listed · not owned" : `${it.qty} owned`}</div>
                  </div>
                </div>
                {dates.map((d) => {
                  const cell = byDate.get(d);
                  const free = cell?.free;
                  const pending = cell?.pending ?? 0;
                  const tot = cell?.total;
                  const freeFrom = cell?.free_from ?? null;
                  const showFrom = !!freeFrom && (free ?? 0) <= 0;
                  let color = "#6b7280";
                  let bg: string | undefined = d === today ? "rgba(59,130,246,0.06)" : undefined;
                  if (free !== undefined && tot !== undefined) {
                    if (free <= 0) {
                      if (showFrom) { color = "#fbbf24"; bg = "rgba(251,191,36,0.1)"; }
                      else { color = "#f87171"; bg = "rgba(248,113,113,0.1)"; }
                    } else if (free < tot) color = "#fbbf24";
                    else color = "#34d399";
                  }
                  return (
                    <div
                      key={d}
                      className="flex flex-col items-center justify-center rounded-md py-1.5"
                      style={{ background: bg, border: "1px solid rgba(255,255,255,0.04)" }}
                      title={cell ? `${free} of ${tot} free · ${d}${pending > 0 ? ` · ${pending} pending` : ""}${showFrom ? ` · 1 free from ${freeFrom}` : ""}` : `no data · ${d}`}
                    >
                      <span className="text-sm font-bold tabular-nums leading-none" style={{ color }}>
                        {free !== undefined ? free : "–"}
                        {pending > 0 && <span className="text-[9px] font-semibold" style={{ color: "#a78bfa" }}>{` (-${pending})`}</span>}
                      </span>
                      {showFrom ? (
                        <span className="text-[8px] leading-none mt-0.5" style={{ color: "#fbbf24" }}>{`fr ${freeFrom}`}</span>
                      ) : tot !== undefined ? (
                        <span className="text-[9px] leading-none mt-0.5 text-[#64748b]">/{tot}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
