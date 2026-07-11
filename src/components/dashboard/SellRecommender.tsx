"use client";
import { api } from "../../../convex/_generated/api";
import { useStableQuery } from "@/lib/dashboard/use-stable-query";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function UtilPill({ pct }: { pct: number }) {
  // pct is a 0–100 percentage (getSellRecommendations.utilizationPct), NOT a
  // fraction — was scaled ×100 again (12% util rendered as "1200%", always green).
  const color = pct < 20 ? "#ef4444" : pct < 40 ? "#f59e0b" : "#22c55e";
  const bg = pct < 20 ? "rgba(239,68,68,0.15)" : pct < 40 ? "rgba(245,158,11,0.15)" : "rgba(34,197,94,0.15)";
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded font-medium"
      style={{ color, background: bg }}
    >
      {pct.toFixed(0)}%
    </span>
  );
}

export function SellRecommender() {
  const { activeAccountSlug } = useAccount();
  const data = useStableQuery(api.items.getSellRecommendations, {
    accountSlug: activeAccountSlug,
  });

  return (
    <Card>
      <CardHeader
        title="Sell Recommender"
        badge={
          data ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
            >
              {data.length} flagged
            </span>
          ) : null
        }
      />

      {data === undefined && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <SkeletonBlock key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      )}

      {data !== undefined && data.length === 0 && (
        <EmptyState message="All items performing well" icon="✓" />
      )}

      {data !== undefined && data.length > 0 && (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
          {data.map((item) => (
            <div
              key={item!.itemId as string}
              className="flex items-start justify-between px-3 py-2.5 rounded-lg gap-2"
              style={{ background: "rgba(245,158,11,0.04)", border: "1px solid rgba(245,158,11,0.1)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate" style={{ color: "#e4e6eb" }}>
                    {item!.name}
                  </span>
                  <UtilPill pct={item!.utilizationPct} />
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}
                  >
                    {item!.reason}
                  </span>
                </div>
                <div className="flex gap-3 mt-1 text-xs" style={{ color: "#8b8fa3" }}>
                  <span>{item!.ageMonths.toFixed(0)} mo old</span>
                  {item!.estResaleValue !== null && (
                    <span>Est. resale £{item!.estResaleValue.toFixed(0)}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
