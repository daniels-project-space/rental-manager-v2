import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD date + HH:MM time string into a UTC ms timestamp. */
function parseTime(date: string, time: string): number {
  return new Date(`${date}T${time}:00Z`).getTime();
}

/**
 * 3-tier item name resolver.
 * Tier 1: exact canonical match (case-insensitive)
 * Tier 2: exact alias match (case-insensitive)
 * Tier 3: substring match — item_name ⊆ canonical OR canonical ⊆ item_name (min 5 chars)
 */
function findItemByName<T extends { name_canonical?: string; name?: string; aliases?: string[] }>(
  items: T[],
  name: string | undefined | null
): T | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  // Tier 1: exact canonical
  let m = items.find((i) => (i.name_canonical ?? i.name ?? "").toLowerCase() === lower);
  if (m) return m;
  // Tier 2: exact alias
  m = items.find((i) => (i.aliases ?? []).some((a) => a.toLowerCase() === lower));
  if (m) return m;
  // Tier 3: substring (only when name is reasonably long)
  if (lower.length >= 5) {
    m = items.find((i) => {
      const canon = (i.name_canonical ?? i.name ?? "").toLowerCase();
      return canon && (canon.includes(lower) || lower.includes(canon));
    });
    if (m) return m;
    m = items.find((i) =>
      (i.aliases ?? []).some((a) => {
        const al = a.toLowerCase();
        return al.length >= 5 && (al.includes(lower) || lower.includes(al));
      })
    );
    if (m) return m;
  }
  return null;
}

/**
 * Compute server-side progress percent for a rental chip.
 * Returns null if upcoming, 100 if completed, 1-99 while in progress.
 */
function chipProgress(
  start_date: string | undefined,
  end_date: string | undefined,
  pickup_time: string | null | undefined,
  return_time: string | null | undefined
): number | null {
  if (!start_date || !end_date) return null;
  const startMs = parseTime(start_date, pickup_time ?? "00:00");
  const endMs = parseTime(end_date, return_time ?? "23:59");
  const now = Date.now();
  if (now < startMs) return null; // upcoming — UI renders 0%
  if (now >= endMs) return 100;  // completed
  const pct = ((now - startMs) / (endMs - startMs)) * 100;
  return Math.max(1, Math.min(99, Math.round(pct)));
}

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

    // Item name + image lookup for holds AND for reservation image projection
    const holdItemIds = [...new Set(holds.map((h) => h.item_id).filter(Boolean))];
    const holdItemMap = new Map<string, string>();
    const holdItemImageMap = new Map<string, string | null>();
    await Promise.all(
      holdItemIds.map(async (iid) => {
        const item = await ctx.db.get(iid);
        if (item) {
          const i = item as { name_canonical?: string; name?: string; image_url?: string };
          holdItemMap.set(iid, i.name_canonical ?? i.name ?? String(iid).slice(-6));
          holdItemImageMap.set(iid, i.image_url ?? null);
        }
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

    // Item image lookup for reservations — use findItemByName (3-tier fuzzy resolver)
    const hasReservationItems = reservations.some((r) => (r.items ?? []).length > 0);
    type ItemDoc = { name_canonical?: string; name?: string; aliases?: string[]; image_url?: string };
    let allItemsForStrip: ItemDoc[] = [];
    if (hasReservationItems) {
      const rawItems = await ctx.db.query("items").collect();
      allItemsForStrip = rawItems.map((item) => item as ItemDoc);
    }

    /** Resolve image URL for the first item in a reservation's items array.
     *  Uses 3-tier fuzzy resolver: exact canonical → exact alias → substring. */
    function resolveFirstImageUrl(items: Array<{ item_name?: string }> | undefined): string | null {
      if (!items || items.length === 0) return null;
      for (const i of items) {
        const found = findItemByName(allItemsForStrip, i.item_name);
        if (found) return found.image_url ?? null;
      }
      return null;
    }

    return dates.map((date) => {
      // For same-day rentals (start === end === date), place in pickups only to avoid double-count.
      const pickups = reservations
        .filter((r) => r.start_date === date)
        .map((r) => {
          const rType = r as {
            pickup_time?: string | null;
            return_time?: string | null;
            pickup_method?: string | null;
            return_method?: string | null;
          };
          return {
            reservationId: r._id,
            itemNames: (r.items ?? []).map((i) => i.item_name),
            renterName: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
            accountSlug: r.account_slug,
            accountColor: r.account_slug === "leo" ? "purple" : "blue",
            status: r.status,
            pickupTime: rType.pickup_time ?? null,
            returnTime: rType.return_time ?? null,
            pickupMethod: rType.pickup_method ?? null,
            returnMethod: rType.return_method ?? null,
            imageUrl: resolveFirstImageUrl(r.items),
            progressPercent: chipProgress(r.start_date, r.end_date, rType.pickup_time, rType.return_time),
          };
        });

      // Exclude same-day rentals from returns (already counted in pickups above).
      const pickupIds = new Set(pickups.map((p) => p.reservationId));
      const returns = reservations
        .filter((r) => r.end_date === date && !pickupIds.has(r._id))
        .map((r) => {
          const rType = r as {
            pickup_time?: string | null;
            return_time?: string | null;
            pickup_method?: string | null;
            return_method?: string | null;
          };
          return {
            reservationId: r._id,
            itemNames: (r.items ?? []).map((i) => i.item_name),
            renterName: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
            accountSlug: r.account_slug,
            accountColor: r.account_slug === "leo" ? "purple" : "blue",
            status: r.status,
            pickupTime: rType.pickup_time ?? null,
            returnTime: rType.return_time ?? null,
            pickupMethod: rType.pickup_method ?? null,
            returnMethod: rType.return_method ?? null,
            imageUrl: resolveFirstImageUrl(r.items),
            progressPercent: chipProgress(r.start_date, r.end_date, rType.pickup_time, rType.return_time),
          };
        });

      const dayHolds = holds
        .filter((h) => h.date === date)
        .map((h) => ({
          holdId: h._id,
          itemId: h.item_id,
          itemName: holdItemMap.get(h.item_id) ?? String(h.item_id).slice(-6),
          holdItemName: holdItemMap.get(h.item_id) ?? null,
          holdRenterName: h.renter_name ?? (h.reservation_id ? holdRenterMap.get(h.reservation_id) ?? null : null),
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

/**
 * W08 Gantt Week — per-item rows with booking blocks.
 * New query (smaller blast radius than reshaping getWeeklyCalendar).
 * Returns items[] each with blocks[] covering the requested week.
 */
export const getGanttWeek = query({
  args: {
    weekStartIso: v.optional(v.string()), // YYYY-MM-DD; defaults to current Monday
    accountSlug: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { weekStartIso, accountSlug }) => {
    // Resolve weekStart — default to current Monday (UTC)
    let weekStart = weekStartIso;
    if (!weekStart) {
      const now = new Date();
      const day = now.getUTCDay(); // 0 = Sun
      const diffToMon = (day === 0 ? -6 : 1 - day);
      now.setUTCDate(now.getUTCDate() + diffToMon);
      weekStart = now.toISOString().slice(0, 10);
    }
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const weekEnd = dates[6];

    // --- Reservations overlapping the week ---
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", weekStart!))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= weekEnd
    );
    // Reservations starting before weekStart but ending inside / after it
    const allRes = await ctx.db.query("reservations").collect();
    for (const r of allRes) {
      if (
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.start_date < weekStart! &&
        r.end_date >= weekStart!
      ) {
        if (!reservations.find((x) => x._id === r._id)) reservations.push(r);
      }
    }
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(
      (r) => r.status === "confirmed" || r.status === "pending_review"
    );

    // --- Renter name lookup ---
    const renterIds = [...new Set(reservations.filter((r) => r.renter_id).map((r) => r.renter_id!))];
    const renterMap = new Map<string, string>();
    await Promise.all(
      renterIds.map(async (rid) => {
        const renter = await ctx.db.get(rid);
        if (renter) renterMap.set(rid, renter.display_name ?? "?");
      })
    );

    // --- Items table: load all for fuzzy resolver ---
    type GanttItemDoc = { _id?: string; name_canonical?: string; name?: string; aliases?: string[]; image_url?: string; account_slug?: string };
    const allItems = (await ctx.db.query("items").collect()) as GanttItemDoc[];

    // --- Collect unique items referenced across reservations ---
    // Key: item_name string (from reservation.items[])
    const itemNameSet = new Set<string>();
    for (const r of reservations) {
      for (const i of r.items ?? []) {
        if (i.item_name) itemNameSet.add(i.item_name);
      }
    }

    // Build per-item rows
    const itemRows = Array.from(itemNameSet).map((itemName) => {
      const iDoc = findItemByName(allItems, itemName) as GanttItemDoc | null;

      // Find reservations that include this item
      const matchingRes = reservations.filter((r) =>
        (r.items ?? []).some((i) => i.item_name === itemName)
      );

      const blocks = matchingRes.map((r) => {
        const rType = r as {
          pickup_time?: string | null;
          return_time?: string | null;
          pickup_method?: string | null;
          return_method?: string | null;
          order_step?: string | null;
        };
        return {
          reservation_id: r._id,
          start_date: r.start_date,
          end_date: r.end_date,
          renter_name: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
          order_step: rType.order_step ?? null,
          pickup_time: rType.pickup_time ?? null,
          return_time: rType.return_time ?? null,
          pickup_method: rType.pickup_method ?? null,
          return_method: rType.return_method ?? null,
          progress_percent: chipProgress(r.start_date, r.end_date, rType.pickup_time, rType.return_time),
        };
      });

      return {
        item_id: (iDoc?._id ?? null) as string | null,
        item_name: itemName,
        image_url: iDoc?.image_url ?? null,
        account_slug: iDoc?.account_slug ?? null,
        account_color: (iDoc?.account_slug === "leo" ? "purple" : "blue") as "purple" | "blue",
        blocks,
      };
    });

    return {
      weekStart,
      weekEnd,
      items: itemRows,
    };
  },
});

// ---------------------------------------------------------------------------
// Admin: one-shot backfill renter_name for holds that predate denormalization
// ---------------------------------------------------------------------------
export const backfillHoldRenterNames = mutation({
  args: {},
  handler: async (ctx) => {
    const holds = await ctx.db.query("calendar_holds").collect();
    let patched = 0;
    let skipped_already_set = 0;
    let missing_reservation = 0;
    for (const h of holds) {
      if (h.renter_name) { skipped_already_set++; continue; }
      if (!h.reservation_id) { missing_reservation++; continue; }
      const res = await ctx.db.get(h.reservation_id as Id<"reservations">);
      if (!res) { missing_reservation++; continue; }
      const renter_name = (res as any).renter_name as string | undefined;
      if (!renter_name) continue;
      await ctx.db.patch(h._id, { renter_name });
      patched++;
    }
    return { total: holds.length, patched, skipped_already_set, missing_reservation };
  },
});
