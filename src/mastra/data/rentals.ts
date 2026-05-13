/**
 * Rental / reservation / pipeline / briefing reads.
 *
 * All return values preserve EXACTLY the shape currently emitted by the
 * Mastra tools in dashboard-tools.ts. Behaviour change is forbidden in
 * Wave 1.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function getPendingRentals(): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.reservations.listPending, {}),
      getSyncState(),
    ]);
    return wrap({ data, source: "convex.reservations.listPending", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getObsoleteOrders(input: {
  sinceDays?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const sinceTs = input.sinceDays
      ? Date.now() - input.sinceDays * 24 * 60 * 60 * 1000
      : undefined;
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.reservations.listObsolete, { sinceTs }),
      getSyncState(),
    ]);
    return wrap({
      data,
      source: "convex.reservations.listObsolete",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getOrderPipeline(): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.reservations.getPipelineCounts, {}),
      getSyncState(),
    ]);
    return wrap({
      data,
      source: "convex.reservations.getPipelineCounts",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getDailyBriefing(): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const today = new Date().toISOString().slice(0, 10);
    const [stats, schedule, pending, activity, syncState] = await Promise.all([
      convex.query(anyApi.dashboard.getSummary, { accountSlug: null }),
      convex.query(anyApi.calendar.getCalendarStrip, {
        accountSlug: null,
        startDate: today,
        days: 3,
      }),
      convex.query(anyApi.reservations.listPending, {}),
      convex.query(anyApi.reservations.getRecentActivity, {
        accountSlug: null,
        limit: 5,
      }),
      getSyncState(),
    ]);
    const attentionNeeded: string[] = [];
    if ((pending as { count: number }).count > 0)
      attentionNeeded.push(
        (pending as { count: number }).count + " pending rental(s) need review",
      );
    if ((stats as { overdueCount: number }).overdueCount > 0)
      attentionNeeded.push(
        (stats as { overdueCount: number }).overdueCount + " overdue return(s)",
      );
    return wrap({
      data: {
        ok: true as const,
        date: today,
        summary: {
          today_revenue: (stats as { todayRevenue: number }).todayRevenue,
          monthly_revenue: (stats as { monthlyRevenue: number }).monthlyRevenue,
          projected: (stats as { projectedMonthRevenue: number })
            .projectedMonthRevenue,
          active_rentals: (stats as { activeRentalsCount: number })
            .activeRentalsCount,
          items_out: (stats as { itemsOut: number }).itemsOut,
        },
        schedule_next_3_days: schedule,
        pending_rentals: pending,
        recent_activity: activity,
        attention_needed: attentionNeeded,
      },
      source: "convex.dashboard+calendar+reservations",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}
