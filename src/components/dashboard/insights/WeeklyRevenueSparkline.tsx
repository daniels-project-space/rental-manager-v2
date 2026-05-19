"use client";
import { useQuery } from "convex/react";
import { ResponsiveContainer, LineChart, Line, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../../../../convex/_generated/api";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";
import { EmptyState } from "@/components/ui/EmptyState";

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + Math.round(n).toString();
}

export function WeeklyRevenueSparkline({ accountSlug }: { accountSlug: string | null }) {
  const data = useQuery(api.dashboard_insights.getWeeklyRevenueSparkline, {
    accountSlug,
    weeks: 8,
  });

  const series = data ?? [];
  const latest = series.length > 0 ? series[series.length - 1].revenue_attributed_gbp : 0;
  const prior = series.length > 1 ? series[series.length - 2].revenue_attributed_gbp : 0;
  const delta = latest - prior;
  const deltaPct = prior > 0 ? (delta / prior) * 100 : 0;

  return (
    <div
      className="stat-card"
      style={{
        background: "rgba(14,17,28,0.35)",
        backdropFilter: "blur(24px) saturate(1.5)",
        borderRadius: 16,
        padding: 14,
        borderLeft: "3px solid #22c55e",
        minHeight: 150,
      }}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Revenue Trend
          </div>
          <div className="text-[10px] text-slate-500">Last 8 weeks · attributed £</div>
        </div>
        {series.length >= 2 && (
          <div className="text-right">
            <div className="text-[14px] font-semibold text-emerald-300 tabular-nums">
              {fmtGbp(latest)}
            </div>
            <div
              className={`text-[10px] tabular-nums ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}
            >
              {delta >= 0 ? "+" : ""}
              {deltaPct.toFixed(0)}% WoW
            </div>
          </div>
        )}
      </div>
      {data === undefined ? (
        <SkeletonBlock className="h-24 w-full" />
      ) : series.length === 0 ? (
        <EmptyState message="No data" />
      ) : (
        <div style={{ width: "100%", height: 90 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 5, right: 4, left: 4, bottom: 0 }}>
              <XAxis dataKey="week_start" hide />
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Tooltip
                contentStyle={{
                  background: "rgba(14,17,28,0.95)",
                  border: "1px solid rgba(148,163,184,0.2)",
                  borderRadius: 8,
                  fontSize: 11,
                  color: "#e4e6eb",
                }}
                labelFormatter={(label) => `Week of ${label}`}
                formatter={(value) => [fmtGbp(Number(value)), "Attributed"] as [string, string]}
              />
              <Line
                type="monotone"
                dataKey="revenue_attributed_gbp"
                stroke="#22c55e"
                strokeWidth={2}
                dot={{ r: 2, fill: "#22c55e" }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default WeeklyRevenueSparkline;
