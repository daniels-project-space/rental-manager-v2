"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 30 | 90 | 0;

export function ItemRevenuePanel() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(30);
  const [showAll, setShowAll] = useState(false);

  const data = useQuery(api.items.getItemRevenueRanking, {
    accountSlug: activeAccountSlug,
    days: days === 0 ? 3650 : days,
  });

  const dayOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 },
    { label: "90d", val: 90 },
    { label: "All", val: 0 },
  ];

  const visible = data ? (showAll ? data : data.slice(0, 10)) : [];
  const maxRev = data && data.length > 0 ? data[0].totalRevenue : 1;

  return (
    <Card>
      <CardHeader
        title="Item Revenue"
        actions={
          <div className="flex gap-1">
            {dayOpts.map((d) => (
              <button
                key={d.val}
                onClick={() => setDays(d.val)}
                className="px-2 py-0.5 text-xs rounded transition-colors"
                style={{
                  background: days === d.val ? "rgba(110,168,254,0.15)" : "transparent",
                  color: days === d.val ? "#6ea8fe" : "#8b8fa3",
                  border: days === d.val ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {data === undefined ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => <SkeletonBlock key={i} className="h-10 w-full" />)}
        </div>
      ) : data.length === 0 ? (
        <EmptyState message="No revenue data for this period" />
      ) : (
        <>
          <div className="space-y-2">
            {visible.map((item, i) => {
              const barPct = Math.max(2, (item.totalRevenue / maxRev) * 100);
              return (
                <div key={item.name} className="group">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-xs text-[#8b8fa3] text-right flex-shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between mb-0.5">
                        <span className="text-sm text-[#e4e6eb] truncate">{item.name}</span>
                        <span className="text-sm font-semibold flex-shrink-0 ml-2" style={{ color: "#22c55e" }}>
                          £{item.totalRevenue.toFixed(2)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)" }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${barPct}%`, background: "#6ea8fe" }}
                        />
                      </div>
                      <div className="text-xs text-[#8b8fa3] mt-0.5">
                        {item.rentalCount} rentals · avg £{item.avgValue.toFixed(2)} · {item.totalDays}d
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
