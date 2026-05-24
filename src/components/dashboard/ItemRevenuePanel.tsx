"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

// Phase 2.2 (2026-05-24): switched from live `api.items.getItemRevenueRanking`
// (which `.collect()`s reservations+pricing+items on every mount) to the
// cached MV `api.mv.top_earners.getRanking`, rebuilt hourly by
// `master.refreshFast`. Trade-off: fixed 30-day window (MV scope) — the
// 30/90/All toggle is gone. Field shape also changed: legacy
// `{name, totalRevenue, totalDays, avgValue}` → `{itemName, net30dGbp,
// rentalCount, utilizationPct}`. Numbers reflect NET take-home (post-fee).
export function ItemRevenuePanel() {
  const { activeAccountSlug } = useAccount();
  const [showAll, setShowAll] = useState(false);

  const data = useQuery(api.mv.top_earners.getRanking, {
    account: activeAccountSlug ?? undefined,
    limit: 20,
  });

  const visible = data ? (showAll ? data : data.slice(0, 10)) : [];
  const maxRev =
    data && data.length > 0
      ? Math.max(...data.map((r) => r.net30dGbp), 1)
      : 1;

  return (
    <Card>
      <CardHeader title="Top items — net earnings (30d)" />
      <div className="text-xs text-[#8b8fa3] -mt-3 mb-3">
        Cached hourly · post-fee take-home
      </div>

      {data === undefined ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <SkeletonBlock key={i} className="h-10 w-full" />)}
        </div>
      ) : data.length === 0 ? (
        <EmptyState message="No cached ranking yet — refreshes hourly via master.refreshFast" />
      ) : (
        <>
          <div className="space-y-2">
            {visible.map((item, i) => {
              const barPct = Math.max(2, (item.net30dGbp / maxRev) * 100);
              return (
                <div key={item.itemName} className="group">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-xs text-[#8b8fa3] text-right flex-shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between mb-0.5">
                        <span className="text-sm text-[#e4e6eb] truncate">{item.itemName}</span>
                        <span className="text-sm font-semibold flex-shrink-0 ml-2" style={{ color: "#22c55e" }}>
                          £{item.net30dGbp.toFixed(2)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${barPct}%`, background: "#6ea8fe" }}
                        />
                      </div>
                      <div className="text-xs text-[#8b8fa3] mt-0.5">
                        {item.rentalCount} rentals · {item.utilizationPct.toFixed(0)}% util (7d)
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {data.length > 10 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="mt-3 text-xs text-[#6ea8fe] hover:text-[#e4e6eb] transition-colors"
            >
              {showAll ? "Show less" : `Show all ${data.length} items`}
            </button>
          )}
        </>
      )}
    </Card>
  );
}
