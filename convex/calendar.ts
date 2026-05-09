import { query } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";

/**
 * W06 5-Day Calendar Strip
 * Returns reservations and holds for [startDate, startDate + days - 1]
 */
export const getCalendarStrip = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    startDate: v.string(), // YYYY-MM-DD
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, startDate, days }) => {
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const endDate = dates[dates.length - 1];

    // Reservations overlapping the date range
    // OPEN_INDEX_NEED: index by (start_date, end_date) range for efficient overlap scan.
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", startDate))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= endDate
    );
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    // Renter lookups
    const renterIds = [
      ...new Set(
        reservations.filter((r) => r.renter_id).map((r) => r.renter_id!)
      ),
    ];
    const renterMap = new Map<string, string>();
    await Promise.all(
      renterIds.map(async (rid) => {
        const renter = await ctx.db.get(rid);
        if (renter) renterMap.set(rid, renter.display_name ?? "?");
      })
    );

    // Calendar holds for the date range
    const holds: Doc<"calendar_holds">[] = [];
    if (accountSlug) {
      for (const date of dates) {
        const dayHolds = await ctx.db
          .query("calendar_holds")
          .withIndex("by_account_date", (q) =>
            q.eq("account_slug", accountSlug).eq("date", date)
          )
          .collect();
        holds.push(...dayHolds);
      }
    } else {
      // OPEN_INDEX_NEED: index by (date) alone for account-agnostic date range scan.
      const allHolds = await ctx.db.query("calendar_holds").collect();
      holds.push(
        ...allHolds.filter(
          (h) => h.date !== undefined && h.date >= startDate && h.date <= endDate
        )
      );
    }

    return dates.map((date) => {
      const pickups = reservations
        .filter((r) => r.start_date === date)
        .map((r) => ({
          reservationId: r._id,
          itemNames: (r.items ?? []).map((i) => i.item_name),
          renterName: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
          accountSlug: r.account_slug,
          status: r.status,
        }));

      const returns = reservations
        .filter((r) => r.end_date === date)
        .map((r) => ({
          reservationId: r._id,
          itemNames: (r.items ?? []).map((i) => i.item_name),
          renterName: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
          accountSlug: r.account_slug,
          status: r.status,
        }));

      const dayHolds = holds
        .filter((h) => h.date === date)
        .map((h) => ({
          holdId: h._id,
          itemId: h.item_id,
          reservationId: h.reservation_id,
          accountSlug: h.account_slug,
          status: h.status,
        }));

      return { date, pickups, returns, holds: dayHolds };
    });
  },
});

/**
 * W08 Weekly Calendar Overlay
 */
export const getWeeklyCalendar = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    weekStartDate: v.string(), // YYYY-MM-DD (Monday)
  },
  handler: async (ctx, { accountSlug, weekStartDate }) => {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartDate);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const weekEnd = dates[6];

    // Reservations starting within the week
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", weekStartDate))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= weekEnd
    );

    // Also include reservations that started before weekStart but end during/after it
    // OPEN_INDEX_NEED: index on end_date to efficiently fetch reservations ending >= weekStart.
    const allRes = await ctx.db.query("reservations").collect();
    for (const r of allRes) {
      if (
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.start_date < weekStartDate &&
        r.end_date >= weekStartDate
      ) {
        if (!reservations.find((x) => x._id === r._id)) {
          reservations.push(r);
        }
      }
    }

    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(
      (r) => r.status === "confirmed" || r.status === "pending_review"
    );

    const holds: Doc<"calendar_holds">[] = [];
    if (accountSlug) {
      for (const date of dates) {
        const dayHolds = await ctx.db
          .query("calendar_holds")
          .withIndex("by_account_date", (q) =>
            q.eq("account_slug", accountSlug).eq("date", date)
          )
          .collect();
        holds.push(...dayHolds);
      }
    } else {
      const allHolds = await ctx.db.query("calendar_holds").collect();
      holds.push(
        ...allHolds.filter(
          (h) =>
            h.date !== undefined &&
            h.date >= weekStartDate &&
            h.date <= weekEnd
        )
      );
    }

    return {
      days: dates.map((date) => ({
        date,
        reservations: reservations
          .filter(
            (r) =>
              r.start_date !== undefined &&
              r.end_date !== undefined &&
              r.start_date <= date &&
              r.end_date >= date
          )
          .map((r) => ({
            reservationId: r._id,
            itemNames: (r.items ?? []).map((i) => i.item_name),
            accountSlug: r.account_slug,
            status: r.status,
            startDate: r.start_date,
            endDate: r.end_date,
          })),
        holds: holds
          .filter((h) => h.date === date)
          .map((h) => ({
            holdId: h._id,
            itemId: h.item_id,
            accountSlug: h.account_slug,
            status: h.status,
          })),
      })),
    };
  },
});
