"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import ExpandableStatCard from "./ExpandableStatCard";
// Wave 1 Task 4 drawer bodies — imported as-is; if parallel agent hasn't landed
// these yet the typecheck will show missing-module errors (Wave 2 reconcile).
import ActiveDrawer from "./stat-cards/ActiveDrawer";
import EarningsDrawer from "./stat-cards/EarningsDrawer";
import MonthlyDrawer from "./stat-cards/MonthlyDrawer";
import ConfirmedDrawer from "./stat-cards/ConfirmedDrawer";
import OngoingDrawer from "./stat-cards/OngoingDrawer";
import UpcomingDrawer from "./stat-cards/UpcomingDrawer";
import ScannerDrawer from "./stat-cards/ScannerDrawer";
import DeniedRevenueDrawer from "./stat-cards/DeniedRevenueDrawer";
import MissedRevenueDrawer from "./stat-cards/MissedRevenueDrawer";
import AiBoostDrawer from "./stat-cards/AiBoostDrawer";
import OutOfStockDrawer from "./stat-cards/OutOfStockDrawer";
import VacationDrawer from "./stat-cards/VacationDrawer";
import SellRecoDrawer from "./stat-cards/SellRecoDrawer";
import InventoryWorthDrawer from "./stat-cards/InventoryWorthDrawer";
import TaxDrawer from "./stat-cards/TaxDrawer";
import BusinessIntelDrawer from "./stat-cards/BusinessIntelDrawer";

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + n.toFixed(0);
}

function StatsGridSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2.5 mt-4">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="h-20 rounded-2xl bg-slate-900/40 animate-pulse" />
      ))}
    </div>
  );
}

/**
 * Wave 1 Stats Grid — accordion owner for 16 ExpandableStatCards.
 * Single card expanded at a time. Layout mirrors v1 6-col grid.
 *
 * Row 1: [active 2×1]  [earnings] [monthly] [confirmed]  [scanner]
 * Row 2: [ongoing 2×1] [upcoming 2×1]        [ai_boost]  [out_of_stock]
 * Row 3: [denied] [missed] [vacation] [sell_reco] [inventory_worth] [tax]
 * Row 4: [business_intel 2×1]
 */
export function StatsGrid() {
  const { activeAccountSlug } = useAccount();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const data = useQuery(api.dashboard.getStatsDrawerData, {
    accountSlug: activeAccountSlug,
  });

  if (!data) return <StatsGridSkeleton />;

  const toggle = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id));

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2.5 mt-4">
      {/* ── Row 1 ─────────────────────────────────────────────── */}

      {/* active — 2×1 hero */}
      <ExpandableStatCard
        id="active"
        label="Active Rentals"
        value={data.active.total}
        valueColor="green"
        hero
        isExpanded={expandedId === "active"}
        onToggle={() => toggle("active")}
        subtitle={`${data.ongoing.count} ongoing · ${data.upcoming.count} upcoming`}
      >
        <ActiveDrawer data={data.active as any} />
      </ExpandableStatCard>

      {/* earnings */}
      <ExpandableStatCard
        id="earnings"
        label="Earnings"
        value={fmtGbp(data.earnings.today)}
        valueColor="green"
        subtitle={`Week: ${fmtGbp(data.earnings.week)}`}
        isExpanded={expandedId === "earnings"}
        onToggle={() => toggle("earnings")}
      >
        <EarningsDrawer data={data.earnings} />
      </ExpandableStatCard>

      {/* monthly */}
      <ExpandableStatCard
        id="monthly"
        label="Expected Monthly"
        value={fmtGbp(data.monthly.projected)}
        valueColor="green"
        subtitle={`£${Math.round(data.monthly.avg_daily_rate)}/day · ${data.monthly.days_remaining}d left`}
        isExpanded={expandedId === "monthly"}
        onToggle={() => toggle("monthly")}
      >
        <MonthlyDrawer data={data.monthly} />
      </ExpandableStatCard>

      {/* confirmed */}
      <ExpandableStatCard
        id="confirmed"
        label="Month Confirmed"
        value={data.confirmed.month_count}
        valueColor="green"
        subtitle="rentals this month"
        isExpanded={expandedId === "confirmed"}
        onToggle={() => toggle("confirmed")}
      >
        <ConfirmedDrawer data={data.confirmed as any} />
      </ExpandableStatCard>

      {/* scanner */}
      <ExpandableStatCard
        id="scanner"
        label="Scanner"
        value={data.scanner.last_run_succeeded ? "Active" : "Idle"}
        valueColor="blue"
        subtitle={
          data.scanner.last_scan_at
            ? `Last: ${new Date(data.scanner.last_scan_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
            : "No scan yet"
        }
        isExpanded={expandedId === "scanner"}
        onToggle={() => toggle("scanner")}
      >
        <ScannerDrawer data={data.scanner} />
      </ExpandableStatCard>

      {/* ── Row 2 ─────────────────────────────────────────────── */}

      {/* ongoing — 2×1 hero */}
      <ExpandableStatCard
        id="ongoing"
        label="Ongoing"
        value={data.ongoing.count}
        valueColor="amber"
        hero
        isExpanded={expandedId === "ongoing"}
        onToggle={() => toggle("ongoing")}
      >
        <OngoingDrawer data={data.ongoing as any} />
      </ExpandableStatCard>

      {/* upcoming — 2×1 hero */}
      <ExpandableStatCard
        id="upcoming"
        label="Upcoming"
        value={data.upcoming.count}
        valueColor="purple"
        hero
        isExpanded={expandedId === "upcoming"}
        onToggle={() => toggle("upcoming")}
      >
        <UpcomingDrawer data={data.upcoming as any} />
      </ExpandableStatCard>

      {/* ai_boost */}
      <ExpandableStatCard
        id="ai_boost"
        label="AI Boost"
        value={fmtGbp(data.ai_boost.total_uplift_gbp)}
        valueColor="green"
        subtitle={`${data.ai_boost.breakdown.length} sources`}
        isExpanded={expandedId === "ai_boost"}
        onToggle={() => toggle("ai_boost")}
      >
        <AiBoostDrawer data={data.ai_boost} />
      </ExpandableStatCard>

      {/* out_of_stock */}
      <ExpandableStatCard
        id="out_of_stock"
        label="Out of Stock"
        value={data.out_of_stock.count}
        valueColor={data.out_of_stock.count > 0 ? "red" : "green"}
        accentColor={data.out_of_stock.count > 0 ? "red" : undefined}
        subtitle="next 30 days"
        isExpanded={expandedId === "out_of_stock"}
        onToggle={() => toggle("out_of_stock")}
      >
        <OutOfStockDrawer data={data.out_of_stock} />
      </ExpandableStatCard>

      {/* ── Row 3 ─────────────────────────────────────────────── */}

      {/* denied_revenue */}
      <ExpandableStatCard
        id="denied_revenue"
        label="Denied Revenue"
        value={fmtGbp(data.denied_revenue.total_gbp)}
        valueColor={data.denied_revenue.total_gbp > 0 ? "amber" : "blue"}
        accentColor="amber"
        subtitle={`${data.denied_revenue.items.length} denials (90d)`}
        isExpanded={expandedId === "denied_revenue"}
        onToggle={() => toggle("denied_revenue")}
      >
        <DeniedRevenueDrawer data={data.denied_revenue as any} />
      </ExpandableStatCard>

      {/* missed_revenue */}
      <ExpandableStatCard
        id="missed_revenue"
        label="Missed Revenue"
        value={fmtGbp(data.missed_revenue.total_gbp)}
        valueColor="red"
        accentColor="red"
        isExpanded={expandedId === "missed_revenue"}
        onToggle={() => toggle("missed_revenue")}
      >
        <MissedRevenueDrawer data={data.missed_revenue as any} />
      </ExpandableStatCard>

      {/* vacation */}
      <ExpandableStatCard
        id="vacation"
        label="Vacation Mode"
        value={data.vacation.active_blocks.length > 0 ? "On" : "Off"}
        valueColor={data.vacation.active_blocks.length > 0 ? "amber" : "green"}
        accentColor={data.vacation.active_blocks.length > 0 ? "amber" : undefined}
        subtitle={`${data.vacation.active_blocks.length} block(s)`}
        isExpanded={expandedId === "vacation"}
        onToggle={() => toggle("vacation")}
      >
        <VacationDrawer data={data.vacation as any} />
      </ExpandableStatCard>

      {/* sell_reco */}
      <ExpandableStatCard
        id="sell_reco"
        label="Sell Recommender"
        value={data.sell_reco.recommendations.length > 0 ? data.sell_reco.recommendations.length : "—"}
        valueColor="amber"
        accentColor="amber"
        subtitle="items to consider"
        isExpanded={expandedId === "sell_reco"}
        onToggle={() => toggle("sell_reco")}
      >
        <SellRecoDrawer data={data.sell_reco as any} />
      </ExpandableStatCard>

      {/* inventory_worth */}
      <ExpandableStatCard
        id="inventory_worth"
        label="Inventory Worth"
        value={data.inventory_worth.total_gbp > 0 ? fmtGbp(data.inventory_worth.total_gbp) : "—"}
        valueColor="blue"
        accentColor="blue"
        subtitle="acquisition cost"
        isExpanded={expandedId === "inventory_worth"}
        onToggle={() => toggle("inventory_worth")}
      >
        <InventoryWorthDrawer data={data.inventory_worth} />
      </ExpandableStatCard>

      {/* tax */}
      <ExpandableStatCard
        id="tax"
        label="UK Tax"
        value={data.tax.years.length > 0 ? fmtGbp(data.tax.years[0].estimated_tax) : "—"}
        valueColor="red"
        accentColor="red"
        subtitle={data.tax.years.length > 0 ? `${data.tax.years[0].year}` : "—"}
        isExpanded={expandedId === "tax"}
        onToggle={() => toggle("tax")}
      >
        <TaxDrawer data={data.tax} />
      </ExpandableStatCard>

      {/* ── Row 4 ─────────────────────────────────────────────── */}

      {/* business_intel — 2×1 hero */}
      <ExpandableStatCard
        id="business_intel"
        label="Business Intel"
        value={data.business_intel.kpis.length > 0 ? `${data.business_intel.kpis.length} signals` : "—"}
        valueColor="purple"
        accentColor="purple"
        hero
        isExpanded={expandedId === "business_intel"}
        onToggle={() => toggle("business_intel")}
      >
        <BusinessIntelDrawer data={data.business_intel} />
      </ExpandableStatCard>
    </div>
  );
}
