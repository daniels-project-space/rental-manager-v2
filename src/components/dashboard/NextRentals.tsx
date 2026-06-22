"use client";

/**
 * NextRentals widget — visual redesign (Phase 6.1)
 *
 * Design pillars:
 *  - Hero card for NEXT UP: 5xl tabular-nums time, pulsing dot, shimmer-overlay progress.
 *  - Time-spine left rail with event dots (filled glowing for next-up, hollow for future,
 *    dimmed for passed).
 *  - Progressive density: hero > medium (<=2h away) > compact (>2h) > dimmed (passed).
 *  - Action language: "\u2192 PULL" (emerald) above OUT chips, "\u2190 BACK" (amber) above IN chips.
 *  - CSS-variable-driven progress bar: parent sets `--progress` per tick; card body memoized
 *    on a minute-bucketed `now` prop so memo hits across 60s ticks.
 *  - Pure CSS (no new deps). Tailwind 4 utility-first; inline styles only for CSS vars.
 */

import { memo, useEffect, useMemo, useState } from "react";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { ACCOUNT_PILL, fmtTime } from "./stat-cards/ActiveDrawer";

// ---------------------------------------------------------------------------
// Types (mirror the wire shape from getNextRentals — unchanged from v1).
// ---------------------------------------------------------------------------

type ItemTile = { name: string; image_url: string | null; qty: number };

type ConcurrentReturn = {
  reservation_id: string;
  renter_name: string | null;
  account_slug: string;
  start_date: string | null;
  end_date: string | null;
  pickup_date: string | null;
  pickup_time: string | null;
  return_date: string | null;
  return_time: string | null;
  pickup_method: string | null;
  return_method: string | null;
  items: string[];
  photo_url: string | null;
  net_gbp: number | null;
  duration_days: number | null;
  role: "return";
  item_tiles: ItemTile[];
};

type Pickup = Omit<ConcurrentReturn, "role"> & {
  role: "pickup";
  concurrent_returns: ConcurrentReturn[];
};

// Bucket for visual density.
type Density = "hero" | "medium" | "compact" | "passed";

const PILL_FALLBACK = { bg: "bg-slate-800 border border-slate-700", text: "text-slate-300" };

// ---------------------------------------------------------------------------
// AccountPill — tiny coloured slug badge.
// ---------------------------------------------------------------------------

function AccountPill({ slug }: { slug: string }) {
  const p = ACCOUNT_PILL[slug] ?? PILL_FALLBACK;
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${p.bg} ${p.text}`}
    >
      {slug}
    </span>
  );
}

// ---------------------------------------------------------------------------
// EventDot — circle pegged onto the time-spine rail per card.
// State drives fill: hero glows, future hollows, passed dims.
// ---------------------------------------------------------------------------

function EventDot({ density }: { density: Density }) {
  const base =
    "absolute top-4 -left-[7px] h-3 w-3 rounded-full ring-2 ring-slate-950 transition-colors duration-200";
  if (density === "hero") {
    return (
      <span
        aria-hidden
        className={`${base} bg-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.65)] animate-[nr-pulse_2.4s_ease-in-out_infinite]`}
      />
    );
  }
  if (density === "medium") {
    return (
      <span aria-hidden className={`${base} bg-emerald-500/30 border border-emerald-400/60`} />
    );
  }
  if (density === "compact") {
    return (
      <span aria-hidden className={`${base} bg-slate-900 border border-emerald-500/40`} />
    );
  }
  return <span aria-hidden className={`${base} bg-slate-800 border border-slate-700`} />;
}

// ---------------------------------------------------------------------------
// ProgressBar — width driven by CSS var `--progress` set on the card root.
// Hero gets a shimmer overlay; passed bars are desaturated.
// ---------------------------------------------------------------------------

function ProgressBar({ density }: { density: Density }) {
  const trackHeight = density === "hero" ? "h-2" : density === "compact" ? "h-[3px]" : "h-1.5";
  const fillClasses =
    density === "passed"
      ? "bg-slate-600/60"
      : density === "hero"
      ? "bg-gradient-to-r from-emerald-600 via-emerald-400 to-emerald-300"
      : "bg-gradient-to-r from-emerald-600 to-emerald-400";
  return (
    <div
      className={`relative ${trackHeight} rounded-full bg-slate-800 overflow-hidden`}
      aria-hidden
    >
      <div
        className={`h-full ${fillClasses} transition-[width] duration-500 ease-out`}
        style={{ width: "var(--progress, 0%)" }}
      />
      {density === "hero" && (
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.22) 50%, transparent 100%)",
            backgroundSize: "40% 100%",
            backgroundRepeat: "no-repeat",
            animation: "nr-shimmer 2s linear infinite",
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OutChips — items being PULLED. Lead with directional verb.
// Thumb size scales with density.
// ---------------------------------------------------------------------------

function OutChips({
  tiles,
  items,
  density,
}: {
  tiles: ItemTile[];
  items: string[];
  density: Density;
}) {
  const hasTiles = tiles.length > 0;
  const totalCount = hasTiles ? tiles.length : items.length;

  // Compact + passed: collapse to a single item-count chip — keeps the rail tidy.
  if (density === "compact" || density === "passed") {
    if (totalCount === 0) return null;
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300/80">
          → Pull
        </span>
        <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200">
          {totalCount} {totalCount === 1 ? "item" : "items"}
        </span>
      </div>
    );
  }

  const thumbPx = density === "hero" ? 48 : 40;

  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300/90">
        → Pull
      </div>
      <div className="flex flex-wrap gap-1">
        {hasTiles
          ? tiles.map((t, i) => (
              <span
                key={`${t.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 pr-2 text-[11px] text-emerald-100"
                title={`${t.name}${t.qty > 1 ? ` (×${t.qty})` : ""}`}
              >
                {t.image_url ? (
                  // Plain <img> for memo-stability and lazy loading without next/image churn.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.image_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={thumbPx}
                    height={thumbPx}
                    sizes={`${thumbPx}px`}
                    className="zoom-img rounded-l shrink-0 object-cover bg-slate-800"
                    style={{ width: thumbPx, height: thumbPx }}
                  />
                ) : (
                  <span
                    className="rounded-l shrink-0 bg-emerald-500/20"
                    style={{ width: thumbPx, height: thumbPx }}
                  />
                )}
                <span className="truncate max-w-[120px]">{t.name}</span>
                {t.qty > 1 && (
                  <span className="font-bold text-emerald-300">×{t.qty}</span>
                )}
              </span>
            ))
          : items.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-100"
              >
                <span className="truncate max-w-[140px]">{name}</span>
              </span>
            ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InChips — concurrent returns (items coming BACK at this slot).
// ---------------------------------------------------------------------------

function InChips({
  returns,
  density,
}: {
  returns: ConcurrentReturn[];
  density: Density;
}) {
  if (returns.length === 0) return null;

  if (density === "compact" || density === "passed") {
    const totalItems = returns.reduce(
      (acc, r) => acc + (r.item_tiles.length > 0 ? r.item_tiles.length : r.items.length),
      0,
    );
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300/80">
          ← Back
        </span>
        <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
          {returns.length} renter{returns.length === 1 ? "" : "s"} · {totalItems}{" "}
          {totalItems === 1 ? "item" : "items"}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-amber-300/90">
        ← Back
      </div>
      <div className="flex flex-col gap-1">
        {returns.map((r) => {
          const tiles = r.item_tiles;
          const hasTiles = tiles.length > 0;
          return (
            <div
              key={r.reservation_id}
              className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-200"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-semibold tabular-nums">
                  {fmtTime(r.return_time) ?? "--:--"}
                </span>
                <span className="truncate">{r.renter_name ?? "—"}</span>
                <AccountPill slug={r.account_slug} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {hasTiles
                  ? tiles.map((t, i) => (
                      <span
                        key={`${t.name}-${i}`}
                        className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px]"
                      >
                        <span className="truncate max-w-[120px]">{t.name}</span>
                        {t.qty > 1 && <span className="font-bold">×{t.qty}</span>}
                      </span>
                    ))
                  : r.items.map((name, i) => (
                      <span
                        key={`${name}-${i}`}
                        className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px]"
                      >
                        <span className="truncate max-w-[140px]">{name}</span>
                      </span>
                    ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PickupCard — memoized on minute-bucketed `nowBucket` so it doesn't re-render
// mid-minute. Inline `--progress` CSS var is the only thing that ticks faster.
// ---------------------------------------------------------------------------

interface PickupCardProps {
  pickup: Pickup;
  density: Density;
  progressPct: number; // 0..100
  countdown: string;
  /** Bucketed minute (Math.floor(now/60000)) — stable memo key. */
  nowBucket: number;
}

const PickupCard = memo(function PickupCard({
  pickup,
  density,
  progressPct,
  countdown,
}: PickupCardProps) {
  const isHero = density === "hero";
  const isPassed = density === "passed";
  const isCompact = density === "compact";

  // Layered container — radial gradient accent only on hero.
  const heroBg = isHero
    ? {
        backgroundImage:
          "radial-gradient(circle at 0 50%, rgba(16,185,129,0.10), transparent 45%)",
      }
    : undefined;

  const cardClasses = [
    "group relative rounded-xl border p-3 transition-all duration-200",
    "hover:bg-slate-900/60 hover:translate-x-[1px]",
    isHero
      ? "border-emerald-500/40 bg-slate-900/50 ring-1 ring-emerald-500/40 shadow-[0_0_24px_rgba(16,185,129,0.25)] p-4 [will-change:transform]"
      : isPassed
      ? "border-slate-800/60 bg-slate-900/20 opacity-40"
      : isCompact
      ? "border-slate-800 bg-slate-900/30"
      : "border-slate-800 bg-slate-900/40",
  ].join(" ");

  // Time block — size scales with density.
  const timeSize = isHero
    ? "text-5xl"
    : density === "medium"
    ? "text-2xl"
    : "text-lg";
  const timeColor = isPassed ? "text-slate-500 line-through" : "text-slate-100";

  return (
    <div
      className={cardClasses}
      style={
        {
          ...heroBg,
          // Drives ProgressBar width; only this style changes per tick.
          ["--progress" as string]: `${progressPct}%`,
        } as React.CSSProperties
      }
    >
      <EventDot density={density} />

      {isHero && (
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-200 ring-1 ring-emerald-500/40">
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-[nr-pulse_1.6s_ease-in-out_infinite]"
            aria-hidden
          />
          Next Up
        </span>
      )}

      {/* Time + meta row */}
      <div className="flex items-end gap-3">
        <div className="flex flex-col leading-none">
          <span
            className={`font-bold tabular-nums ${timeSize} ${timeColor} ${
              isHero ? "tracking-tight" : ""
            }`}
          >
            {fmtTime(pickup.pickup_time) ?? "--:--"}
          </span>
          {!isPassed && countdown ? (
            <span
              className={`mt-1 ${
                isHero ? "text-sm text-emerald-300/90" : "text-[11px] text-slate-400"
              } tabular-nums`}
            >
              {countdown}
            </span>
          ) : isPassed ? (
            <span className="mt-1 text-[11px] text-slate-500 uppercase tracking-wider">
              completed
            </span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 pb-1">
          <div className="flex items-center gap-2">
            <span
              className={`truncate font-semibold ${
                isHero ? "text-base text-slate-100" : "text-sm text-slate-200"
              }`}
            >
              {pickup.renter_name ?? "—"}
            </span>
            <AccountPill slug={pickup.account_slug} />
          </div>
        </div>
      </div>

      <div className={isHero ? "mt-3" : "mt-2"}>
        <ProgressBar density={density} />
      </div>

      <OutChips tiles={pickup.item_tiles} items={pickup.items} density={density} />
      <InChips returns={pickup.concurrent_returns} density={density} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// SkeletonCard — first paint while Convex query resolves.
// ---------------------------------------------------------------------------

function SkeletonCard({ hero = false }: { hero?: boolean }) {
  return (
    <div
      className={`relative rounded-xl border border-slate-800 ${
        hero ? "bg-slate-900/50 p-4 ring-1 ring-emerald-500/20" : "bg-slate-900/30 p-3"
      } animate-pulse`}
    >
      <div className="flex items-end gap-3">
        <div className={`rounded bg-slate-800 ${hero ? "h-12 w-32" : "h-6 w-20"}`} />
        <div className="h-3 w-24 rounded bg-slate-800" />
      </div>
      <div className={`mt-3 ${hero ? "h-2" : "h-1.5"} rounded-full bg-slate-800`} />
      <div className="mt-3 flex gap-1">
        <div className="h-8 w-24 rounded bg-slate-800" />
        <div className="h-8 w-20 rounded bg-slate-800" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState — inviting, not apologetic.
// ---------------------------------------------------------------------------

function EmptyState({ day }: { day: "today" | "tomorrow" }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-2xl text-emerald-300 ring-1 ring-emerald-500/30 shadow-[0_0_18px_rgba(16,185,129,0.25)]"
        aria-hidden
      >
        ⏱
      </div>
      <div className="mt-3 text-base font-semibold text-slate-200">All clear</div>
      <div className="mt-1 text-xs text-slate-500">No pickups scheduled for {day}.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date helpers.
// ---------------------------------------------------------------------------

function formatHeaderDate(day: "today" | "tomorrow"): string {
  const d = new Date();
  if (day === "tomorrow") d.setDate(d.getDate() + 1);
  // Example: "Wed 15 May"
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

// ---------------------------------------------------------------------------
// Main widget.
// ---------------------------------------------------------------------------

export function NextRentals() {
  const { activeAccountSlug } = useAccount();
  const [day, setDay] = useState<"today" | "tomorrow">("today");
  const data = useStableQuery(api.dashboard.getNextRentals, {
    accountSlug: activeAccountSlug,
    day,
  });

  // Live clock: tick every 60s. Bucket for memo stability.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const nowBucket = Math.floor(now.getTime() / 60_000);

  // Identify the next-up pickup (first one >= now today; first one tomorrow).
  const nextUpId = useMemo(() => {
    if (!data || data.pickups.length === 0) return null;
    if (day === "tomorrow") return data.pickups[0].reservation_id;
    const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes(),
    ).padStart(2, "0")}`;
    const next = data.pickups.find((p) => (p.pickup_time ?? "23:59") >= nowHM) ?? data.pickups[0];
    return next.reservation_id;
  }, [data, now, day]);

  /**
   * Minutes until the pickup. Negative for already-passed pickups.
   * Tomorrow pickups always return Infinity (we don't progress-track those).
   */
  function minutesUntil(pickupTime: string | null): number {
    if (!pickupTime) return Number.POSITIVE_INFINITY;
    if (day === "tomorrow") return Number.POSITIVE_INFINITY;
    const [hh, mm] = pickupTime.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return Number.POSITIVE_INFINITY;
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    return (target.getTime() - now.getTime()) / 60_000;
  }

  /** Density bucket from minutes-until + next-up flag. */
  function densityFor(isNext: boolean, minutes: number): Density {
    if (isNext) return "hero";
    if (minutes < 0) return "passed";
    if (minutes <= 120) return "medium";
    return "compact";
  }

  /** Progress 0..100 — for the bar fill. Approximate from a 6h ramp window. */
  function progressPctFor(isNext: boolean, minutes: number): number {
    if (day === "tomorrow") return 0;
    if (minutes < 0) return 100; // passed = full bar (desaturated colour conveys state).
    if (!isNext) {
      // Future, non-hero: ramp over a 6h window so closer cards visibly lead.
      const pct = 100 - Math.min(100, Math.max(0, (minutes / 360) * 100));
      return Math.round(pct);
    }
    // Hero: ramp from 4h-out to T-0 so the bar visibly fills as pickup approaches.
    const windowMin = 240;
    const pct = 100 - Math.min(100, Math.max(0, (minutes / windowMin) * 100));
    return Math.round(pct);
  }

  /** Human countdown label. */
  function countdownLabel(minutes: number): string {
    if (day === "tomorrow") return "tomorrow";
    if (!Number.isFinite(minutes)) return "";
    if (minutes < 0) {
      const past = Math.abs(Math.round(minutes));
      if (past < 60) return `${past}m ago`;
      const h = Math.floor(past / 60);
      const m = past % 60;
      return m === 0 ? `${h}h ago` : `${h}h ${m}m ago`;
    }
    const rounded = Math.round(minutes);
    if (rounded < 1) return "now";
    if (rounded < 60) return `in ${rounded}m`;
    const h = Math.floor(rounded / 60);
    const m = rounded % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
  }

  const pickupCount = data?.pickups.length ?? 0;
  const returnCount =
    (data?.unpairedReturns.length ?? 0) +
    (data?.pickups.reduce((acc, p) => acc + p.concurrent_returns.length, 0) ?? 0);
  const headerDate = useMemo(() => formatHeaderDate(day), [day]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      {/* Tailwind 4 / utility-first idiom: keep keyframes scoped inside the widget
          via a <style> tag wrapped in @layer utilities to dodge the cascade-layer
          gotcha noted in feedback_tailwind4_arbitrary_offsets.md. */}
      <style>{`
        @layer utilities {
          @keyframes nr-pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.55; transform: scale(0.92); }
          }
          @keyframes nr-shimmer {
            0% { background-position: -120% 0; }
            100% { background-position: 220% 0; }
          }
        }
      `}</style>

      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold uppercase tracking-wider text-slate-100">
            Next Rentals
          </h2>
          <div className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
            <span>{headerDate}</span>
            <span className="px-1.5 text-slate-700">·</span>
            <span>
              {pickupCount} pickup{pickupCount === 1 ? "" : "s"}
            </span>
            <span className="px-1.5 text-slate-700">·</span>
            <span>
              {returnCount} return{returnCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="inline-flex gap-1">
          <button
            type="button"
            onClick={() => setDay("today")}
            className={`px-2.5 py-1 rounded border text-[11px] font-semibold uppercase tracking-wider transition-colors duration-150 ${
              day === "today"
                ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40 shadow-inner shadow-emerald-500/20"
                : "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200"
            }`}
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setDay("tomorrow")}
            className={`px-2.5 py-1 rounded border text-[11px] font-semibold uppercase tracking-wider transition-colors duration-150 ${
              day === "tomorrow"
                ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40 shadow-inner shadow-emerald-500/20"
                : "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200"
            }`}
          >
            Tomorrow
          </button>
        </div>
      </div>

      {/* Cards rail — time-spine border on the left, dots ride on each card. */}
      <div className="max-h-[520px] overflow-y-auto pr-1">
        {data === undefined ? (
          <div className="space-y-3">
            <SkeletonCard hero />
            <SkeletonCard />
          </div>
        ) : data.pickups.length === 0 ? (
          <EmptyState day={day} />
        ) : (
          <div className="relative ml-1.5 space-y-3 border-l border-emerald-500/20 pl-4">
            {data.pickups.map((p) => {
              const isNext = p.reservation_id === nextUpId;
              const minutes = minutesUntil(p.pickup_time);
              const density = densityFor(isNext, minutes);
              const progressPct = progressPctFor(isNext, minutes);
              const countdown = countdownLabel(minutes);
              return (
                <PickupCard
                  key={p.reservation_id}
                  pickup={p as Pickup}
                  density={density}
                  progressPct={progressPct}
                  countdown={countdown}
                  nowBucket={nowBucket}
                />
              );
            })}
          </div>
        )}

        {/* Footer — unpaired returns as a horizontal scroll of amber pills. */}
        {data && data.unpairedReturns.length > 0 && (
          <div className="mt-4 border-t border-slate-800 pt-3">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-amber-300">
              Other returns {day}
            </h3>
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
              {data.unpairedReturns.map((r) => {
                const count = r.item_tiles.length > 0 ? r.item_tiles.length : r.items.length;
                const initial = (r.renter_name ?? "?").trim().charAt(0).toUpperCase() || "?";
                const fullInfo = `${fmtTime(r.return_time) ?? "--:--"} · ${
                  r.renter_name ?? "—"
                } · ${count} ${count === 1 ? "item" : "items"}`;
                return (
                  <span
                    key={r.reservation_id}
                    title={fullInfo}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 transition-colors duration-150 hover:bg-amber-500/20"
                  >
                    <span className="font-semibold tabular-nums">
                      {fmtTime(r.return_time) ?? "--:--"}
                    </span>
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-bold text-amber-100">
                      {initial}
                    </span>
                    <span className="text-amber-300/70 text-[10px] tabular-nums">
                      {count} {count === 1 ? "item" : "items"}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
