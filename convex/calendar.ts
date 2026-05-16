import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  isConfirmedWithDates,
  dedupByLogicalRental,
  type ReservationRow,
} from "./lib/reservations/predicates";
import {
  resolveImageForReservationItem,
  // bank-aware helpers below also rely on this type
  // (no extra imports needed — Phase 13.2)
  buildSharedImageBlacklist,
} from "./lib/imageResolution";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD date + HH:MM time string into a UTC ms timestamp. */
function parseTime(date: string, time: string): number {
  return new Date(`${date}T${time}:00Z`).getTime();
}

/**
 * 2-tier item name resolver.
 * Tier 1: exact canonical match (case-insensitive)
 * Tier 2: exact alias match (case-insensitive)
 *
 * NOTE: Tier-3 substring fallback was removed (Phase 8 fix per FIX-DESIGN 4.4).
 * Substring matching caused cross-item collisions (e.g. "70-200" matched both
 * lens variants), producing wrong-image bugs. The new image-resolution path
 * (`resolveImageForReservationItem`) supersedes name-based image lookups by
 * relying on per-reservation `image_hints` populated at poll time.
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

// Phase 13.2: strict-index helper. Matches expanded_items[i].item_id to
// hygglo_items[i].product_id when array lengths align. Returns null on
// mismatch (kit listings) — safer than guessing, never produces a wrong image.
function productIdForItemInReservation(
  r: { hygglo_items?: Array<{ product_id?: number }>; expanded_items?: Array<{ item_id?: string }>; resolved_items?: Array<{ item_id?: string }> },
  itemId: string,
): number | null {
  const hi = r.hygglo_items ?? [];
  const ei = r.expanded_items ?? r.resolved_items ?? [];
  if (hi.length === 0 || ei.length === 0) return null;
  if (hi.length !== ei.length) return null;
  const idx = ei.findIndex((x) => x?.item_id === itemId);
  if (idx < 0) return null;
  return hi[idx]?.product_id ?? null;
}

// Exact-string match against the raw Hygglo title for fallback paths
// (resolved_items hasn't run yet, or item-name-keyed caller).
function productIdForItemNameInReservation(
  r: { hygglo_items?: Array<{ name?: string; product_id?: number }> },
  itemName: string,
): number | null {
  const hi = r.hygglo_items ?? [];
  const hit = hi.find((h) => h?.name === itemName);
  return hit?.product_id ?? null;
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
    // Also include reservations that started before the range but end inside / after it.
    // V1 parity: a rental shows on every day between pickup and return ("away" days).
    {
      // W1a: indexed scan — only reservations whose start_date is BEFORE the
      // window. Residual end_date>=startDate filter retained (not in index).
      const allRes = await ctx.db
        .query("reservations")
        .withIndex("by_start_date", (q) => q.lt("start_date", startDate))
        .collect();
      for (const r of allRes) {
        if (
          r.end_date !== undefined &&
          r.end_date >= startDate
        ) {
          if (!reservations.find((x) => x._id === r._id)) reservations.push(r);
        }
      }
    }
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    // Calendar mirrors the Active Rentals tab: only confirmed bookings with
    // dates set, deduped per logical rental. Drops pending_review (awaiting
    // payment), obsolete, cancelled, declined.
    reservations = dedupByLogicalRental(
      (reservations as ReservationRow[]).filter(isConfirmedWithDates),
    ) as typeof reservations;

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

    // ── Inventory lookup ─────────────────────────────────────────────────────
    // Load every item once so we can:
    //  1. Look up canonical name + image by Id<"items"> (when LLM resolver has run)
    //  2. Fall back to fuzzy name matching for raw Hygglo strings (resolver pending)
    type ItemDoc = {
      _id?: string;
      name_canonical?: string;
      name?: string;
      aliases?: string[];
      image_url?: string;
    };
    // Load items table once (used for both name-resolution fallback AND for
    // the shared-image blacklist guard inside the resolver).
    const rawItemsForStrip = await ctx.db.query("items").collect();
    const allItemsForStrip: ItemDoc[] = rawItemsForStrip.map((item) => item as ItemDoc);
    const itemById = new Map<string, ItemDoc>();
    for (const it of allItemsForStrip) {
      if (it._id) itemById.set(it._id, it);
    }
    const sharedBlacklist = buildSharedImageBlacklist(allItemsForStrip);

    // Phase 13.2: listing_images bank — product_id-keyed canonical photos.
    const listingImagesAllStrip = await ctx.db.query("listing_images").collect();
    const bankByProductStrip = new Map<string, string>();
    for (const li of listingImagesAllStrip) {
      bankByProductStrip.set(`${li.account_slug}#${li.product_id}`, li.image_url);
    }

    type ChipItem = {
      itemId: string | null;
      name: string;
      imageUrl: string | null;
      qty: number;
      resolved: boolean;
    };

    /** Build per-item list for the booking card.
     *  Prefers resolved_items (LLM-resolved, deconstructs sets); falls back to
     *  raw Hygglo strings + fuzzy match while the resolver catches up.
     *  Image resolution goes through `resolveImageForReservationItem` which
     *  consults the reservation's per-item `image_hints` BEFORE falling back
     *  to the (potentially globally-shared) items.image_url. */
    function buildItems(r: Doc<"reservations">): ChipItem[] {
      const imageHints = ((r as { image_hints?: Array<{
        item_name: string;
        item_name_normalised: string;
        image_url: string;
        source: "hygglo_per_item" | "hygglo_order" | "manual_override";
        captured_at: number;
      }> }).image_hints) ?? [];

      const resolved = (r as { resolved_items?: Array<{
        item_id: string;
        item_name_canonical: string;
        confidence: number;
      }> }).resolved_items;

      if (resolved && resolved.length > 0) {
        // Aggregate duplicates from the resolver (same item appearing twice)
        const counts = new Map<string, { entry: { item_id: string; item_name_canonical: string; confidence: number }; qty: number }>();
        for (const ri of resolved) {
          const existing = counts.get(ri.item_id);
          if (existing) existing.qty += 1;
          else counts.set(ri.item_id, { entry: ri, qty: 1 });
        }
        return Array.from(counts.values()).map(({ entry, qty }) => {
          const doc = itemById.get(entry.item_id);
          const renderName = doc?.name_canonical ?? entry.item_name_canonical;
          const resolved = resolveImageForReservationItem({
            imageHints,
            itemName: renderName,
            itemsTableEntry: doc,
            resolvedConfidence: entry.confidence,
            sharedBlacklist,
            bankByProduct: bankByProductStrip,
            accountSlug: (r as { account_slug?: string }).account_slug ?? null,
            productId: productIdForItemInReservation(r as Parameters<typeof productIdForItemInReservation>[0], entry.item_id),
          });
          return {
            itemId: entry.item_id,
            name: renderName,
            imageUrl: resolved.url,
            qty,
            resolved: true,
          };
        });
      }

      // Fallback: raw Hygglo strings + fuzzy image lookup. These titles can be
      // SEO-slop multi-item descriptions; we keep them so the booking still
      // surfaces something while the resolver runs (max 5 min lag).
      // Dedup by item_id so a single item appearing twice collapses to one
      // tile with qty=2; rows with NULL item_id (no fuzzy match) stay separate
      // so they render as distinct placeholder tiles instead of collapsing
      // under the `undefined` key.
      const fallbackTiles: ChipItem[] = [];
      const fallbackById = new Map<string, ChipItem>();
      for (const i of r.items ?? []) {
        const found = findItemByName(allItemsForStrip, i.item_name);
        const resolvedImg = resolveImageForReservationItem({
          imageHints,
          itemName: i.item_name,
          itemsTableEntry: found ?? undefined,
          resolvedConfidence: undefined,
          sharedBlacklist,
          bankByProduct: bankByProductStrip,
          accountSlug: (r as { account_slug?: string }).account_slug ?? null,
          productId: productIdForItemNameInReservation(r as Parameters<typeof productIdForItemNameInReservation>[0], i.item_name),
        });
        const tile: ChipItem = {
          itemId: found?._id ?? null,
          name: i.item_name,
          imageUrl: resolvedImg.url,
          qty: i.qty ?? 1,
          resolved: false,
        };
        if (found?._id) {
          const existing = fallbackById.get(found._id);
          if (existing) {
            existing.qty += tile.qty;
          } else {
            fallbackById.set(found._id, tile);
            fallbackTiles.push(tile);
          }
        } else {
          // No item_id — keep as a distinct placeholder tile, do NOT collapse
          // multiple null-id rows into a single "undefined" key.
          fallbackTiles.push(tile);
        }
      }
      return fallbackTiles;
    }

    /** Build a rich chip for one reservation on a specific day. */
    function buildChip(r: Doc<"reservations">, kind: "pickup" | "return" | "away") {
      const rType = r as {
        pickup_time?: string | null;
        return_time?: string | null;
        pickup_method?: string | null;
        return_method?: string | null;
        gross_paid_gbp?: number | null;
        net_to_owner_gbp?: number | null;
        notes?: string | null;
        renter_name?: string | null;
      };
      const renterName =
        rType.renter_name ??
        (r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?");
      const items = buildItems(r);
      // Per-tile multi-image: collect distinct image URLs (preserve order),
      // capped at 4 for the chip’s 1/2/4 grid layout. Single `imageUrl` is
      // retained for backward-compat (existing UI reads it as a fallback).
      const distinctImages: string[] = [];
      const seenImages = new Set<string>();
      for (const it of items) {
        if (it.imageUrl && !seenImages.has(it.imageUrl)) {
          seenImages.add(it.imageUrl);
          distinctImages.push(it.imageUrl);
          if (distinctImages.length >= 4) break;
        }
      }
      const firstImage = distinctImages[0] ?? null;
      return {
        reservationId: r._id,
        kind,
        items,
        renterName,
        accountSlug: r.account_slug,
        accountColor: r.account_slug === "leo" ? "purple" : "blue",
        status: r.status,
        orderStep: (r as { order_step?: string | null }).order_step ?? null,
        startDate: r.start_date ?? null,
        endDate: r.end_date ?? null,
        pickupTime: rType.pickup_time ?? null,
        returnTime: rType.return_time ?? null,
        pickupMethod: rType.pickup_method ?? null,
        returnMethod: rType.return_method ?? null,
        grossPaidGbp: rType.gross_paid_gbp ?? null,
        netToOwnerGbp: rType.net_to_owner_gbp ?? null,
        notes: rType.notes ?? null,
        imageUrl: firstImage,
        multi_item_image_urls: distinctImages.length > 1 ? distinctImages : null,
        progressPercent: chipProgress(r.start_date, r.end_date, rType.pickup_time, rType.return_time),
      };
    }

    return dates.map((date) => {
      // For same-day rentals (start === end === date), place in pickups only to avoid double-count.
      const pickups = reservations
        .filter((r) => r.start_date === date)
        .map((r) => buildChip(r, "pickup"));

      // Exclude same-day rentals from returns (already counted in pickups above).
      const pickupIds = new Set(pickups.map((p) => p.reservationId));
      const returns = reservations
        .filter((r) => r.end_date === date && !pickupIds.has(r._id))
        .map((r) => buildChip(r, "return"));

      // "Away" — rental days strictly between pickup and return (V1 parity).
      const dayIds = new Set([
        ...pickups.map((p) => p.reservationId),
        ...returns.map((r) => r.reservationId),
      ]);
      const away = reservations
        .filter(
          (r) =>
            r.start_date !== undefined &&
            r.end_date !== undefined &&
            r.start_date < date &&
            r.end_date > date &&
            !dayIds.has(r._id),
        )
        .map((r) => buildChip(r, "away"));

      const dayHolds = holds
        // Drop status==="completed" holds — they're historical leftovers from
        // past rentals, not active calendar blockers.
        .filter((h) => h.date === date && h.status !== "completed")
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

      return { date, pickups, returns, away, holds: dayHolds };
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
        // Fix E: log overbooking for diagnostics (dedup key unchanged pending Daniel's decision)
        console.warn(
          `[upsertHoldsBatch] Overbooking detected: item_id=${h.item_id} date=${h.date} ` +
          `existing_res=${existing.reservation_id} new_res=${h.reservation_id}; replacing`
        );
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
    // Calendar mirrors the Active Rentals tab — confirmed bookings with
    // dates, deduped per logical rental.
    reservations = dedupByLogicalRental(
      (reservations as ReservationRow[]).filter(isConfirmedWithDates),
    ) as typeof reservations;

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

    // Renter name lookup (denorm + fallback to renters table).
    const renterIds = [...new Set(reservations.filter((r) => r.renter_id).map((r) => r.renter_id!))];
    const renterMap = new Map<string, string>();
    await Promise.all(
      renterIds.map(async (rid) => {
        const renter = await ctx.db.get(rid);
        if (renter) renterMap.set(rid, renter.display_name ?? "?");
      }),
    );

    // Items table for per-item image lookups (fuzzy by name).
    const allItemsWeekly = await ctx.db.query("items").collect();
    const sharedBlacklistWeekly = buildSharedImageBlacklist(allItemsWeekly);

    type WeeklyImageHint = {
      item_name: string;
      item_name_normalised: string;
      image_url: string;
      source: "hygglo_per_item" | "hygglo_order" | "manual_override";
      captured_at: number;
    };

    // Phase 13.2: listing_images bank — product_id-keyed canonical photos.
    const listingImagesAllWeekly = await ctx.db.query("listing_images").collect();
    const bankByProductWeekly = new Map<string, string>();
    for (const li of listingImagesAllWeekly) {
      bankByProductWeekly.set(`${li.account_slug}#${li.product_id}`, li.image_url);
    }

    function imageForItem(
      itemName: string | undefined,
      hints: WeeklyImageHint[],
      r?: { hygglo_items?: Array<{ name?: string; product_id?: number }>; account_slug?: string },
    ): string | null {
      if (!itemName) return null;
      const it = findItemByName(allItemsWeekly, itemName);
      const productId = r ? productIdForItemNameInReservation(r, itemName) : null;
      return resolveImageForReservationItem({
        imageHints: hints,
        itemName,
        itemsTableEntry: it ?? undefined,
        resolvedConfidence: undefined,
        sharedBlacklist: sharedBlacklistWeekly,
        bankByProduct: bankByProductWeekly,
        accountSlug: r?.account_slug ?? null,
        productId,
      }).url;
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
              r.end_date >= date,
          )
          .map((r) => {
            const rType = r as {
              pickup_time?: string | null;
              return_time?: string | null;
              pickup_method?: string | null;
              return_method?: string | null;
              notes?: string | null;
              gross_paid_gbp?: number | null;
              net_to_owner_gbp?: number | null;
              renter_name?: string | null;
            };
            const itemNames = (r.items ?? []).map((i) => i.item_name);
            const hintsForR = ((r as { image_hints?: WeeklyImageHint[] }).image_hints) ?? [];
            const items = (r.items ?? []).map((i) => ({
              name: i.item_name,
              imageUrl: imageForItem(i.item_name, hintsForR),
              qty: i.qty ?? 1,
            }));
            const isPickupDay = r.start_date === date;
            const isReturnDay = r.end_date === date && r.start_date !== date;
            const isAwayDay = r.start_date! < date && r.end_date! > date;
            return {
              reservationId: r._id,
              itemNames,
              items,
              accountSlug: r.account_slug,
              status: r.status,
              startDate: r.start_date,
              endDate: r.end_date,
              renterName:
                rType.renter_name ??
                (r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?"),
              pickupTime: rType.pickup_time ?? null,
              returnTime: rType.return_time ?? null,
              pickupMethod: rType.pickup_method ?? null,
              returnMethod: rType.return_method ?? null,
              notes: rType.notes ?? null,
              grossPaidGbp: rType.gross_paid_gbp ?? null,
              netToOwnerGbp: rType.net_to_owner_gbp ?? null,
              dayType: isPickupDay
                ? ("pickup" as const)
                : isReturnDay
                ? ("return" as const)
                : isAwayDay
                ? ("away" as const)
                : ("pickup" as const),
              progressPercent: chipProgress(
                r.start_date,
                r.end_date,
                rType.pickup_time,
                rType.return_time,
              ),
            };
          }),
        holds: holds
          .filter((h) => h.date === date && h.status !== "completed")
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
    // Calendar mirrors the Active Rentals tab — confirmed bookings with
    // dates, deduped per logical rental.
    reservations = dedupByLogicalRental(
      (reservations as ReservationRow[]).filter(isConfirmedWithDates),
    ) as typeof reservations;

    // --- Renter name lookup ---
    const renterIds = [...new Set(reservations.filter((r) => r.renter_id).map((r) => r.renter_id!))];
    const renterMap = new Map<string, string>();
    await Promise.all(
      renterIds.map(async (rid) => {
        const renter = await ctx.db.get(rid);
        if (renter) renterMap.set(rid, renter.display_name ?? "?");
      })
    );

    // --- Items table: load all for fuzzy resolver + shared-blacklist guard ---
    type GanttItemDoc = { _id?: string; name_canonical?: string; name?: string; aliases?: string[]; image_url?: string; account_slug?: string };
    const allItems = (await ctx.db.query("items").collect()) as GanttItemDoc[];
    const sharedBlacklistGantt = buildSharedImageBlacklist(allItems);

    // Phase 13.2: listing_images bank — product_id-keyed canonical photos.
    const listingImagesAllGantt = await ctx.db.query("listing_images").collect();
    const bankByProductGantt = new Map<string, string>();
    for (const li of listingImagesAllGantt) {
      bankByProductGantt.set(`${li.account_slug}#${li.product_id}`, li.image_url);
    }

    type GanttImageHint = {
      item_name: string;
      item_name_normalised: string;
      image_url: string;
      source: "hygglo_per_item" | "hygglo_order" | "manual_override";
      captured_at: number;
    };

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

      // Image source: walk matching reservations and pick the first hit from
      // the resolver — the resolver itself prefers per-reservation hints over
      // the (potentially globally-shared) items.image_url.
      // Look up the canonical name from the items table for the resolver query;
      // hint matching uses the verbatim Hygglo string as well as the canonical.
      let resolvedImageUrl: string | null = null;
      for (const r of matchingRes) {
        const hints = ((r as { image_hints?: GanttImageHint[] }).image_hints) ?? [];
        const tileName = iDoc?.name_canonical ?? iDoc?.name ?? itemName;
        const rAny = r as Parameters<typeof productIdForItemNameInReservation>[0] & { account_slug?: string };
        const pidByItemName = productIdForItemNameInReservation(rAny, itemName);
        const out = resolveImageForReservationItem({
          imageHints: hints,
          itemName: tileName,
          itemsTableEntry: iDoc ?? undefined,
          resolvedConfidence: undefined,
          sharedBlacklist: sharedBlacklistGantt,
          bankByProduct: bankByProductGantt,
          accountSlug: rAny.account_slug ?? null,
          productId: pidByItemName,
        });
        if (out.url) {
          resolvedImageUrl = out.url;
          break;
        }
        // If the canonical name didn't hit, try the raw item_name as a hint key
        const out2 = resolveImageForReservationItem({
          imageHints: hints,
          itemName,
          itemsTableEntry: iDoc ?? undefined,
          resolvedConfidence: undefined,
          sharedBlacklist: sharedBlacklistGantt,
          bankByProduct: bankByProductGantt,
          accountSlug: rAny.account_slug ?? null,
          productId: pidByItemName,
        });
        if (out2.url) {
          resolvedImageUrl = out2.url;
          break;
        }
      }

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
        image_url: resolvedImageUrl,
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
