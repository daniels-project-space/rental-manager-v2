import { mutation, query } from "./_generated/server";
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

    // Item name lookup for holds (join items table)
    const holdItemIds = [...new Set(holds.map((h) => h.item_id).filter(Boolean))];
    const itemNameMap = new Map<string, string>();
    await Promise.all(
      holdItemIds.map(async (iid) => {
        const item = await ctx.db.get(iid);
        if (item) itemNameMap.set(iid, (item as { name_canonical?: string; name?: string }).name_canonical ?? (item as { name_canonical?: string; name?: string }).name ?? String(iid).slice(-6));
      })
    );

    // Renter name lookup for holds (via reservation)
    const holdReservationIds = [...new Set(holds.map((h) => h.reservation_id).filter(Boolean) as string[])];
    const holdRenterMap = new Map<string, string>();
    await Promise.all(
      holdReservationIds.map(async (rid) => {
        const res = await ctx.db.get(rid as Parameters<typeof ctx.db.get>[0]);
        if (res) {
          const r = res as { renter_id?: string };
          if (r.renter_id) {
            const renter = await ctx.db.get(r.renter_id as Parameters<typeof ctx.db.get>[0]);
            if (renter) holdRenterMap.set(rid, (renter as { display_name?: string }).display_name ?? "?");
          }
        }
      })
    );

    return dates.map((date) => {
      // For same-day rentals (start === end === date), place in pickups only to avoid double-count.
      const pickups = reservations
        .filter((r) => r.start_date === date)
        .map((r) => ({
          reservationId: r._id,
          itemNames: (r.items ?? []).map((i) => i.item_name),
          renterName: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
          accountSlug: r.account_slug,
          status: r.status,
        }));

      // Exclude same-day rentals from returns (already counted in pickups above).
      const pickupIds = new Set(pickups.map((p) => p.reservationId));
      const returns = reservations
        .filter((r) => r.end_date === date && !pickupIds.has(r._id))
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
          itemName: itemNameMap.get(h.item_id) ?? String(h.item_id).slice(-6),
          reservationId: h.reservation_id,
          renterName: h.renter_name ?? (h.reservation_id ? holdRenterMap.get(h.reservation_id) ?? "?" : "?"),
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
// Batch insert/update calendar holds
export const upsertHoldsBatch = mutation({
  args: {
    holds: v.array(v.object({
      item_id: v.id("items"),
      date: v.string(),                   // YYYY-MM-DD
      reservation_id: v.id("reservations"),
      account_slug: v.string(),
      status: v.union(v.literal("confirmed"), v.literal("completed")),
      qty_held: v.optional(v.number()),
      renter_name: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { holds }) => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    for (const h of holds) {
      // by_item_date index: ["item_id", "date"]
      const existing = await ctx.db
        .query("calendar_holds")
        .withIndex("by_item_date", q => q.eq("item_id", h.item_id).eq("date", h.date))
        .first();
      if (!existing) {
        await ctx.db.insert("calendar_holds", {
          item_id: h.item_id,
          reservation_id: h.reservation_id,
          account_slug: h.account_slug,
          date: h.date,
          status: h.status,
          qty_held: h.qty_held,
          renter_name: h.renter_name,
          created_at: Date.now(),
        });
        inserted++;
      } else if (existing.reservation_id === h.reservation_id) {
        // same reservation, idempotent — only update if status/qty changed
        if (existing.status !== h.status || existing.qty_held !== h.qty_held || existing.renter_name !== h.renter_name) {
          await ctx.db.patch(existing._id, {
            status: h.status,
            qty_held: h.qty_held,
            renter_name: h.renter_name,
          });
          updated++;
        } else {
          skipped++;
        }
      } else {
        // different reservation — last-writer wins for now (could collect overbookings later)
        await ctx.db.patch(existing._id, {
          reservation_id: h.reservation_id,
          status: h.status,
          qty_held: h.qty_held,
          renter_name: h.renter_name,
        });
        updated++;
      }
    }
    return { inserted, updated, skipped, total: holds.length };
  },
});

// Delete holds for reservations that have moved to cancelled/obsolete
export const deleteStaleHolds = mutation({
  args: {
    reservation_ids: v.array(v.id("reservations")),
  },
  handler: async (ctx, { reservation_ids }) => {
    let deleted = 0;
    for (const rid of reservation_ids) {
      const holds = await ctx.db
        .query("calendar_holds")
        .withIndex("by_reservation", q => q.eq("reservation_id", rid))
        .collect();
      for (const h of holds) {
        await ctx.db.delete(h._id);
        deleted++;
      }
    }
    return { deleted };
  },
});

// Diagnostic query — count of holds (used by verification step in Wave 3)
export const getHoldsCount = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("calendar_holds").collect();
    const byAccount: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const h of all) {
      const acc = h.account_slug ?? "unknown";
      byAccount[acc] = (byAccount[acc] ?? 0) + 1;
      const st = h.status ?? "unknown";
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }
    return { total: all.length, byAccount, byStatus };
  },
});

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
