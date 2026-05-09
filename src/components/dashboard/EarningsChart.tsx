"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { useState } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  Tooltip,
} from "recharts";
import type { ValueType, NameType } from "recharts/types/component/DefaultTooltipContent";

type Granularity = "monthly" | "weekly";
type Period = 3 | 6 | 12;

function fmtCurrency(v: number) {
  if (v >= 1000) return `£${(v / 1000).toFixed(1)}k`;
  return `£${v.toFixed(0)}`;
}

function shortLabel(period: string, granularity: Granularity): string {
  if (granularity === "monthly") {
    const [, m] = period.split("-");
    return new Date(2000, parseInt(m) - 1).toLocaleString("en", { month: "short" });
  }
  const [yearStr, weekPart] = period.split("-");
  const week = parseInt(weekPart.replace("W", ""));
  const year = parseInt(yearStr);
  const jan1 = new Date(year, 0, 1);
  const dayOfYear = (week - 1) * 7 - jan1.getDay() + 1;
  const d = new Date(year, 0, 1 + dayOfYear);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function tooltipFmt(value: ValueType | undefined, name: NameType | undefined): [string, string] {
  const v = typeof value === "number" ? value : 0;
  if (name === "revenue") return [`£${v.toFixed(2)}`, "Earnings"];
  return [`${v}`, "Bookings"];
}

export function EarningsChart() {
  const { activeAccountSlug } = useAccount();
  const [granularity, setGranularity] = useState<Granularity>("monthly");
  const [months, setMonths] = useState<Period>(12);
  const periods: Period[] = [3, 6, 12];

  const raw = useQuery(api.revenue.getEarningsByPeriod, {
    accountSlug: activeAccountSlug,
    granularity,
    months,
  });

  const data = raw?.map((d) => ({
    ...d,
    label: shortLabel(d.period, granularity),
  }));

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
        <SkeletonBlock className="h-[280px] w-full" />
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-[280px] text-sm text-[#8b8fa3]">
          No earnings data
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              vertical={false}
              stroke="rgba(255,255,255,0.06)"
              strokeDasharray="0"
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "#8b8fa3", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              yAxisId="left"
              orientation="left"
              tickFormatter={fmtCurrency}
              tick={{ fill: "#8b8fa3", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              allowDecimals={false}
              tick={{ fill: "#8b8fa3", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={28}
            />
            <Tooltip
              contentStyle={{
                background: "rgba(14,17,28,0.95)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 6,
                fontSize: 12,
              }}
              labelStyle={{ color: "#e4e6eb" }}
              formatter={tooltipFmt}
            />
            <Legend
              verticalAlign="top"
              align="center"
              wrapperStyle={{ fontSize: 12, color: "#9ca3af", paddingBottom: 8 }}
              formatter={(value: string) =>
                value === "revenue" ? "Earnings" : "Bookings"
              }
            />
            <Bar
              yAxisId="left"
              dataKey="revenue"
              name="revenue"
              fill="rgba(34,197,94,0.4)"
              stroke="#22c55e"
              strokeWidth={1}
              radius={[2, 2, 0, 0]}
              maxBarSize={48}
            />
            <Line
              yAxisId="right"
              dataKey="bookings"
              name="bookings"
              type="monotone"
              stroke="#a78bfa"
              strokeWidth={2}
              dot={{ fill: "#a78bfa", r: 4, strokeWidth: 0 }}
              activeDot={{ r: 6 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
