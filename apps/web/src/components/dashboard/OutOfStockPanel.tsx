"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function formatDate(dateStr: string | null) {
  if (!dateStr) return "Unknown";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function OutOfStockPanel() {
  const { activeAccountSlug } = useAccount();

  const data = useQuery(api.items.getOutOfStockItems, {
    accountSlug: activeAccountSlug,
    lookAheadDays: 14,
  });

  return (
    <Card>
      <CardHeader
        title="Out of Stock"
        badge={
          data ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444" }}
            >
              {data.length}
            </span>
          ) : null
        }
      />

      {data === undefined && (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <SkeletonBlock key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      )}

      {data !== undefined && data.length === 0 && (
        <EmptyState message="All items available" icon="✓" />
      )}

      {data !== undefined && data.length > 0 && (
        <div className="space-y-2">
          {data.map((item) => {
            const days = daysUntil(item.nextAvailableDate);
            return (
              <div
                key={item.itemId as string}
                className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)" }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: "#e4e6eb" }}>
                    {item.name}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "#8b8fa3" }}>
                    {item.activeReservationCount} active booking{item.activeReservationCount !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="text-right flex-shrink-0 ml-3">
                  {item.nextAvailableDate ? (
                    <>
                      <p className="text-xs font-medium" style={{ color: "#f59e0b" }}>
                        Free {formatDate(item.nextAvailableDate)}
                      </p>
                      {days !== null && (
                        <p className="text-xs" style={{ color: "#8b8fa3" }}>
                          {days > 0 ? `in ${days}d` : "today"}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs" style={{ color: "#8b8fa3" }}>No date</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
