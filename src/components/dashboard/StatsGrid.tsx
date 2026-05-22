"use client";
import { useMemo, useState, type ReactElement } from "react";
import { useQuery } from "convex/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { api } from "../../../convex/_generated/api";
import { useAccount } from "@/lib/account-context";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";
import { STAT_WIDGETS } from "@/lib/dashboard/widget-registry";
import { EditableWidget } from "./EditableWidget";
import ExpandableStatCard from "./ExpandableStatCard";
import ActiveDrawer from "./stat-cards/ActiveDrawer";
import EarningsDrawer from "./stat-cards/EarningsDrawer";
import MonthlyDrawer from "./stat-cards/MonthlyDrawer";
import ConfirmedDrawer from "./stat-cards/ConfirmedDrawer";
import OngoingDrawer from "./stat-cards/OngoingDrawer";
import UpcomingDrawer from "./stat-cards/UpcomingDrawer";
import ScannerDrawer from "./stat-cards/ScannerDrawer";
import InsuranceClaimsDrawer from "./stat-cards/InsuranceClaimsDrawer";
import DeniedRevenueDrawer from "./stat-cards/DeniedRevenueDrawer";
import MissedRevenueDrawer from "./stat-cards/MissedRevenueDrawer";
import AiBoostDrawer from "./stat-cards/AiBoostDrawer";
import OutOfStockDrawer from "./stat-cards/OutOfStockDrawer";
import VacationDrawer from "./stat-cards/VacationDrawer";
import SellRecoDrawer from "./stat-cards/SellRecoDrawer";
import InventoryWorthDrawer from "./stat-cards/InventoryWorthDrawer";
import TaxDrawer from "./stat-cards/TaxDrawer";
import BusinessIntelDrawer from "./stat-cards/BusinessIntelDrawer";
import { CriticalAlerts } from "./CriticalAlerts";
import { CategoryVolumePieBody } from "./CategoryVolumePie";
import { VoluntaryDenyHotList } from "./insights/VoluntaryDenyHotList";
import { CapacityGapAlert } from "./insights/CapacityGapAlert";
import { ItemUtilizationRanking } from "./insights/ItemUtilizationRanking";
import { BelowMinimumCounter } from "./insights/BelowMinimumCounter";
import { WeeklyRevenueSparkline } from "./insights/WeeklyRevenueSparkline";

function fmtGbp(n: number): string {
  if (n >= 1000) return "£" + (n / 1000).toFixed(1) + "k";
  return "£" + n.toFixed(0);
}

function fmtGbpFull(n: number): string {
  return "£" + Math.round(n).toLocaleString("en-GB");
}

function SegmentedBar({
  ongoing,
  upcoming,
  pending,
}: { ongoing: number; upcoming: number; pending: number }) {
  const total = ongoing + upcoming + pending;
  if (total === 0) return null;
  const pct = (n: number) => (n > 0 ? Math.max(3, (n / total) * 100) : 0);
  const raw = [pct(ongoing), pct(upcoming), pct(pending)];
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const [wO, wU, wP] = raw.map((p) => (p / sum) * 100);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-900/60">
      {wO > 0 && <div style={{ width: `${wO}%`, background: "linear-gradient(90deg,#f59e0b,#fbbf24)" }} />}
      {wU > 0 && <div style={{ width: `${wU}%`, background: "linear-gradient(90deg,#a78bfa,#8b5cf6)" }} />}
      {wP > 0 && <div style={{ width: `${wP}%`, background: "linear-gradient(90deg,#f472b6,#ec4899)" }} />}
    </div>
  );
}

function ConfirmedBar({
  done,
  active,
  upcoming,
  pending,
}: { done: number; active: number; upcoming: number; pending: number }) {
  const total = done + active + upcoming + pending;
  if (total === 0) return null;
  const pct = (n: number) => (n > 0 ? Math.max(3, (n / total) * 100) : 0);
  const raw = [pct(done), pct(active), pct(upcoming), pct(pending)];
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const [wD, wA, wU, wP] = raw.map((p) => (p / sum) * 100);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-900/60">
      {wD > 0 && <div style={{ width: `${wD}%`, background: "linear-gradient(90deg,#22c55e,#34d399)" }} />}
      {wA > 0 && <div style={{ width: `${wA}%`, background: "linear-gradient(90deg,#f59e0b,#fbbf24)" }} />}
      {wU > 0 && <div style={{ width: `${wU}%`, background: "linear-gradient(90deg,#a78bfa,#8b5cf6)" }} />}
      {wP > 0 && <div style={{ width: `${wP}%`, background: "linear-gradient(90deg,#f472b6,#ec4899)" }} />}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-900/60">
      <div
        className="h-full rounded-full"
        style={{
          width: `${clamped}%`,
          background: "linear-gradient(90deg,#10b981,#22c55e)",
          boxShadow: "0 0 8px rgba(34,197,94,0.4)",
        }}
      />
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />;
}

function StatsGridSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4 mt-4">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="h-20 rounded-2xl bg-slate-900/40 animate-pulse" />
      ))}
    </div>
  );
}

// Hero cards span 2 grid columns. Without an outer wrapper this is set on the
// card itself; with EditableWidget wrapper the col-span must live on the wrapper.
const HERO_IDS = new Set(["active", "ongoing", "upcoming", "business_intel", "category_volume", "revenue_sparkline"]);

export function StatsGrid() {
  const { activeAccountSlug } = useAccount();
  const { layout, isStatHidden, reorderStats } = useEditMode();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [catVolExpanded, setCatVolExpanded] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rawData = useQuery(api.dashboard.getStatsDrawerData, {
    accountSlug: activeAccountSlug,
  });
  const cards = useMemo<Record<string, ReactElement> | null>(() => {
    if (!rawData) return null;
    const data = rawData as any;
    const toggle = (id: string) =>
      setExpandedId((prev) => (prev === id ? null : id));

    return {
      active: (
        <ExpandableStatCard
          id="active"
          label="Active Rentals"
          value={data.active.total}
          valueColor="blue"
          accentColor="blue"
          hero
          isExpanded={expandedId === "active"}
          onToggle={() => toggle("active")}
          subtitle={(() => {
            const pendingNextMonth = data.active.pending_next_month_count ?? 0;
            return (
              <span className="block">
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                  <span className="inline-flex items-center gap-1 text-amber-300">
                    <Dot color="#f59e0b" />
                    <span className="font-semibold">{data.active.ongoing_count}</span> ongoing
                  </span>
                  <span className="text-slate-600">+</span>
                  <span className="inline-flex items-center gap-1 text-violet-300">
                    <Dot color="#a78bfa" />
                    <span className="font-semibold">{data.active.upcoming_count}</span> upcoming
                  </span>
                  {data.active.pending_count > 0 && (
                    <>
                      <span className="text-slate-600">+</span>
                      <span className="inline-flex items-center gap-1 text-pink-300">
                        <Dot color="#ec4899" />
                        <span className="font-semibold">{data.active.pending_count}</span> pending
                      </span>
                    </>
                  )}
                </span>
                {data.active.pending_count > 0 && pendingNextMonth > 0 && (
                  <span className="block text-[10px] text-zinc-500 mt-0.5 leading-tight">
                    incl. {pendingNextMonth} starting next month
                  </span>
                )}
              </span>
            );
          })()}
          headerExtra={
            <SegmentedBar
              ongoing={data.active.ongoing_count}
              upcoming={data.active.upcoming_count}
              pending={data.active.pending_count}
            />
          }
        >
          <ActiveDrawer data={data.active as any} />
        </ExpandableStatCard>
      ),
      earnings: (
        <ExpandableStatCard
          id="earnings"
          label="Earnings"
          value={fmtGbp(data.earnings.today)}
          valueColor="green"
          accentColor="green"
          subtitle={`Week: ${fmtGbp(data.earnings.week)} net`}
          isExpanded={expandedId === "earnings"}
          onToggle={() => toggle("earnings")}
        >
          <EarningsDrawer data={data.earnings} />
        </ExpandableStatCard>
      ),
      monthly: (
        <ExpandableStatCard
          id="monthly"
          label="Expected Monthly"
          value={fmtGbpFull(data.monthly.projected)}
          valueColor="green"
          accentColor="green"
          subtitle={`£${Math.round(data.monthly.avg_daily_rate)}/day avg · ${data.monthly.days_remaining}d left`}
          isExpanded={expandedId === "monthly"}
          onToggle={() => toggle("monthly")}
          headerExtra={
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">
                  Confirmed: <span className="text-emerald-300 font-semibold">{fmtGbpFull(data.monthly.confirmed_revenue)}</span>
                </span>
                <span className="text-slate-400">
                  <span className="text-emerald-300 font-semibold">{data.monthly.pct_of_target}%</span> of target
                </span>
              </div>
              <ProgressBar pct={data.monthly.pct_of_target} />
              <div className="text-[10px] text-slate-500">
                £{Math.round(data.monthly.avg_daily_rate)}/day avg · {data.monthly.days_remaining} days left in month
              </div>
            </div>
          }
        >
          <MonthlyDrawer data={data.monthly} />
        </ExpandableStatCard>
      ),
      confirmed: (
        <ExpandableStatCard
          id="confirmed"
          label="Month Confirmed"
          value={fmtGbpFull(data.confirmed.month_revenue)}
          valueColor="green"
          accentColor="purple"
          valueSuffix={
            data.confirmed.pending_value_gbp > 0 ? (
              <span className="text-pink-400">+{fmtGbpFull(data.confirmed.pending_value_gbp)}</span>
            ) : undefined
          }
          subtitle={
            <span className="block">
              {data.confirmed.pending_count > 0 && (
                <span className="block text-pink-400 text-[11px] font-medium leading-tight">pending</span>
              )}
              <span className="block text-slate-400 text-[11px] leading-tight mt-0.5">
                {data.confirmed.done_count} done, {data.confirmed.active_count} active, {data.confirmed.upcoming_count} upcoming · {data.confirmed.total_rentals} rentals
              </span>
            </span>
          }
          isExpanded={expandedId === "confirmed"}
          onToggle={() => toggle("confirmed")}
          headerExtra={
            <div className="space-y-1.5">
              <ConfirmedBar
                done={data.confirmed.done_count}
                active={data.confirmed.active_count}
                upcoming={data.confirmed.upcoming_count}
                pending={data.confirmed.pending_count}
              />
              <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px]">
                {data.confirmed.done_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-300"><Dot color="#22c55e" />{data.confirmed.done_count} done</span>
                )}
                {data.confirmed.active_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-amber-300"><Dot color="#f59e0b" />{data.confirmed.active_count} active</span>
                )}
                {data.confirmed.upcoming_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-violet-300"><Dot color="#a78bfa" />{data.confirmed.upcoming_count} upcoming</span>
                )}
                {data.confirmed.pending_count > 0 && (
                  <span className="inline-flex items-center gap-1 text-pink-300"><Dot color="#ec4899" />{data.confirmed.pending_count} pending</span>
                )}
              </div>
            </div>
          }
        >
          <ConfirmedDrawer data={data.confirmed as any} />
        </ExpandableStatCard>
      ),
      scanner: (
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
      ),
      insurance: (
        <ExpandableStatCard
          id="insurance"
          label="Insurance Claims"
          value={data.insurance.open_count}
          valueColor={data.insurance.open_count > 0 ? "amber" : "green"}
          accentColor={data.insurance.open_count > 0 ? "amber" : "green"}
          subtitle={
            data.insurance.open_count > 0
              ? `£${Math.round(data.insurance.open_amount_gbp).toLocaleString("en-GB")} at risk · ${data.insurance.settled_count_ytd} settled YTD`
              : data.insurance.total_count > 0
                ? `All clear · ${data.insurance.settled_count_ytd} settled YTD`
                : "No claims yet"
          }
          isExpanded={expandedId === "insurance"}
          onToggle={() => toggle("insurance")}
        >
          <InsuranceClaimsDrawer data={data.insurance} />
        </ExpandableStatCard>
      ),
      ongoing: (
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
      ),
      upcoming: (
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
      ),
      ai_boost: (
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
      ),
      out_of_stock: (
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
      ),
      denied_revenue: (
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
      ),
      missed_revenue: (
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
      ),
      vacation: (
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
      ),
      sell_reco: (
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
      ),
      inventory_worth: (
        <ExpandableStatCard
          id="inventory_worth"
          label="Inventory Worth"
          value={fmtGbp(data.inventory_worth.total_gbp)}
          valueColor="blue"
          accentColor="blue"
          subtitle="acquisition cost"
          isExpanded={expandedId === "inventory_worth"}
          onToggle={() => toggle("inventory_worth")}
        >
          <InventoryWorthDrawer data={data.inventory_worth} />
        </ExpandableStatCard>
      ),
      tax: (
        <ExpandableStatCard
          id="tax"
          label="UK Tax"
          value={data.tax.years.length > 0 ? fmtGbp(data.tax.years[0].estimated_tax) : "—"}
          valueColor="red"
          accentColor="red"
          subtitle={data.tax.years.length > 0 ? `${data.tax.years[0].year}` : "pending"}
          isExpanded={expandedId === "tax"}
          onToggle={() => toggle("tax")}
        >
          <TaxDrawer data={data.tax} />
        </ExpandableStatCard>
      ),
      business_intel: (
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
      ),
      category_volume: (
        <div
          className="stat-card"
          style={{
            background: "rgba(14,17,28,0.35)",
            backdropFilter: "blur(24px) saturate(1.5)",
            borderRadius: 16,
            padding: 16,
            borderLeft: "3px solid #a78bfa",
          }}
        >
          <CategoryVolumePieBody
            accountSlug={activeAccountSlug}
            expanded={catVolExpanded}
            onToggle={() => setCatVolExpanded((v) => !v)}
          />
        </div>
      ),
      // ── Phase 7: weekly_metrics insight widgets ──
      voluntary_deny:    <VoluntaryDenyHotList    accountSlug={activeAccountSlug} />,
      capacity_gap:      <CapacityGapAlert        accountSlug={activeAccountSlug} />,
      utilization:       <ItemUtilizationRanking  accountSlug={activeAccountSlug} />,
      below_minimum:     <BelowMinimumCounter     accountSlug={activeAccountSlug} />,
      revenue_sparkline: <WeeklyRevenueSparkline  accountSlug={activeAccountSlug} />,
    };
  }, [rawData, expandedId, activeAccountSlug, catVolExpanded]);

  if (!cards) return <StatsGridSkeleton />;

  const visibleIds = layout.statOrder.filter(
    (id) => cards[id] && !isStatHidden(id),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = layout.statOrder.indexOf(String(active.id));
    const newIndex = layout.statOrder.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    reorderStats(arrayMove(layout.statOrder, oldIndex, newIndex));
  };

  return (
    <>
      <CriticalAlerts
        conflicts={(rawData as any)?.conflicts ?? []}
        untracked={(rawData as any)?.untracked ?? { count: 0, total_value_gbp: 0, reservations: [] }}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={visibleIds} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4 mt-4">
          {visibleIds.map((id) => {
            const label = STAT_WIDGETS.find((w) => w.id === id)?.label ?? id;
            return (
              <EditableWidget
                key={id}
                id={id}
                kind="stat"
                label={label}
                className={HERO_IDS.has(id) ? "col-span-2" : ""}
              >
                {cards[id]}
              </EditableWidget>
            );
          })}
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}
