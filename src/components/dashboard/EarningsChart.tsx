"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";

type Granularity = "monthly" | "weekly";
type Period = 3 | 6 | 12;

function shortLabel(period: string, granularity: Granularity) {
  if (granularity === "monthly") {
    // YYYY-MM → "Jan"
    const [, m] = period.split("-");
    return new Date(2000, parseInt(m) - 1).toLocaleString("en", { month: "short" });
  }
  // YYYY-Wnn → "W12"
  return period.split("-")[1] ?? period;
}

export function EarningsChart() {
  const { activeAccountSlug } = useAccount();
  const [granularity, setGranularity] = useState<Granularity>("monthly");
  const [months, setMonths] = useState<Period>(12);

  const data = useQuery(api.revenue.getEarningsByPeriod, {
    accountSlug: activeAccountSlug,
    granularity,
    months,
  });

  const periods = [3, 6, 12] as Period[];
  const CHART_H = 120;
  const BAR_COLOR = "#22c55e";
  const BAR_MUTED = "rgba(34,197,94,0.2)";

  return (
    <Card>
      <CardHeader
        title="Earnings"
        actions={
          <div className="flex items-center gap-1">
            {periods.map((p) => (
              <button
                key={p}
                onClick={() => setMonths(p)}
                className="px-2 py-0.5 text-xs rounded transition-colors"
                style={{
                  background: months === p ? "rgba(110,168,254,0.15)" : "transparent",
                  color: months === p ? "#6ea8fe" : "#8b8fa3",
                  border: months === p ? "1px solid rgba(110,168,254,0.3)" : "1px solid transparent",
                }}
              >
                {p}M
              </button>
            ))}
          </div>
        }
      />

      <div className="flex gap-2 mb-4">
        {(["monthly", "weekly"] as Granularity[]).map((g) => (
          <button
            key={g}
            onClick={() => setGranularity(g)}
            className="text-xs px-3 py-1 rounded-full transition-colors capitalize"
            style={{
              background: granularity === g ? "rgba(34,197,94,0.15)" : "transparent",
              color: granularity === g ? "#22c55e" : "#8b8fa3",
              border: granularity === g ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {g}
          </button>
        ))}
      </div>

      {data === undefined ? (
        <SkeletonBlock className="h-32 w-full" />
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-sm text-[#8b8fa3]">
          No earnings data
        </div>
      ) : (
        <BarChart data={data} height={CHART_H} barColor={BAR_COLOR} mutedColor={BAR_MUTED} granularity={granularity} />
      )}
    </Card>
  );
}

function BarChart({
  data,
  height,
  barColor,
  mutedColor,
  granularity,
}: {
  data: { period: string; revenue: number; bookings: number }[];
  height: number;
  barColor: string;
  mutedColor: string;
  granularity: Granularity;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const maxRev = Math.max(...data.map((d) => d.revenue), 1);
  const padX = 4;
  const totalW = 600;
  const barW = Math.max(4, (totalW - padX * (data.length + 1)) / data.length);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${totalW} ${height + 24}`}
        className="w-full"
        style={{ height: height + 24 }}
      >
        {data.map((d, i) => {
          const barH = Math.max(2, (d.revenue / maxRev) * height);
          const x = padX + i * (barW + padX);
          const y = height - barH;
          const isHov = hovered === i;
          return (
            <g key={d.period}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                fill={isHov ? barColor : mutedColor}
                rx={2}
                style={{ transition: "fill 0.15s" }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
              {/* Label */}
              <text
                x={x + barW / 2}
                y={height + 16}
                textAnchor="middle"
                fontSize="9"
                fill="#8b8fa3"
              >
                {shortLabel(d.period, granularity)}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {hovered !== null && data[hovered] && (
        <div
          className="absolute pointer-events-none px-2 py-1 rounded text-xs"
          style={{
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(14,17,28,0.95)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e4e6eb",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: "#22c55e" }}>
            £{data[hovered].revenue.toFixed(2)}
          </span>
          {" · "}
          {data[hovered].bookings} bookings
        </div>
      )}
    </div>
  );
}
