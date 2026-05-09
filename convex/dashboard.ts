import { query } from "./_generated/server";
import { v } from "convex/values";

const TODAY = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
};

/** BF-06: Use pickup_date if set, fall back to start_date for revenue attribution. */
const effectiveDate = (r: { pickup_date?: string; start_date?: string }): string | undefined =>
  r.pickup_date ?? r.start_date;

const isoWeekBounds = () => {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return {
    weekStart: mon.toISOString().slice(0, 10),
    weekEnd: sun.toISOString().slice(0, 10),
  };
};

const monthBounds = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    .toISOString()
    .slice(0, 10);
  return { monthStart: start, monthEnd: end };
};

/**
 * W02 Stats Grid — single query returning all stat-tile values.
 * accountSlug: "dbcinema" | "leo" | null (null = all accounts)
 */
export const getSummary = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const today = TODAY();
    const { weekStart, weekEnd } = isoWeekBounds();
    const { monthStart, monthEnd } = monthBounds();

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

    // Fetch all reservations — filtered by account if needed.
    // OPEN_INDEX_NEED: composite index (account_slug, status) would speed up active-by-account scan.
    let allReservations = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      allReservations = allReservations.filter(
        (r) => r.account_slug === accountSlug
      );
    }

    const active = allReservations.filter((r) => r.status === "confirmed");

    // Active rentals count
    const activeRentalsCount = active.length;

    // Due back today
    const pendingReturns = active.filter((r) => r.end_date === today).length;

    // Overdue: end_date < today AND still active
    const overdueCount = active.filter(
      (r) => r.end_date !== undefined && r.end_date < today
    ).length;

    // Monthly revenue: sum gross_paid_gbp where effective date (pickup_date ?? start_date) in current month (BF-06)
    const monthlyRevenue = allReservations
      .filter((r) => {
        const d = effectiveDate(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      })
      .reduce((sum, r) => sum + (r.gross_paid_gbp ?? 0), 0);

    // Weekly revenue (BF-06)
    const weeklyRevenue = allReservations
      .filter((r) => {
        const d = effectiveDate(r);
        return d !== undefined && d >= weekStart && d <= weekEnd;
      })
      .reduce((sum, r) => sum + (r.gross_paid_gbp ?? 0), 0);

    // Monthly bookings count (BF-06)
    const monthlyBookings = allReservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= monthStart && d <= monthEnd;
    }).length;

    // Avg rental value last 30d
    const last30 = allReservations.filter(
      (r) =>
        r.start_date !== undefined && r.start_date >= thirtyDaysAgoStr
    );
    const avgRentalValue =
      last30.length > 0
        ? last30.reduce((sum, r) => sum + (r.gross_paid_gbp ?? 0), 0) /
          last30.length
        : 0;

    // Items out: distinct item names across active reservations
    const itemNamesOut = new Set<string>();
    for (const r of active) {
      for (const item of r.items ?? []) {
        itemNamesOut.add(item.item_name);
      }
    }
    const itemsOut = itemNamesOut.size;

    // Available items: active status items, minus those currently out
    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter(
      (i) => i.status === "active" && !i.is_marketing_only
    );
    const availableItems = activeItems.filter(
      (i) => !itemNamesOut.has(i.name_canonical)
    ).length;

    // Denial rate last 30d
    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const accountRows = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug))
        .first();
      if (accountRows) {
        denials = denials.filter((d) => d.account_id === accountRows._id);
      }
    }
    const recentDenials = denials.filter(
      (d) => d.created_at >= thirtyDaysAgo.getTime()
    ).length;
    const denialRate =
      monthlyBookings + recentDenials > 0
        ? recentDenials / (monthlyBookings + recentDenials)
        : 0;

    // Hygglo sync: read from settings
    const settings = await ctx.db.query("settings").first();

    return {
      activeRentalsCount,
      pendingReturns,
      overdueCount,
      monthlyRevenue,
      weeklyRevenue,
      monthlyBookings,
      avgRentalValue,
      itemsOut,
      availableItems,
      denialRate,
      hyggloSendEnabled: settings?.ALLOW_HYGGLO_SEND ?? false,
    };
  },
});
