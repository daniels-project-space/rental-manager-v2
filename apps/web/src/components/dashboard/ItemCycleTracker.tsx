"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 30 | 60 | 90;

function UtilBar({ pct }: { pct: number }) {
  const color = pct >= 0.6 ? "#22c55e" : pct >= 0.3 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <div
        className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ background: "rgba(255,255,255,0.08)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, pct * 100).toFixed(1)}%`, background: color }}
        />
      </div>
      <span className="text-xs font-medium w-10 text-right" style={{ color }}>
        {(pct * 100).toFixed(0)}%
      </span>
    </div>
  );
}

export function ItemCycleTracker() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(30);
  const [sortBy, setSortBy] = useState<"util" | "name">("util");

  const data = useQuery(api.items.getItemCycles, {
    accountSlug: activeAccountSlug,
    days,
  });

  const dayOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 },
    { label: "60d", val: 60 },
    { label: "90d", val: 90 },
  ];

  const sorted = data
    ? [...data].sort((a, b) =>
        sortBy === "util"
          ? b.utilizationPct - a.utilizationPct
          : a.name.localeCompare(b.name)
      )
    : [];

  const avgUtil =
    data && data.length > 0
      ? data.reduce((s, i) => s + i.utilizationPct, 0) / data.length
      : 0;

  return (
    <Card>
      <CardHeader
        title="Item Cycle Tracker"
        badge={
          data ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: "rgba(110,168,254,0.12)", color: "#6ea8fe" }}
            >
              avg {(avgUtil * 100).toFixed(0)}%
            </span>
          ) : null
        }
        actions={
          <div className="flex gap-1">
            {dayOpts.map((d) => (
              <button
                key={d.val}
                onClick={() => setDays(d.val)}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{
                  background: days === d.val ? "rgba(110,168,254,0.2)" : "transparent",
                  color: days === d.val ? "#6ea8fe" : "#8b8fa3",
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {data === undefined && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <SkeletonBlock key={i} className="h-8 w-full rounded" />
          ))}
        </div>
      )}

      {data !== undefined && data.length === 0 && (
        <EmptyState message="No active items found" icon="⟳" />
      )}

      {data !== undefined && data.length > 0 && (
        <>
          <div className="flex gap-2 mb-3">
            {(["util", "name"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{
                  background: sortBy === s ? "rgba(255,255,255,0.08)" : "transparent",
                  color: sortBy === s ? "#e4e6eb" : "#8b8fa3",
                }}
              >
                {s === "util" ? "By utilization" : "A–Z"}
              </button>
            ))}
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {sorted.map((item) => (
              <div
                key={item.itemId as string}
                className="flex items-center gap-3 py-1.5 px-2 rounded-lg"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                <span
                  className="text-xs truncate"
                  style={{ color: "#e4e6eb", minWidth: 0, flex: "0 0 40%" }}
                  title={item.name}
                >
                  {item.name}
                </span>
                <UtilBar pct={item.utilizationPct} />
                <span className="text-xs flex-shrink-0" style={{ color: "#8b8fa3" }}>
                  {item.rentalDays}d rented
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
