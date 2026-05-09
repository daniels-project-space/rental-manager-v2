"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
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

function fmtK(v: number) {
  if (v >= 1000) return `£${(v / 1000).toFixed(0)}k`;
  return `£${v.toFixed(0)}`;
}

function fmtMonthLabel(yyyyMM: string): string {
  const [y, m] = yyyyMM.split("-");
  const d = new Date(parseInt(y), parseInt(m) - 1, 1);
  return d.toLocaleString("en", { month: "short", year: "2-digit" });
}

const SERIES_LABELS: Record<string, string> = {
  dbcinema: "DB Cinema",
  leo: "Leo Adams",
  cumulative: "Cumulative",
};

function tooltipFmt(value: ValueType | undefined, name: NameType | undefined): [string, string] {
  const v = typeof value === "number" ? value : 0;
  return [`£${v.toFixed(2)}`, SERIES_LABELS[String(name)] ?? String(name)];
}

export function LifetimeRevenue() {
  const { activeAccountSlug } = useAccount();

  const summary = useQuery(api.dashboard.getLifetimeSummary, {
    accountSlug: activeAccountSlug,
  });

  const raw = useQuery(api.revenue.getLifetimeByMonth, {
    accountSlug: activeAccountSlug,
  });

  const data = raw?.map((d, i) => ({
    ...d,
    label: i % 3 === 0 ? fmtMonthLabel(d.month) : "",
  }));

  return (
    <Card className="relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at top left, rgba(34,197,94,0.08) 0%, transparent 60%)",
        }}
      />
      <CardHeader title="Lifetime Revenue" />

      {summary !== undefined && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="p-2.5 rounded-lg" style={{background:"rgba(255,255,255,0.04)"}}>
            <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Total Revenue</div>
            <div className="text-lg font-bold text-[#22c55e]">£{summary.totalRevenue.toFixed(0)}</div>
          </div>
          <div className="p-2.5 rounded-lg" style={{background:"rgba(255,255,255,0.04)"}}>
            <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Bookings</div>
            <div className="text-lg font-bold text-[#6ea8fe]">{summary.totalBookings}</div>
          </div>
          <div className="p-2.5 rounded-lg" style={{background:"rgba(255,255,255,0.04)"}}>
            <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Avg Value</div>
            <div className="text-lg font-bold text-[#e4e6eb]">£{summary.avgValue.toFixed(2)}</div>
          </div>
          <div className="p-2.5 rounded-lg" style={{background:"rgba(255,255,255,0.04)"}}>
            <div className="text-xs text-[#8b8fa3] uppercase tracking-wider">Total Days</div>
            <div className="text-lg font-bold text-[#e4e6eb]">{summary.totalDays}</div>
          </div>
        </div>
      )}

      {data === undefined ? (
        <SkeletonBlock className="h-[280px] w-full" />
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-[280px] text-sm text-[#8b8fa3]">
          No revenue data
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
              tick={{ fill: "#8b8fa3", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={0}
            />
            <YAxis
              yAxisId="left"
              orientation="left"
              tickFormatter={fmtK}
              tick={{ fill: "#22c55e", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
              label={{
                value: "Cumulative",
                angle: -90,
                position: "insideLeft",
                offset: 10,
                style: { fill: "#22c55e", fontSize: 10 },
              }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={fmtK}
              tick={{ fill: "#6ea8fe", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={44}
              label={{
                value: "Monthly",
                angle: 90,
                position: "insideRight",
                offset: 10,
                style: { fill: "#6ea8fe", fontSize: 10 },
              }}
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
              formatter={(value: string) => SERIES_LABELS[value] ?? value}
            />
            <Bar
              yAxisId="right"
              dataKey="dbcinema"
              name="dbcinema"
              stackId="monthly"
              fill="rgba(139,109,255,0.7)"
              stroke="#8b6dff"
              strokeWidth={0}
              maxBarSize={24}
            />
            <Bar
              yAxisId="right"
              dataKey="leo"
              name="leo"
              stackId="monthly"
              fill="rgba(239,68,68,0.7)"
              stroke="#ef4444"
              strokeWidth={0}
              radius={[2, 2, 0, 0]}
              maxBarSize={24}
            />
            <Line
              yAxisId="left"
              dataKey="cumulative"
              name="cumulative"
              type="monotone"
              stroke="#22c55e"
              strokeWidth={3}
              dot={false}
              activeDot={{ r: 5, fill: "#22c55e" }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
