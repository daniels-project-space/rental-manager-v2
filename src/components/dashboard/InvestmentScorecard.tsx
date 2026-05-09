"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

function Metric({
  label,
  value,
  color = "#e4e6eb",
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div
      className="p-3 rounded-xl flex flex-col gap-0.5"
      style={{ background: "rgba(255,255,255,0.04)" }}
    >
      <span className="text-xs uppercase tracking-wider" style={{ color: "#8b8fa3" }}>
        {label}
      </span>
      <span className="text-xl font-bold" style={{ color }}>
        {value}
      </span>
      {sub && <span className="text-xs" style={{ color: "#8b8fa3" }}>{sub}</span>}
    </div>
  );
}

export function InvestmentScorecard() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.revenue.getInvestmentScorecard, {
    accountSlug: activeAccountSlug,
  });

  const roiColor =
    data === undefined
      ? "#e4e6eb"
      : data.roiPct >= 0
      ? "#22c55e"
      : "#ef4444";

  return (
    <Card>
      <CardHeader title="Investment Scorecard" />

      {data === undefined && (
        <div className="grid grid-cols-2 gap-3">
          {[...Array(6)].map((_, i) => (
            <SkeletonBlock key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      )}

      {data !== undefined && (
        <div className="space-y-4">
          {/* Hero ROI */}
          <div
            className="p-4 rounded-xl text-center"
            style={{ background: `rgba(${data.roiPct >= 0 ? "34,197,94" : "239,68,68"},0.08)` }}
          >
            <p className="text-xs uppercase tracking-wider mb-1" style={{ color: "#8b8fa3" }}>
              Return on Investment
            </p>
            <p className="text-4xl font-bold" style={{ color: roiColor }}>
              {data.roiPct > 0 ? "+" : ""}
              {data.roiPct.toFixed(1)}%
            </p>
          </div>

          {/* 2×3 metrics grid */}
          <div className="grid grid-cols-2 gap-3">
            <Metric
              label="Total Invested"
              value={`£${data.totalInvested.toFixed(0)}`}
              color="#6ea8fe"
            />
            <Metric
              label="Total Revenue"
              value={`£${data.totalRevenue.toFixed(0)}`}
              color="#22c55e"
            />
            <Metric
              label="Net Profit"
              value={`${data.netProfit >= 0 ? "+" : ""}£${data.netProfit.toFixed(0)}`}
              color={data.netProfit >= 0 ? "#22c55e" : "#ef4444"}
            />
            <Metric
              label="Monthly Rate"
              value={`£${data.monthlyRate.toFixed(0)}/mo`}
              color="#a78bfa"
            />
            <Metric
              label="Payback Period"
              value={
                data.paybackMonths === null
                  ? "N/A"
                  : data.paybackMonths < 1000
                  ? `${data.paybackMonths.toFixed(1)} mo`
                  : "∞"
              }
              color="#f59e0b"
            />
            <Metric
              label="ROI Status"
              value={data.roiPct >= 100 ? "Recovered" : data.roiPct >= 0 ? "In profit" : "Negative"}
              color={roiColor}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
