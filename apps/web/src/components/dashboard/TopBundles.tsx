"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Days = 30 | 90 | 365;

export function TopBundles() {
  const { activeAccountSlug } = useAccount();
  const [days, setDays] = useState<Days>(90);

  const data = useQuery(api.bundles.getBundleRevenueRanking, {
    accountSlug: activeAccountSlug,
    days,
  });

  const dayOpts: { label: string; val: Days }[] = [
    { label: "30d", val: 30 },
    { label: "90d", val: 90 },
    { label: "1yr", val: 365 },
  ];

  const maxRev = data && data.length > 0 ? data[0]!.totalRevenue : 1;

  return (
    <Card>
      <CardHeader
        title="Top Bundles"
        badge={
          data !== undefined ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(167,139,250,0.15)", color: "#a78bfa" }}
            >
              {data.length}
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
                  background: days === d.val ? "rgba(167,139,250,0.2)" : "transparent",
                  color: days === d.val ? "#a78bfa" : "#8b8fa3",
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
          {[...Array(4)].map((_, i) => (
            <SkeletonBlock key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      )}

      {data !== undefined && data.length === 0 && (
        <EmptyState message="No bundle revenue data for this period" icon="📦" />
      )}

      {data !== undefined && data.length > 0 && (
        <div className="space-y-2">
          {/* SVG bar chart */}
          <svg width="100%" height={Math.min(data.length * 36, 180)} className="overflow-visible">
            {data.slice(0, 5).map((bundle, i) => {
              const barW = maxRev > 0 ? (bundle!.totalRevenue / maxRev) * 100 : 0;
              const y = i * 36;
              return (
                <g key={bundle!.name} transform={`translate(0,${y})`}>
                  <rect
                    x={0}
                    y={4}
                    width="100%"
                    height={24}
                    rx={6}
                    fill="rgba(167,139,250,0.07)"
                  />
                  <rect
                    x={0}
                    y={4}
                    width={`${barW}%`}
                    height={24}
                    rx={6}
                    fill="rgba(167,139,250,0.35)"
                  />
                  <text x={8} y={20} fontSize={11} fill="#e4e6eb" dominantBaseline="middle">
                    {bundle!.name}
                  </text>
                  <text
                    x="100%"
                    y={20}
                    fontSize={11}
                    fill="#a78bfa"
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    £{bundle!.totalRevenue.toFixed(0)}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Detail rows */}
          <div className="mt-2 space-y-1">
            {data.slice(0, 5).map((bundle, i) => (
              <div
                key={bundle!.name}
                className="flex items-center justify-between py-2 px-3 rounded-lg"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: "rgba(167,139,250,0.2)", color: "#a78bfa" }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "#e4e6eb" }}>
                      {bundle!.name}
                    </p>
                    <p className="text-xs truncate" style={{ color: "#8b8fa3" }}>
                      {bundle!.items.slice(0, 3).join(", ")}
                      {bundle!.items.length > 3 ? ` +${bundle!.items.length - 3}` : ""}
                    </p>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-3">
                  <p className="text-sm font-bold" style={{ color: "#a78bfa" }}>
                    £{bundle!.totalRevenue.toFixed(0)}
                  </p>
                  <p className="text-xs" style={{ color: "#8b8fa3" }}>
                    {bundle!.rentalCount} rental{bundle!.rentalCount !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
