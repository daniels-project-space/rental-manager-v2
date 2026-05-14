import type { ComponentType } from "react";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { LifetimeRevenue } from "@/components/dashboard/LifetimeRevenue";
import { EarningsChart } from "@/components/dashboard/EarningsChart";
import { LiveActivity } from "@/components/dashboard/LiveActivity";
import { CalendarStrip } from "@/components/dashboard/CalendarStrip";
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
import { HealthScanner } from "@/components/dashboard/HealthScanner";
import { HyggloInbox } from "@/components/dashboard/HyggloInbox";
import { AIChat } from "@/components/dashboard/AIChat";

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
  { id: "stats-grid",          label: "Stats Grid",             component: StatsGrid },
  { id: "lifetime",            label: "Lifetime Revenue",       component: LifetimeRevenue },
  { id: "earnings-chart",      label: "Earnings Chart",         component: EarningsChart },
  { id: "live-activity",       label: "Live Activity",          component: LiveActivity },
  { id: "calendar-strip",      label: "Calendar Strip",         component: CalendarStrip },
  { id: "return-hub",          label: "Return Hub",             component: ReturnHub },
  // weekly-calendar is intentionally NOT a dashboard widget — it lives only as
  // an overlay (CalendarGantt) launched from CalendarStrip's 'Weekly View' button.
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
  { id: "ai-chat",             label: "AI Chat",                component: AIChat },
];

export const STAT_WIDGETS: readonly StatWidget[] = [
  { id: "active",          label: "Active" },
  { id: "earnings",        label: "Earnings" },
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
  { id: "vacation",        label: "Vacation" },
  { id: "sell_reco",       label: "Sell Reco" },
  { id: "inventory_worth", label: "Inventory Worth" },
  { id: "tax",             label: "Tax" },
  { id: "business_intel",  label: "Business Intel" },
];

export const DEFAULT_PANEL_ORDER = PANEL_WIDGETS.map((w) => w.id);
export const DEFAULT_STAT_ORDER  = STAT_WIDGETS.map((w) => w.id);
