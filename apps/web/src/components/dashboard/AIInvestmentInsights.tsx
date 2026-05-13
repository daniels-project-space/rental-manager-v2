"use client";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { Card, CardHeader } from "@/components/ui/Card";
import { SkeletonBlock } from "@/components/ui/SkeletonBlock";

const KIND_COLORS: Record<string, string> = {
  revenue_trend: "#22c55e",
  idle_items: "#f59e0b",
  top_performers: "#6ea8fe",
  under_utilised: "#ef4444",
  booking_stats: "#a78bfa",
  no_data: "#8b8fa3",
};

export function AIInvestmentInsights() {
  const { activeAccountSlug } = useAccount();
  const insights = useQuery(api.ai_insights.getInsights, {
    accountSlug: activeAccountSlug,
  });

  const loading = insights === undefined;

  return (
    <Card>
      <CardHeader
        title="AI Investment Insights"
        badge={
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: "rgba(167,139,250,0.12)", color: "#a78bfa" }}
          >
            Live
          </span>
        }
      />

      {loading ? (
        <div className="space-y-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex gap-3">
              <div
                className="w-1 rounded-full flex-shrink-0 skeleton"
                style={{ minHeight: 48 }}
              />
              <div className="flex-1 space-y-2">
                <SkeletonBlock className="h-3 w-2/3 rounded" />
                <SkeletonBlock className="h-3 w-full rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {insights.map((insight, i) => {
              const accentColor =
                KIND_COLORS[insight.kind] ?? "#a78bfa";
              return (
                <div key={i} className="flex gap-3">
                  <div
                    className="w-1 rounded-full flex-shrink-0"
                    style={{ background: accentColor, minHeight: 48 }}
                  />
                  <div>
                    <p
                      className="text-sm font-semibold leading-snug"
                      style={{ color: "#e4e6eb" }}
                    >
                      {insight.headline}
                    </p>
                    <p
                      className="text-xs mt-1 leading-relaxed"
                      style={{ color: "#8b8fa3" }}
                    >
                      {insight.body}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <p
            className="text-xs mt-4 pt-3"
            style={{
              color: "rgba(139,143,163,0.5)",
              borderTop: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            Computed from live data · Updates on each page load
          </p>
        </>
      )}
    </Card>
  );
}
