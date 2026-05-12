import { HeaderBar } from "@/components/dashboard/HeaderBar";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { LifetimeRevenue } from "@/components/dashboard/LifetimeRevenue";
import { EarningsChart } from "@/components/dashboard/EarningsChart";
import { LiveActivity } from "@/components/dashboard/LiveActivity";
import { CalendarStrip } from "@/components/dashboard/CalendarStrip";
import { ReturnHub } from "@/components/dashboard/ReturnHub";
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
import { HyggloInbox } from "@/components/dashboard/HyggloInbox";
import { AIChat } from "@/components/dashboard/AIChat";

export default function DashboardPage() {
  return (
    <div style={{ background: "#070910", minHeight: "100dvh" }}>
      {/* Row 1: Header bar — sticky full */}
      <HeaderBar />
      <main
        className="mx-auto px-4 md:px-6 py-5"
        style={{ maxWidth: "1440px" }}
      >
        {/* Row 2: Stats grid */}
        <section className="mb-5">
          <StatsGrid />
        </section>

        {/* Row 3: Lifetime Revenue — full-width hero */}
        <section className="mb-4">
          <LifetimeRevenue />
        </section>

        {/* Row 4: Earnings Chart + Live Activity — 2-col */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <EarningsChart />
          <LiveActivity />
        </section>

        {/* Row 5: Calendar strip — full */}
        <section className="mb-4">
          <CalendarStrip />
        </section>

        {/* Row 6: Return Hub — full (conditional) */}
        <section className="mb-4">
          <ReturnHub />
        </section>

        {/* Row 7: Weekly Calendar — full (desktop only) */}
        <section className="mb-4">
          <WeeklyCalendar />
        </section>

        {/* Row 8: Conversation Funnel + Top Items + Top Bundles — 3-col */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <ConversationFunnel />
          <ItemRevenuePanel />
          <TopBundles />
        </section>

        {/* Row 9: Item Cycle Tracker — full */}
        <section className="mb-4">
          <ItemCycleTracker />
        </section>

        {/* Row 10: Currently Out of Stock — full */}
        <section className="mb-4">
          <OutOfStockPanel />
        </section>

        {/* Row 11: Missed Revenue — full */}
        <section className="mb-4">
          <MissedRevenue />
        </section>

        {/* Row 12: Investment Scorecard — full */}
        <section className="mb-4">
          <InvestmentScorecard />
        </section>

        {/* Row 13: Sell Recommender — full */}
        <section className="mb-4">
          <SellRecommender />
        </section>

        {/* Row 14: Price Recommendations — full */}
        <section className="mb-4">
          <PriceRecommendations />
        </section>

        {/* Row 15: AI Investment Insights — full */}
        <section className="mb-4">
          <AIInvestmentInsights />
        </section>


        {/* Row 19: Health & Scanner — full */}
        <section className="mb-4">
          <HealthScanner />
        </section>

        {/* Row 20: Hygglo Inbox — v2-only auxiliary */}
        <section className="mb-4">
          <HyggloInbox />
        </section>

        {/* Row 21: AI Chat — full */}
        <section className="mb-4">
          <AIChat />
        </section>
      </main>
    </div>
  );
}
