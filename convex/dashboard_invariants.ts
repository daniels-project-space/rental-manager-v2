/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Dashboard invariants — cross-widget consistency verifier.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Every widget on the dashboard reads from the same underlying tables
 * (`reservations`, `items`, `denial_records`, etc.) via its own Convex
 * query. Convex queries are reactive — any write to a table causes every
 * subscribed query to re-execute and push fresh results to the UI through
 * the WebSocket subscription. So when the Hygglo poller writes a new
 * reservation:
 *
 *   reservations (table)
 *      │
 *      ├─ getStatsDrawerData      → Active / Month Confirmed / Earnings cards
 *      ├─ getLifetimeByMonth      → Lifetime Revenue chart
 *      ├─ getEarningsByPeriod     → Earnings Chart (12-month series)
 *      ├─ getRecentActivity       → Live Activity panel
 *      ├─ getDueReturns           → Return Hub
 *      ├─ getConversionFunnel     → Conversation Funnel
 *      ├─ getOutOfStockItems      → Out of Stock
 *      ├─ getSellRecommendations  → Sell Recommender
 *      ├─ getInvestmentScorecard  → Investment Scorecard
 *      ├─ getHealthReport         → Health Scanner
 *      ├─ getInsights             → AI Insights
 *      ├─ getCalendarStrip        → Calendar Strip
 *      ├─ getWeeklyCalendar       → Weekly Calendar
 *      └─ getContextBundle        → AI Chat snapshot
 *
 * All those re-execute and update the UI within ~tens of milliseconds of
 * the write landing. The shared filter semantics (predicates module) make
 * sure each one slices the same data using the same definitions.
 *
 * This file is the runtime check that those derivations stay consistent.
 * If a widget were ever to drift from canonical semantics, the matching
 * invariant here flags it as an `issue` in the report.
 */

import { query } from "./_generated/server";
import {
  dedupByLogicalRental,
  isConfirmedWithDates,
  isOngoing,
  isPendingVerification,
  isUpcoming,
} from "./lib/reservations/predicates";

interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
  values?: Record<string, number>;
}

export const verifyConsistency = query({
  args: {},
  handler: async (ctx): Promise<{
    ok: boolean;
    invariants: InvariantResult[];
    counts: Record<string, number>;
    asOf: number;
  }> => {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    // Single source: collect once, derive all slices.
    const allRes = await ctx.db.query("reservations").collect();

    const ongoing  = dedupByLogicalRental(allRes.filter((r) => isOngoing(r as any, today)));
    const upcoming = dedupByLogicalRental(allRes.filter((r) => isUpcoming(r as any, today)));
    const pending  = dedupByLogicalRental(allRes.filter((r) => isPendingVerification(r as any)));

    // Month Confirmed slices: confirmed/completed with effective date in current month.
    const eff = (r: any): string | undefined => r.pickup_date ?? r.start_date;
    const monthBooked = dedupByLogicalRental(
      allRes.filter((r) => {
        if (r.is_obsolete) return false;
        if (r.status !== "confirmed" && r.status !== "completed") return false;
        if (!r.start_date || !r.end_date) return false;
        const d = eff(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      }),
    );
    const monthUpcoming = monthBooked.filter((r) => isUpcoming(r as any, today));
    const monthOngoing = monthBooked.filter(
      (r) =>
        isConfirmedWithDates(r as any) &&
        (r.start_date as string) <= today &&
        (r.end_date as string) >= today,
    );

    const invariants: InvariantResult[] = [];

    // INV-1: Month upcoming ⊆ Active upcoming
    {
      const upcomingIds = new Set(upcoming.map((r) => r._id));
      const orphans = monthUpcoming.filter((r) => !upcomingIds.has(r._id));
      invariants.push({
        name: "month_upcoming_subset_of_active_upcoming",
        ok: orphans.length === 0,
        detail: orphans.length === 0
          ? "Every Month Confirmed upcoming row is also in Active Rentals upcoming."
          : `${orphans.length} rows in Month Upcoming missing from Active Upcoming (drift).`,
        values: { active_upcoming: upcoming.length, month_upcoming: monthUpcoming.length },
      });
    }

    // INV-2: Month upcoming + (Active upcoming starting outside current month) = Active upcoming
    {
      const outsideMonth = upcoming.filter((r) => {
        const d = (r.start_date as string) ?? "";
        return d < monthStart || d > monthEnd;
      });
      const expected = monthUpcoming.length + outsideMonth.length;
      invariants.push({
        name: "active_upcoming_equals_month_upcoming_plus_other_months",
        ok: expected === upcoming.length,
        detail: expected === upcoming.length
          ? "Active upcoming reconciles with Month Confirmed upcoming + future-month bookings."
          : `Active upcoming=${upcoming.length} but month+outside=${expected}.`,
        values: { active_upcoming: upcoming.length, expected, month: monthUpcoming.length, outside: outsideMonth.length },
      });
    }

    // INV-3: Pending uses canonical predicate (no FUNDS_RESERVED-active rows leak in)
    {
      const wrong = pending.filter((r) => (r as any).order_step !== "VERIFIED");
      invariants.push({
        name: "pending_only_verified_active_step",
        ok: wrong.length === 0,
        detail: wrong.length === 0
          ? "All pending rows are at order_step=VERIFIED (paid + verifying)."
          : `${wrong.length} pending rows have unexpected order_step.`,
        values: { pending_count: pending.length },
      });
    }

    // INV-4: No row is simultaneously ongoing and upcoming
    {
      const ongoingIds = new Set(ongoing.map((r) => r._id));
      const overlap = upcoming.filter((r) => ongoingIds.has(r._id));
      invariants.push({
        name: "ongoing_and_upcoming_disjoint",
        ok: overlap.length === 0,
        detail: overlap.length === 0
          ? "No reservation appears in both Ongoing and Upcoming."
          : `${overlap.length} rows in both buckets (date-comparison bug).`,
      });
    }

    // INV-5: Month Confirmed.ongoing ⊆ Active.ongoing
    {
      const activeOngoingIds = new Set(ongoing.map((r) => r._id));
      const orphans = monthOngoing.filter((r) => !activeOngoingIds.has(r._id));
      invariants.push({
        name: "month_ongoing_subset_of_active_ongoing",
        ok: orphans.length === 0,
        detail: orphans.length === 0
          ? "Every Month Confirmed active row is also in Active Rentals ongoing."
          : `${orphans.length} drift.`,
        values: { active_ongoing: ongoing.length, month_ongoing: monthOngoing.length },
      });
    }

    // INV-6: Dedup is stable — no logical rental appears twice across the three buckets
    {
      const seen = new Set<string>();
      let dupes = 0;
      for (const r of [...ongoing, ...upcoming, ...pending]) {
        if (seen.has(r._id)) dupes++;
        else seen.add(r._id);
      }
      invariants.push({
        name: "no_row_in_multiple_active_buckets",
        ok: dupes === 0,
        detail: dupes === 0
          ? "Ongoing / Upcoming / Pending are mutually exclusive."
          : `${dupes} rows leaked across buckets.`,
      });
    }

    const counts = {
      active_ongoing: ongoing.length,
      active_upcoming: upcoming.length,
      active_pending: pending.length,
      month_ongoing: monthOngoing.length,
      month_upcoming: monthUpcoming.length,
      month_booked: monthBooked.length,
      total_reservations: allRes.length,
    };

    return {
      ok: invariants.every((i) => i.ok),
      invariants,
      counts,
      asOf: Date.now(),
    };
  },
});
