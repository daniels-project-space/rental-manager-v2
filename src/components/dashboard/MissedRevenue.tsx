"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 30 | 90;

export function MissedRevenue() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(30);

  const data = useQuery(api.revenue.getMissedRevenue, {
    accountSlug: activeAccountSlug,
    days,
  });

  const dayOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 },
    { label: "90d", val: 90 },
  ];

  return (
    <Card>
      <CardHeader
        title="Missed Revenue"
        actions={
          <div className="flex gap-1">
            {dayOpts.map((d) => (
              <button
                key={d.val}
                onClick={() => setDays(d.val)}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{
                  background: days === d.val ? "rgba(239,68,68,0.2)" : "transparent",
                  color: days === d.val ? "#ef4444" : "#8b8fa3",
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {data === undefined && (
        <div className="space-y-3">
          <SkeletonBlock className="h-10 w-40 rounded" />
          <SkeletonBlock className="h-px w-full" />
          {[...Array(3)].map((_, i) => (
            <SkeletonBlock key={i} className="h-8 w-full rounded" />
          ))}
        </div>
      )}

      {data !== undefined && (
        <>
          {/* Summary */}
          <div className="mb-4 pb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <p className="text-xs uppercase tracking-wider mb-1" style={{ color: "#8b8fa3" }}>
              Total Missed
            </p>
            <p className="text-3xl font-bold" style={{ color: "#ef4444" }}>
              £{data.totalMissed.toFixed(2)}
            </p>
            <p className="text-xs mt-1" style={{ color: "#8b8fa3" }}>
              {data.denialLosses.length} denial{data.denialLosses.length !== 1 ? "s" : ""} — last {days} days
            </p>
          </div>

          {/* Denial losses */}
          {data.denialLosses.length === 0 ? (
            <EmptyState message="No denial records this period" icon="✓" />
          ) : (
            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
              <p className="text-xs font-medium mb-2" style={{ color: "#8b8fa3" }}>
                Denial Losses
              </p>
              {data.denialLosses.map((d) => (
                <div
                  key={d.denialId as string}
                  className="flex items-center justify-between px-2.5 py-2 rounded-lg"
                  style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.1)" }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: "#e4e6eb" }}>
                      {d.itemName ?? "Unknown item"}
                    </p>
                    <p className="text-xs truncate" style={{ color: "#8b8fa3" }}>
                      {d.reason ?? "No reason"}
                    </p>
                  </div>
                  <span
                    className="text-xs font-semibold flex-shrink-0 ml-2"
                    style={{ color: d.estimatedValue > 0 ? "#ef4444" : "#8b8fa3" }}
                  >
                    {d.estimatedValue > 0 ? `−£${d.estimatedValue.toFixed(2)}` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
