import type { ComponentType } from "react";
import dynamic from "next/dynamic";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { CalendarStrip } from "@/components/dashboard/CalendarStrip";
import { NextRentals } from "@/components/dashboard/NextRentals";
import { ReturnHub } from "@/components/dashboard/ReturnHub";

// Secondary dashboard sections are already mounted by DeferredMount only when
// they approach the viewport. Split each section into its own client chunk so
// their modules also stay out of the first dashboard download.
function deferredPanel(
  loader: () => Promise<{ default: ComponentType<any> }>,
): ComponentType<any> {
  return dynamic<any>(loader, { ssr: false, loading: () => null });
}

const BusinessPayoutCalculator = deferredPanel(() => import("@/components/dashboard/finance/BusinessPayoutCalculator").then((m) => ({ default: m.BusinessPayoutCalculator })));
const LiveCalendar = deferredPanel(() => import("@/components/dashboard/LiveCalendar").then((m) => ({ default: m.LiveCalendar })));
const LifetimeRevenue = deferredPanel(() => import("@/components/dashboard/LifetimeRevenue").then((m) => ({ default: m.LifetimeRevenue })));
const EarningsChart = deferredPanel(() => import("@/components/dashboard/EarningsChart").then((m) => ({ default: m.EarningsChart })));
const TaxSummary = deferredPanel(() => import("@/components/dashboard/TaxSummary").then((m) => ({ default: m.TaxSummary })));
const LiveActivity = deferredPanel(() => import("@/components/dashboard/LiveActivity").then((m) => ({ default: m.LiveActivity })));
const ItemAvailabilityCalendar = deferredPanel(() => import("@/components/dashboard/ItemAvailabilityCalendar").then((m) => ({ default: m.ItemAvailabilityCalendar })));
const ConversationFunnel = deferredPanel(() => import("@/components/dashboard/ConversationFunnel").then((m) => ({ default: m.ConversationFunnel })));
const ItemRevenuePanel = deferredPanel(() => import("@/components/dashboard/ItemRevenuePanel").then((m) => ({ default: m.ItemRevenuePanel })));
const TopBundles = deferredPanel(() => import("@/components/dashboard/TopBundles").then((m) => ({ default: m.TopBundles })));
const ItemCycleTracker = deferredPanel(() => import("@/components/dashboard/ItemCycleTracker").then((m) => ({ default: m.ItemCycleTracker })));
const OutOfStockPanel = deferredPanel(() => import("@/components/dashboard/OutOfStockPanel").then((m) => ({ default: m.OutOfStockPanel })));
const MissedRevenue = deferredPanel(() => import("@/components/dashboard/MissedRevenue").then((m) => ({ default: m.MissedRevenue })));
const InvestmentScorecard = deferredPanel(() => import("@/components/dashboard/InvestmentScorecard").then((m) => ({ default: m.InvestmentScorecard })));
const SellRecommender = deferredPanel(() => import("@/components/dashboard/SellRecommender").then((m) => ({ default: m.SellRecommender })));
const PriceRecommendations = deferredPanel(() => import("@/components/dashboard/PriceRecommendations").then((m) => ({ default: m.PriceRecommendations })));
const AIInvestmentInsights = deferredPanel(() => import("@/components/dashboard/AIInvestmentInsights").then((m) => ({ default: m.AIInvestmentInsights })));
const AIChat = deferredPanel(() => import("@/components/dashboard/AIChat").then((m) => ({ default: m.AIChat })));
const HealthScanner = deferredPanel(() => import("@/components/dashboard/HealthScanner").then((m) => ({ default: m.HealthScanner })));
const HyggloInbox = deferredPanel(() => import("@/components/dashboard/HyggloInbox").then((m) => ({ default: m.HyggloInbox })));
const ReplyInbox = deferredPanel(() => import("@/components/dashboard/ReplyInbox").then((m) => ({ default: m.ReplyInbox })));
const ItemROIPanel = deferredPanel(() => import("@/components/dashboard/ItemROIPanel").then((m) => ({ default: m.ItemROIPanel })));
const LostRevenueBuyPanel = deferredPanel(() => import("@/components/dashboard/LostRevenueBuyPanel").then((m) => ({ default: m.LostRevenueBuyPanel })));
const VerificationFunnelPanel = deferredPanel(() => import("@/components/dashboard/VerificationFunnelPanel").then((m) => ({ default: m.VerificationFunnelPanel })));
const EquipmentValuePanel = deferredPanel(() => import("@/components/dashboard/EquipmentValuePanel").then((m) => ({ default: m.EquipmentValuePanel })));
const CompetitorIntelPanel = deferredPanel(() => import("@/components/dashboard/CompetitorIntelPanel").then((m) => ({ default: m.CompetitorIntelPanel })));
const PortedListingsPanel = deferredPanel(() => import("@/components/dashboard/PortedListingsPanel").then((m) => ({ default: m.PortedListingsPanel })));
const BrandControlPanel = deferredPanel(() => import("@/components/dashboard/BrandControlPanel").then((m) => ({ default: m.BrandControlPanel })));
const ListingManagerPanel = deferredPanel(() => import("@/components/dashboard/ListingManagerPanel").then((m) => ({ default: m.ListingManagerPanel })));
const MarketingListingsPanel = deferredPanel(() => import("@/components/dashboard/MarketingListingsPanel").then((m) => ({ default: m.MarketingListingsPanel })));

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
  { id: "reply-inbox",        label: "Quick Reply",            component: ReplyInbox },
  { id: "lifetime",            label: "Lifetime Revenue",       component: LifetimeRevenue },
  { id: "earnings-chart",      label: "Earnings Chart",         component: EarningsChart },
  { id: "tax-summary",         label: "Taxes & Invoice Archive", component: TaxSummary },
  { id: "business-payout-calculator", label: "Business Payout Calculator", component: BusinessPayoutCalculator },
  { id: "live-activity",       label: "Live Activity",          component: LiveActivity },
  { id: "live-calendar", label: "Live Calendar", component: LiveCalendar },
  { id: "calendar-strip",      label: "Calendar Strip",         component: CalendarStrip },
  { id: "item-availability",   label: "Item Availability",      component: ItemAvailabilityCalendar },
  { id: "next-rentals",        label: "Next Rentals",           component: NextRentals },
  { id: "return-hub",          label: "Return Hub",             component: ReturnHub },
  // The live-calendar panel reuses CalendarGantt; the weekly_calendar stat
  // and optional calendar-strip still launch its fullscreen view.
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
  { id: "ported-listings",     label: "Ported Listings",        component: PortedListingsPanel },
  { id: "brand-control",       label: "Brand Control Center",   component: BrandControlPanel },
  { id: "listing-manager",     label: "Listing Manager",        component: ListingManagerPanel },
  { id: "marketing-only-listings", label: "Marketing-only Listings", component: MarketingListingsPanel },
];

export const STAT_WIDGETS: readonly StatWidget[] = [
  { id: "conversation_funnel", label: "Conversation Funnel" },
  { id: "channel_response_rates", label: "Channel Response Rate" },
  { id: "todos",           label: "To-Do" },
  { id: "walle",           label: "WallE" },
  { id: "active",          label: "Active Rentals" },
  { id: "weekly_calendar", label: "Weekly Calendar" },
  { id: "earnings",        label: "Earnings Today" },
  { id: "monthly",         label: "Expected Monthly" },
  { id: "pending_review", label: "Bookings awaiting confirmation" },
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
  walle: { col: 1, row: 1 },
};

// Backwards-compat: legacy 1-row hero ids (col-span-2 only). Keep this list as
// the single source of truth for the historical "hero" treatment so StatsGrid
// can fall back to it when an id is not in HERO_SPANS.
export const HERO_IDS: ReadonlySet<string> = new Set([

  "active",
  "monthly",
  "pending_review",
  "weekly_calendar",
  "ongoing",
  "upcoming",
  "business_intel",
  "category_volume",
  "revenue_sparkline",
]);

export const DEFAULT_HIDDEN_PANELS = ["calendar-strip", "conversation-funnel"];
export const COMPACT_PANELS: ReadonlySet<string> = new Set([
  "earnings-chart", "live-activity", "top-bundles", "missed-revenue",
  "out-of-stock", "sell-recommender", "price-recos", "conversation-funnel",
  "verification-funnel", "item-roi", "lost-revenue-buy",
  "item-revenue", "item-cycle", "scorecard", "ai-insights", "health-scanner", "equipment-value",
]);
export const panelLayoutClass = (id:string) => COMPACT_PANELS.has(id) ? "min-w-0" : "min-w-0 lg:col-span-2";
const PRIMARY_PANELS = ["stats-grid", "lifetime", "reply-inbox", "live-calendar", "return-hub", "marketing-only-listings"];
export const DEFAULT_PANEL_ORDER = [...PRIMARY_PANELS, ...PANEL_WIDGETS.map((w) => w.id).filter((id) => !PRIMARY_PANELS.includes(id))];
export const DEFAULT_STAT_ORDER  = STAT_WIDGETS.map((w) => w.id);
