"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { MetricTile } from "@/components/ui/MetricTile";
import { SkeletonCard } from "@/components/ui/SkeletonBlock";

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + n.toFixed(0);
}

function pct(n: number) {
  return (n * 100).toFixed(1) + "%";
}

/**
 * W02 Stats Grid — mirrors v1's 17 stat tiles.
 * Tile order matches v1 dashboard.html data-stat order.
 */
export function StatsGrid() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.dashboard.getSummary, { accountSlug: activeAccountSlug });
  const settings = useQuery(api.settings.get);

  if (data === undefined) {
    return (
      <div className="stats-grid-mobile grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 gap-2.5">
        {Array.from({ length: 17 }).map((_, i) => (
          <SkeletonCard key={i} rows={1} />
        ))}
      </div>
    );
  }

  const hyggloColor = settings?.ALLOW_HYGGLO_SEND ? "#22c55e" : "#f59e0b";
  const hyggloLabel = settings?.ALLOW_HYGGLO_SEND ? "ON" : "OFF";

  const activeSubtext = `${data.ongoingCount} ongoing · ${data.upcomingCount} upcoming`;
  const earningsSubtext = `${data.todayRentalCount} today · Week: ${fmtGbp(data.weeklyRevenue)}`;
  const projectedSubtext = `£${Math.round(data.dailyAvgRevenue)}/day avg · ${data.daysRemaining} days left`;
  const monthConfirmedSubtext = `${data.monthlyBookings} rentals`;
  const deniedSubtext = `${data.deniedCount} denials (90d)`;
  const aiSubtext = `${Math.round((data.boostRate ?? 0) * 100)}% boost rate`;
  const outOfStockSubtext = `next 14 days`;
  const sellRecoSubtext = `${fmtGbp(data.totalAcquisitionCost)} invested`;

  const tiles = [
    // 1. Active Rentals (hero)
    {
      key: "active",
      label: "Active Rentals",
      value: data.activeRentalsCount,
      sub: activeSubtext,
      color: "#6ea8fe",
    },
    // 2. Earnings (today + week)
    {
      key: "earnings",
      label: "Earnings",
      value: fmtGbp(data.todayRevenue),
      sub: earningsSubtext,
      color: "#22c55e",
    },
    // 3. Expected Monthly (projection)
    {
      key: "monthly",
      label: "Expected Monthly",
      value: fmtGbp(data.projectedMonthRevenue),
      sub: projectedSubtext,
      color: "#22c55e",
    },
    // 4. Month Confirmed (actual earned this month)
    {
      key: "confirmed",
      label: "Month Confirmed",
      value: fmtGbp(data.monthlyRevenue),
      sub: monthConfirmedSubtext,
      color: "#22c55e",
    },
    // 5. Ongoing
    {
      key: "ongoing",
      label: "Ongoing",
      value: data.ongoingCount,
      sub: "",
      color: "#f59e0b",
    },
    // 6. Upcoming
    {
      key: "upcoming",
      label: "Upcoming",
      value: data.upcomingCount,
      sub: "",
      color: "#a78bfa",
    },
    // 7. Scanner (read from settings)
    {
      key: "scanner",
      label: "Scanner",
      value: settings?.ALLOW_HYGGLO_SEND ? "Active" : "Idle",
      sub: hyggloLabel + " · read-only",
      color: "#6ea8fe",
    },
    // 8. Denied Revenue (3-month window)
    {
      key: "denied-revenue",
      label: "Denied Revenue",
      value: fmtGbp(data.deniedRevenue),
      sub: deniedSubtext,
      color: data.deniedRevenue > 0 ? "#f59e0b" : "#8b8fa3",
    },
    // 9. Missed Revenue (placeholder — shown in W14 panel)
    {
      key: "missed-revenue",
      label: "Missed Revenue",
      value: "—",
      sub: "See W14 panel",
      color: "#ef4444",
    },
    // 10. AI Boost (monthly)
    {
      key: "ai-boost",
      label: "AI Boost",
      value: fmtGbp(data.aiBoostAmount),
      sub: aiSubtext,
      color: "#22c55e",
    },
    // 11. Out of Stock
    {
      key: "out-of-stock",
      label: "Out of Stock",
      value: data.outOfStockCount,
      sub: outOfStockSubtext,
      color: data.outOfStockCount > 0 ? "#ef4444" : "#22c55e",
    },
    // 12. Vacation Mode (placeholder — no VPS vacation data in v2 yet)
    {
      key: "vacation",
      label: "Vacation Mode",
      value: "Off",
      sub: "",
      color: "#22c55e",
    },
    // 13. Sell Recommender (links to W16 panel)
    {
      key: "sell-reco",
      label: "Sell Recommender",
      value: "—",
      sub: sellRecoSubtext,
      color: "#f59e0b",
    },
    // 14. Inventory Worth (acquisition cost as proxy)
    {
      key: "inventory-worth",
      label: "Inventory Worth",
      value: data.totalAcquisitionCost > 0 ? fmtGbp(data.totalAcquisitionCost) : "—",
      sub: "acquisition cost",
      color: "#3b82f6",
    },
    // 15. UK Tax (OPEN_QUESTION: no tax service in v2 yet)
    {
      key: "tax",
      label: "UK Tax",
      value: "—",
      sub: "—",
      color: "#ef4444",
    },
    // 16. Hygglo Sync
    {
      key: "hygglo-sync",
      label: "Hygglo Sync",
      value: hyggloLabel,
      sub: "",
      color: hyggloColor,
    },
    // 17. Denial Rate
    {
      key: "denial-rate",
      label: "Denial Rate",
      value: pct(data.denialRate),
      sub: "",
      color: data.denialRate > 0.1 ? "#ef4444" : "#8b8fa3",
    },
  ];

  return (
    <div className="stats-grid-mobile grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 gap-2.5">
      {tiles.map((t, i) => {
        const delayClass = i <= 5 ? `anim-delay-${i}` : "anim-delay-5";
        return (
          <div key={t.key} className={"anim-fade-up " + delayClass}>
            <MetricTile
              label={t.label}
              value={t.value}
              sub={t.sub || undefined}
              color={t.color}
            />
          </div>
        );
      })}
    </div>
  );
}
