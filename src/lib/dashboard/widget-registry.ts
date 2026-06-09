import type { ComponentType } from "react";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { LifetimeRevenue } from "@/components/dashboard/LifetimeRevenue";
import { EarningsChart } from "@/components/dashboard/EarningsChart";
import { TaxSummary } from "@/components/dashboard/TaxSummary";
import { LiveActivity } from "@/components/dashboard/LiveActivity";
import { CalendarStrip } from "@/components/dashboard/CalendarStrip";
import { ItemAvailabilityCalendar } from "@/components/dashboard/ItemAvailabilityCalendar";
import { NextRentals } from "@/components/dashboard/NextRentals";
import { ReturnHub } from "@/components/dashboard/ReturnHub";
import { ConversationFunnel } from "@/components/dashboard/ConversationFunnel";
import { ItemRevenuePanel } from "@/components/dashboard/ItemRevenuePanel";
import { TopBundles } from "@/components/dashboard/TopBundles";
import { ItemCycleTracker } from "@/components/dashboard/ItemCycleTracker";
import { OutOfStockPanel } from "@/components/dashboard/OutOfStockPanel";
import { MissedRevenue } from "@/components/dashboard/MissedRevenue";
import { InvestmentScorecard } from "@/components/dashboard/InvestmentScorecard";
import { SellRecommender } from "@/components/dashboard/SellRecommender";
import { PriceRecommendations } from "@/components/dashboard/PriceRecommendations";
import { AIInvestmentInsights } from "@/components/dashboard/AIInvestmentInsights";
import { AIChat } from "@/components/dashboard/AIChat";
import { HealthScanner } from "@/components/dashboard/HealthScanner";
import { HyggloInbox } from "@/components/dashboard/HyggloInbox";
import { ItemROIPanel } from "@/components/dashboard/ItemROIPanel";
import { LostRevenueBuyPanel } from "@/components/dashboard/LostRevenueBuyPanel";
import { VerificationFunnelPanel } from "@/components/dashboard/VerificationFunnelPanel";
import { EquipmentValuePanel } from "@/components/dashboard/EquipmentValuePanel";
import { CompetitorIntelPanel } from "@/components/dashboard/CompetitorIntelPanel";

export type PanelWidget = {
  id: string;
  label: string;
  component: ComponentType;
};

export type StatWidget = {
  id: string;
  label: string;
};

export const PANEL_WIDGETS: readonly PanelWidget[] = [
  // Competitor Intel — collapsible, default-collapsed, pinned to the TOP.
  { id: "competitor-intel",    label: "Competitor Intel",       component: CompetitorIntelPanel },
  { id: "stats-grid",          label: "Stats Grid",             component: StatsGrid },
  { id: "ai-chat",            label: "AI Assistant",           component: AIChat },
  { id: "lifetime",            label: "Lifetime Revenue",       component: LifetimeRevenue },
  { id: "earnings-chart",      label: "Earnings Chart",         component: EarningsChart },
  { id: "tax-summary",         label: "Tax Summary",            component: TaxSummary },
  { id: "live-activity",       label: "Live Activity",          component: LiveActivity },
  { id: "calendar-strip",      label: "Calendar Strip",         component: CalendarStrip },
  { id: "item-availability",   label: "Item Availability",      component: ItemAvailabilityCalendar },
  { id: "next-rentals",        label: "Next Rentals",           component: NextRentals },
  { id: "return-hub",          label: "Return Hub",             component: ReturnHub },
  // weekly-calendar lives only as an overlay (CalendarGantt). It is launched
  // from CalendarStrip's 'Weekly View' button AND from the compact
  // `weekly_calendar` stat card (see STAT_WIDGETS) — neither is a full panel.
  { id: "conversation-funnel", label: "Conversation Funnel",    component: ConversationFunnel },
  { id: "item-revenue",        label: "Item Revenue",           component: ItemRevenuePanel },
  { id: "top-bundles",         label: "Top Bundles",            component: TopBundles },
  { id: "item-cycle",          label: "Item Cycle Tracker",     component: ItemCycleTracker },
  { id: "out-of-stock",        label: "Out of Stock",           component: OutOfStockPanel },
  { id: "missed-revenue",      label: "Missed Revenue",         component: MissedRevenue },
  { id: "scorecard",           label: "Investment Scorecard",   component: InvestmentScorecard },
  { id: "sell-recommender",    label: "Sell Recommender",       component: SellRecommender },
  { id: "price-recos",         label: "Price Recommendations",  component: PriceRecommendations },
  { id: "ai-insights",         label: "AI Investment Insights", component: AIInvestmentInsights },
  { id: "health-scanner",      label: "Health & Scanner",       component: HealthScanner },
  { id: "hygglo-inbox",        label: "Hygglo Inbox",           component: HyggloInbox },
  { id: "item-roi",            label: "Item ROI",              component: ItemROIPanel },
  { id: "lost-revenue-buy",    label: "Lost Revenue · Buy",    component: LostRevenueBuyPanel },
  { id: "verification-funnel", label: "Verification Funnel",   component: VerificationFunnelPanel },
  { id: "equipment-value",     label: "Equipment Value & Resell", component: EquipmentValuePanel },
];

export const STAT_WIDGETS: readonly StatWidget[] = [
  { id: "walle",           label: "WallE" },
  { id: "active",          label: "Active" },
  { id: "weekly_calendar", label: "Weekly Calendar" },
  { id: "earnings",        label: "Earnings Today" },
  { id: "monthly",         label: "Monthly" },
  { id: "confirmed",       label: "Confirmed" },
  { id: "scanner",         label: "Scanner" },
  { id: "insurance",       label: "Insurance Claims" },
  { id: "ongoing",         label: "Ongoing" },
  { id: "upcoming",        label: "Upcoming" },
  { id: "ai_boost",        label: "AI Boost" },
  { id: "out_of_stock",    label: "Out of Stock" },
  { id: "denied_revenue",  label: "Denied Revenue" },
  { id: "missed_revenue",  label: "Missed Revenue" },
  { id: "vacation",        label: "Vacation & Maintenance" },
  { id: "sell_reco",       label: "Sell Reco" },
  { id: "inventory_worth", label: "Inventory Worth" },
  { id: "tax",             label: "Tax" },
  { id: "business_intel",  label: "Business Intel" },
  { id: "category_volume", label: "Category Volume" },
  // ── Phase 7 — weekly_metrics-driven insight widgets ──
  { id: "voluntary_deny",    label: "Voluntary Denies" },
  { id: "capacity_gap",      label: "Capacity Gap" },
  { id: "utilization",       label: "Idle Inventory" },
  { id: "below_minimum",     label: "Below Min £" },
  { id: "revenue_sparkline", label: "Revenue Trend" },
];

// Widgets requiring multi-cell spans on the StatsGrid. Any id NOT listed here
// renders at the default 1x1 size. Existing hero behaviour (1-row, col-span-2)
// can be expressed as `{ col: 2, row: 1 }`, and a 2x2 hero as
// `{ col: 2, row: 2 }`. `walle` defaults to a small `{ col: 1, row: 2 }` card.
export const HERO_SPANS: Record<string, { col: number; row: number }> = {
  walle: { col: 1, row: 2 },
};

// Backwards-compat: legacy 1-row hero ids (col-span-2 only). Keep this list as
// the single source of truth for the historical "hero" treatment so StatsGrid
// can fall back to it when an id is not in HERO_SPANS.
export const HERO_IDS: ReadonlySet<string> = new Set([
  "active",
  "weekly_calendar",
  "ongoing",
  "upcoming",
  "business_intel",
  "category_volume",
  "revenue_sparkline",
]);

export const DEFAULT_PANEL_ORDER = PANEL_WIDGETS.map((w) => w.id);
export const DEFAULT_STAT_ORDER  = STAT_WIDGETS.map((w) => w.id);
