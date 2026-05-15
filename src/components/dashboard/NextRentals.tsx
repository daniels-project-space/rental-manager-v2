"use client";

import { memo, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { ACCOUNT_PILL, fmtTime } from "./stat-cards/ActiveDrawer";

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

const PILL_FALLBACK = { bg: "bg-slate-800 border border-slate-700", text: "text-slate-300" };

function AccountPill({ slug }: { slug: string }) {
  const p = ACCOUNT_PILL[slug] ?? PILL_FALLBACK;
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${p.bg} ${p.text}`}>
      {slug}
    </span>
  );
}

function OutChips({ tiles, items }: { tiles: ItemTile[]; items: string[] }) {
  const hasTiles = tiles.length > 0;
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wider text-emerald-300/70 font-semibold mb-1">
        going out
      </div>
      <div className="flex flex-wrap gap-1">
        {hasTiles
          ? tiles.map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded border bg-emerald-500/10 border-emerald-500/30 text-emerald-200 pl-1 pr-2 py-1"
              >
                <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded bg-slate-900/60 ring-1 ring-emerald-500/20">
                  {t.image_url ? (
                    <Image
                      src={t.image_url}
                      alt={t.name}
                      fill
                      sizes="32px"
                      className="object-cover"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[8px] text-slate-600">
                      no img
                    </div>
                  )}
                </div>
                <span className="text-[11px] truncate max-w-[140px]">{t.name}</span>
                {t.qty > 1 && (
                  <span className="text-[10px] font-bold bg-emerald-500/20 px-1 rounded">×{t.qty}</span>
                )}
              </div>
            ))
          : items.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="inline-flex items-center rounded border bg-emerald-500/10 border-emerald-500/30 text-emerald-200 px-2 py-1 text-[11px]"
              >
                {name}
              </span>
            ))}
      </div>
    </div>
  );
}

function InChips({ returns }: { returns: ConcurrentReturn[] }) {
  if (returns.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wider text-amber-300/80 font-semibold mb-1">
        ↑ returning at this slot
      </div>
      <div className="flex flex-col gap-1">
        {returns.map((r) => {
          const tiles = r.item_tiles;
          const hasTiles = tiles.length > 0;
          return (
            <div
              key={r.reservation_id}
              className="rounded border bg-amber-500/10 border-amber-500/30 text-amber-200 px-2 py-1.5"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-semibold tabular-nums">{fmtTime(r.return_time) ?? "--:--"}</span>
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
                        {name}
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

interface PickupCardProps {
  pickup: Pickup;
  isNext: boolean;
  progress: number;
  countdown: string;
}

const PickupCard = memo(function PickupCard({ pickup, isNext, progress, countdown }: PickupCardProps) {
  const baseClasses =
    "rounded-lg border border-slate-800 bg-slate-900/40 p-3 transition-transform";
  const stateClasses = isNext
    ? "-translate-y-[2px] shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-500/40 relative"
    : "ring-1 ring-slate-800 shadow-sm";

  return (
    <div className={`${baseClasses} ${stateClasses}`}>
      {isNext && (
        <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 text-[9px] font-bold uppercase tracking-wider">
          Next Up
        </span>
      )}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-16">
        <span className="text-lg font-bold tabular-nums text-slate-100">
          ⏰ {fmtTime(pickup.pickup_time) ?? "--:--"}
        </span>
        <span className="text-xs text-slate-400">{countdown}</span>
        <span className="text-sm font-semibold text-slate-100 truncate">
          {pickup.renter_name ?? "—"}
        </span>
        <AccountPill slug={pickup.account_slug} />
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <OutChips tiles={pickup.item_tiles} items={pickup.items} />
      <InChips returns={pickup.concurrent_returns} />
    </div>
  );
});

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 ring-1 ring-slate-800 animate-pulse">
      <div className="flex items-center gap-2">
        <div className="h-5 w-16 rounded bg-slate-800" />
        <div className="h-3 w-20 rounded bg-slate-800" />
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-slate-800" />
      <div className="mt-3 flex gap-1">
        <div className="h-8 w-24 rounded bg-slate-800" />
        <div className="h-8 w-20 rounded bg-slate-800" />
      </div>
    </div>
  );
}

export function NextRentals() {
  const { activeAccountSlug } = useAccount();
  const [day, setDay] = useState<"today" | "tomorrow">("today");
  const data = useQuery(api.dashboard.getNextRentals, { accountSlug: activeAccountSlug, day });

  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const nextUpId = useMemo(() => {
    if (!data || data.pickups.length === 0) return null;
    if (day === "tomorrow") return data.pickups[0].reservation_id;
    const nowHM = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const next = data.pickups.find((p) => (p.pickup_time ?? "23:59") >= nowHM) ?? data.pickups[0];
    return next.reservation_id;
  }, [data, now, day]);

  function progressFor(pickupTime: string | null): number {
    if (!pickupTime || day === "tomorrow") return 0;
    const [hh, mm] = pickupTime.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 0;
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const total = target.getTime() - start.getTime();
    if (total <= 0) return 1;
    const elapsed = now.getTime() - start.getTime();
    return Math.max(0, Math.min(1, elapsed / total));
  }

  function countdownLabel(pickupTime: string | null): string {
    if (!pickupTime) return "";
    if (day === "tomorrow") return `tomorrow ${pickupTime.slice(0, 5)}`;
    const [hh, mm] = pickupTime.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return "";
    const target = new Date(now);
    target.setHours(hh, mm, 0, 0);
    const diffMin = Math.round((target.getTime() - now.getTime()) / 60_000);
    if (diffMin < 0) return "passed";
    if (diffMin < 60) return `in ${diffMin}m`;
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-200">
          Next Rentals
        </h2>
        <div className="inline-flex gap-1">
          <button
            type="button"
            onClick={() => setDay("today")}
            className={`px-2.5 py-1 rounded border text-[11px] font-semibold uppercase tracking-wider ${
              day === "today"
                ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40"
                : "bg-slate-800/60 text-slate-400 border-slate-700"
            }`}
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setDay("tomorrow")}
            className={`px-2.5 py-1 rounded border text-[11px] font-semibold uppercase tracking-wider ${
              day === "tomorrow"
                ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/40"
                : "bg-slate-800/60 text-slate-400 border-slate-700"
            }`}
          >
            Tomorrow
          </button>
        </div>
      </div>

      <div className="max-h-[520px] overflow-y-auto pr-1">
        {data === undefined ? (
          <div className="space-y-3">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : data.pickups.length === 0 ? (
          <p className="italic text-slate-500 text-sm">No pickups {day}.</p>
        ) : (
          <div className="space-y-3">
            {data.pickups.map((p) => (
              <PickupCard
                key={p.reservation_id}
                pickup={p as Pickup}
                isNext={p.reservation_id === nextUpId}
                progress={progressFor(p.pickup_time)}
                countdown={countdownLabel(p.pickup_time)}
              />
            ))}
          </div>
        )}

        {data && data.unpairedReturns.length > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-800">
            <h3 className="text-[11px] uppercase tracking-wider text-amber-300 font-bold mb-2">
              Other returns {day}
            </h3>
            <div className="flex flex-col gap-1">
              {data.unpairedReturns.map((r) => {
                const count = r.item_tiles.length > 0 ? r.item_tiles.length : r.items.length;
                return (
                  <div
                    key={r.reservation_id}
                    className="inline-flex flex-wrap items-center gap-2 rounded border bg-amber-500/10 border-amber-500/30 text-amber-200 px-2 py-1 text-[11px]"
                  >
                    <span className="font-semibold tabular-nums">
                      {fmtTime(r.return_time) ?? "--:--"}
                    </span>
                    <span className="truncate">{r.renter_name ?? "—"}</span>
                    <AccountPill slug={r.account_slug} />
                    <span className="text-amber-300/70 text-[10px]">
                      {count} {count === 1 ? "item" : "items"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
