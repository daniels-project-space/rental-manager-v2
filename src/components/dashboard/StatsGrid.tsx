"use client";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { MetricTile } from "@/components/ui/MetricTile";
import { SkeletonCard } from "@/components/ui/SkeletonBlock";

function fmt(n: number, prefix = "") {
  if (n >= 1000) return `${prefix}${(n / 1000).toFixed(1)}k`;
  return `${prefix}${n % 1 === 0 ? n : n.toFixed(2)}`;
}

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export function StatsGrid() {
  const { activeAccountSlug } = useAccount();
  const data = useQuery(api.dashboard.getSummary, { accountSlug: activeAccountSlug });
  const settings = useQuery(api.settings.get);

  if (data === undefined) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonCard key={i} rows={1} />
        ))}
      </div>
    );
  }

  const hyggloColor = settings?.ALLOW_HYGGLO_SEND ? "#22c55e" : "#f59e0b";
  const hyggloLabel = settings?.ALLOW_HYGGLO_SEND ? "ON" : "OFF";

  const tiles = [
    {
      key: "active-rentals",
      label: "Active Rentals",
      value: data.activeRentalsCount,
      color: "#22c55e",
    },
    {
      key: "monthly-revenue",
      label: "This Month",
      value: `£${fmt(data.monthlyRevenue)}`,
      color: "#22c55e",
    },
    {
      key: "pending-returns",
      label: "Due Back Today",
      value: data.pendingReturns,
      color: "#f59e0b",
    },
    {
      key: "overdue-count",
      label: "Overdue",
      value: data.overdueCount,
      color: data.overdueCount > 0 ? "#ef4444" : "#22c55e",
    },
    {
      key: "items-out",
      label: "Items Out",
      value: data.itemsOut,
      color: "#6ea8fe",
    },
    {
      key: "available-items",
      label: "Available",
      value: data.availableItems,
      color: "#22c55e",
    },
    {
      key: "weekly-revenue",
      label: "This Week",
      value: `£${fmt(data.weeklyRevenue)}`,
      color: "#6ea8fe",
    },
    {
      key: "monthly-bookings",
      label: "Bookings (Month)",
      value: data.monthlyBookings,
      color: "#a78bfa",
    },
    {
      key: "avg-rental-value",
      label: "Avg Rental Value",
      value: `£${fmt(data.avgRentalValue)}`,
      color: "#f59e0b",
    },
    {
      key: "denial-rate",
      label: "Denial Rate",
      value: pct(data.denialRate),
      color: data.denialRate > 0.1 ? "#ef4444" : "#8b8fa3",
    },
    {
      key: "hygglo-sync",
      label: "Hygglo Sync",
      value: hyggloLabel,
      color: hyggloColor,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {tiles.map((t) => (
        <MetricTile
          key={t.key}
          label={t.label}
          value={t.value}
          color={t.color}
        />
      ))}
    </div>
  );
}
