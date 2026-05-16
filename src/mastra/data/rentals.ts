/**
 * Rental / reservation / pipeline / briefing reads.
 *
 * Wave 1 established the data-layer shape; Wave 2 (Q3) threads an optional
 * `account` arg through every fn. Omitting `account` = combined across both
 * accounts (Wave 1 behaviour preserved exactly).
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";
import { validateAccount, type AccountSlug } from "./account-scope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function getPendingRentals(input?: {
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const [rawPending, syncState] = await Promise.all([
      convex.query(anyApi.reservations.listPending, {
        paginationOpts: { numItems: 100, cursor: null },
        accountSlug: accountSlug ?? undefined,
      }),
      getSyncState(),
    ]);
    // Paginated reader: surface first page + cursor for follow-up tool calls.
    const data = {
      ...(rawPending as { count: number; rentals: unknown[] }),
      _next: (rawPending as { isDone: boolean; continueCursor: string }).isDone
        ? null
        : (rawPending as { continueCursor: string }).continueCursor,
    };
    return wrap({ data, source: "convex.reservations.listPending", syncState });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getObsoleteOrders(input: {
  sinceDays?: number;
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const sinceTs = input.sinceDays
      ? Date.now() - input.sinceDays * 24 * 60 * 60 * 1000
      : undefined;
    const accountSlug = validateAccount(input.account);
    const [rawPage, syncState] = await Promise.all([
      convex.query(anyApi.reservations.listObsolete, {
        paginationOpts: { numItems: 100, cursor: null },
        sinceTs,
      }),
      getSyncState(),
    ]);
    const page = rawPage as {
      page: Array<{ account: string | null }>;
      isDone: boolean;
      continueCursor: string;
    };
    // Wave 2.5 follow-up: convex.reservations.listObsolete has no accountSlug
    // arg yet. Client-side filter is a stop-gap so tool surface is stable.
    const rows = accountSlug
      ? page.page.filter((row) => row.account === accountSlug)
      : page.page;
    const data = {
      rows,
      _next: page.isDone ? null : page.continueCursor,
    };
    return wrap({
      data,
      source: "convex.reservations.listObsolete",
      syncState,
      extraCaveats: accountSlug
        ? ["Account filter applied client-side (Wave 2.5 will push to server)."]
        : undefined,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getOrderPipeline(input?: {
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const [data, syncState] = await Promise.all([
      convex.query(anyApi.reservations.getPipelineCounts, {}),
      getSyncState(),
    ]);
    return wrap({
      data,
      source: "convex.reservations.getPipelineCounts",
      syncState,
      extraCaveats: accountSlug
        ? [
            "Pipeline counts span ALL accounts — convex.reservations.getPipelineCounts has no accountSlug arg yet (Wave 2.5 follow-up).",
          ]
        : undefined,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getDailyBriefing(input?: {
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const today = new Date().toISOString().slice(0, 10);
    const [stats, schedule, pending, activity, syncState] = await Promise.all([
      convex.query(anyApi.dashboard.getSummary, { accountSlug }),
      convex.query(anyApi.calendar.getCalendarStrip, {
        accountSlug,
        startDate: today,
        days: 3,
      }),
      convex.query(anyApi.reservations.listPending, {
        paginationOpts: { numItems: 100, cursor: null },
        accountSlug: accountSlug ?? undefined,
      }),
      convex.query(anyApi.reservations.getRecentActivity, {
        accountSlug,
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
