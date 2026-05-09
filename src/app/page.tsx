import { HeaderBar } from "@/components/dashboard/HeaderBar";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { LifetimeRevenue } from "@/components/dashboard/LifetimeRevenue";
import { EarningsChart } from "@/components/dashboard/EarningsChart";
import { LiveActivity } from "@/components/dashboard/LiveActivity";
import { ReturnHub } from "@/components/dashboard/ReturnHub";
import { CalendarStrip } from "@/components/dashboard/CalendarStrip";
import { WeeklyCalendar } from "@/components/dashboard/WeeklyCalendar";
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
import { AIChat } from "@/components/dashboard/AIChat";
import { HyggloInbox } from "@/components/dashboard/HyggloInbox";

export default function DashboardPage() {
  return (
    <div style={{ background: "#070910", minHeight: "100dvh" }}>
      <HeaderBar />
      <main
        className="mx-auto px-4 md:px-6 py-5"
        style={{ maxWidth: "1440px" }}
      >
        {/* W02 Stats Grid */}
        <section className="mb-5">
          <StatsGrid />
        </section>

        {/* Row 1: Lifetime Revenue + Earnings Chart */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="md:col-span-1">
            <LifetimeRevenue />
          </div>
          <div className="md:col-span-2">
            <EarningsChart />
          </div>
        </section>

        {/* Row 2: Live Activity + Return Hub */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <LiveActivity />
          <ReturnHub />
        </section>

        {/* Row 3: Calendar Strip (full width) */}
        <section className="mb-4">
          <CalendarStrip />
        </section>

        {/* Row 4: Weekly Calendar (desktop only — hidden on mobile) */}
        <section className="mb-4">
          <WeeklyCalendar />
        </section>

        {/* Row 5: Conversation Funnel + Item Revenue */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <ConversationFunnel />
          <ItemRevenuePanel />
        </section>

        {/* Row 6: Top Bundles + Item Cycle Tracker */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <TopBundles />
          <ItemCycleTracker />
        </section>

        {/* Row 7: Out of Stock + Missed Revenue */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <OutOfStockPanel />
          <MissedRevenue />
        </section>

        {/* Row 8: Investment Scorecard + Sell Recommender */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <InvestmentScorecard />
          <SellRecommender />
        </section>

        {/* Row 9: Price Recommendations + AI Investment Insights */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <PriceRecommendations />
          <AIInvestmentInsights />
        </section>

        {/* Row 10: Health Scanner (full width) */}
        <section className="mb-4">
          <HealthScanner />
        </section>

        {/* Row 11b: Hygglo Inbox (Phase 6.0) */}
        <section className="mb-4">
          <HyggloInbox />
        </section>

        {/* Row 11: AI Chat (full width) */}
        <section className="mb-4">
          <AIChat />
        </section>
      </main>
    </div>
  );
}
