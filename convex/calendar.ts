import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import {
  isConfirmedWithDates,
  dedupByLogicalRental,
  logicalGroupIds,
  type ReservationRow,
} from "./lib/reservations/predicates";
import { reservationItemUnits, buildProductIndexMap, buildOverrideMap } from "./lib/reservations/itemUnits";
import {
  resolveImageForReservationItem,
  // bank-aware helpers below also rely on this type
  // (no extra imports needed — Phase 13.2)
  buildSharedImageBlacklist,
  pickRepresentativeItem,
  normaliseItemName,
} from "./lib/imageResolution";
import {
  displayPickupDate,
  displayReturnDate,
  londonToday,
} from "./lib/effectiveDates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD date + HH:MM time string into a UTC ms timestamp. */
function parseTime(date: string, time: string): number {
  return new Date(`${date}T${time}:00Z`).getTime();
}

/**
 * Calendar fetch-window padding (2026-06-02 consistency fix).
 *
 * The three calendar queries SCAN reservations by RAW start_date/end_date
 * overlap, then BUCKET by EFFECTIVE (negotiated) pickup/return dates. A rental
 * whose pickup_date/return_date was chat-shifted can land its effective dates
 * just outside the raw window and silently drop off the calendar while the
 * Active tab keeps it. The booking-time extractor only persists dates within ±3
 * days of start/end (extract_booking_times.ts:dateWithinTolerance), so a small
 * pad on each side guarantees the raw scan always covers the effective dates.
 * 7 days is a comfortable margin over the ±3-day tolerance.
 */
const CALENDAR_FETCH_PAD_DAYS = 7;

/**
 * Unified before-window lookback for prior reservations that started earlier but
 * overlap the requested window (no end_date index, so we bound the start_date
 * scan). Previously inconsistent across the 3 queries (strip = unbounded,
 * weekly/gantt = 90d), which let the calendar disagree with itself. 120 days
 * comfortably covers the longest realistic Hygglo rentals while keeping the
 * indexed scan bounded.
 */
const CALENDAR_LOOKBACK_DAYS = 120;

/** Add (or subtract) whole days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
function shiftIsoDate(ymd: string, deltaDays: number): string {
  return new Date(Date.parse(ymd) + deltaDays * 86400000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Effective return date for a reservation: prefer AI-extracted `return_date`
 * (e.g. extension agreed in chat) over the raw Hygglo `end_date`. end_date
 * remains canonical for invoicing/utilization and is never mutated; this
 * helper is for calendar bucketing/display only.
 *
 * Consolidated into convex/lib/effectiveDates.ts (`displayReturnDate`); this is
 * a thin local alias kept for the existing call sites. Behavior is identical:
 * displayReturnDate returns "" (falsy) where this used to return undefined, and
 * every call site treats both the same (`=== date` and `if (!ret)`).
 */
const effectiveReturnDate = displayReturnDate;

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

// Match against the Hygglo title for fallback paths (resolved_items hasn't run
// yet, or item-name-keyed caller). Tries exact first, then a normalised match
// (canonical/alias drift) so the tier-0 product_id bank is actually reached
// when the caller passes a canonical name that differs from the raw Hygglo
// title (Phase 5.2). Normalisation mirrors imageResolution.normaliseItemName.
function productIdForItemNameInReservation(
  r: { hygglo_items?: Array<{ name?: string; product_id?: number }> },
  itemName: string,
): number | null {
  const hi = r.hygglo_items ?? [];
  // 1. exact (cheapest, preserves prior behavior)
  let hit = hi.find((h) => h?.name === itemName);
  if (hit?.product_id != null) return hit.product_id;
  // 2. normalised — collapses case / separators / leading "Nx " multipliers so
  //    a canonical name resolves to its raw-title product_id.
  const target = normaliseItemName(itemName);
  if (target) {
    hit = hi.find((h) => normaliseItemName(h?.name ?? "") === target);
    if (hit?.product_id != null) return hit.product_id;
  }
  return null;
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
    // Pad the RAW-date scan window so a rental whose effective (negotiated)
    // pickup/return was chat-shifted up to the ±3-day extractor tolerance still
    // gets fetched, then bucketed by effective dates below (FIX 4).
    const scanStart = shiftIsoDate(startDate, -CALENDAR_FETCH_PAD_DAYS);
    const scanEnd = shiftIsoDate(endDate, CALENDAR_FETCH_PAD_DAYS);

    // Reservations overlapping the (padded) date range
    // OPEN_INDEX_NEED: index by (start_date, end_date) range for efficient overlap scan.
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", scanStart))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= scanEnd
    );
    // Also include reservations that started before the range but end inside / after it.
    // V1 parity: a rental shows on every day between pickup and return ("away" days).
    {
      // W1a: indexed scan — reservations whose start_date is BEFORE the padded
      // window, bounded by the unified 120-day lookback (was unbounded here,
      // 90d in weekly/gantt — FIX 4 unifies them). Residual end_date>=scanStart
      // filter retained (not in index).
      const lookbackStart = shiftIsoDate(startDate, -CALENDAR_LOOKBACK_DAYS);
      const allRes = await ctx.db
        .query("reservations")
        .withIndex("by_start_date", (q) =>
          q.gte("start_date", lookbackStart).lt("start_date", scanStart))
        .collect();
      for (const r of allRes) {
        if (
          r.end_date !== undefined &&
          r.end_date >= scanStart
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
      (reservations as ReservationRow[]).filter(
        (r) => isConfirmedWithDates(r),
      ),
    ) as typeof reservations;

    // Collapse contiguous same-renter/same-item bookings into ONE spanning
    // reservation so the strip shows a single pickup (span start) + single
    // return (span end), with interior days as "away" — no interior handover
    // chips. Other strip computations (renter map, holds) keep raw `reservations`.
    const stripGroupId = logicalGroupIds(reservations as unknown as ReservationRow[]);
    const stripByGroup = new Map<string, typeof reservations>();
    for (const r of reservations) {
      const gid = stripGroupId.get(r._id) ?? r._id;
      const arr = stripByGroup.get(gid);
      if (arr) arr.push(r);
      else stripByGroup.set(gid, [r]);
    }
    const mergedReservations = Array.from(stripByGroup.values()).map((members) => {
      if (members.length === 1) return members[0];
      const sorted = members
        .slice()
        .sort((a, b) => displayPickupDate(a).localeCompare(displayPickupDate(b)));
      const startM = sorted[0];
      let endM = sorted[0];
      for (const m of sorted) if (displayReturnDate(m) > displayReturnDate(endM)) endM = m;
      const grossSum = members.reduce(
        (s, m) => s + ((m as { gross_paid_gbp?: number | null }).gross_paid_gbp ?? 0),
        0,
      );
      return {
        ...startM,
        pickup_date: displayPickupDate(startM),
        return_date: displayReturnDate(endM),
        end_date: endM.end_date,
        pickup_time: startM.pickup_time,
        return_time: endM.return_time,
        pickup_method: (startM as { pickup_method?: string | null }).pickup_method,
        return_method: (endM as { return_method?: string | null }).return_method,
        gross_paid_gbp: grossSum,
      };
    }) as typeof reservations;

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

    // Calendar holds for the date range.
    // Phase 7e (2026-05-24): cross-account path now uses by_date indexed
    // range scan instead of a full-table .collect(). Calendar_holds has
    // ~50-200 rows per day × N days; the window is bounded by `days` arg.
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
      const rangeHolds = await ctx.db
        .query("calendar_holds")
        .withIndex("by_date", (q) => q.gte("date", startDate).lte("date", endDate))
        .collect();
      holds.push(...rangeHolds);
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
          // image_hints are keyed by the RAW Hygglo item_name; the canonical
          // renderName often doesn't match (and items.image_url can be empty),
          // leaving the tile image-less even though the listing photo exists
          // (e.g. Jamie Hannaford / Dan). Mirror getGanttWeek: on a placeholder,
          // retry with the reservation's raw item_name(s) and take the first hit.
          let imageUrl = resolved.url;
          if (!imageUrl || resolved.source === "placeholder") {
            for (const raw of r.items ?? []) {
              if (!raw.item_name) continue;
              const alt = resolveImageForReservationItem({
                imageHints,
                itemName: raw.item_name,
                itemsTableEntry: doc,
                resolvedConfidence: undefined,
                sharedBlacklist,
                bankByProduct: bankByProductStrip,
                accountSlug: (r as { account_slug?: string }).account_slug ?? null,
                productId: productIdForItemNameInReservation(r as Parameters<typeof productIdForItemNameInReservation>[0], raw.item_name),
              });
              if (alt.source !== "placeholder" && alt.url) {
                imageUrl = alt.url;
                break;
              }
            }
          }
          return {
            itemId: entry.item_id,
            name: renderName,
            imageUrl,
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
      // Representative item: NAME + IMAGE from the SAME item so they agree.
      // buildItems already resolved each tile's image; treat a null tile url as
      // a placeholder so the first item WITH an image wins (tie-break = order),
      // falling back to items[0]'s name when every tile is image-less.
      const rep = pickRepresentativeItem(
        items.map((it) => ({ name: it.name, imageUrl: it.imageUrl, productId: null })),
        (it) =>
          it.imageUrl
            ? { url: it.imageUrl, source: "hint_exact", confidence: 1 }
            : { url: null, source: "placeholder", confidence: 0 },
      );
      const firstImage = rep.imageUrl ?? distinctImages[0] ?? null;
      const imageAlt = rep.name || items[0]?.name || "";
      // Pass 11e (2026-05-25) — dropped 3 unused fields:
      //   - progressPercent: frontend re-computes locally (CalendarStrip.tsx:486)
      //   - netToOwnerGbp + multi_item_image_urls: type-declared but never read
      // Saves ~250 bytes per chip × ~5 chips/day × 7 days = ~9KB per response.
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
        // Effective (negotiated) pickup date for progress + placement alignment;
        // falls back to start_date. Raw start_date retained above for display.
        pickupDate: displayPickupDate(r) || (r.start_date ?? null),
        endDate: r.end_date ?? null,
        returnDate: (r as { return_date?: string | null }).return_date ?? r.end_date ?? null,
        pickupTime: rType.pickup_time ?? null,
        returnTime: rType.return_time ?? null,
        pickupMethod: rType.pickup_method ?? null,
        returnMethod: rType.return_method ?? null,
        grossPaidGbp: rType.gross_paid_gbp ?? null,
        notes: rType.notes ?? null,
        imageUrl: firstImage,
        // Alt text from the SAME item that provided imageUrl (Phase 5.1) so the
        // overlay no longer hardcodes items[0].name against a different image.
        imageAlt,
      };
    }

    return dates.map((date) => {
      // For same-day rentals (start === end === date), place in pickups only to avoid double-count.
      // Placement honors the negotiated pickup date (EITHER direction) so a
      // rental whose pickup_date differs from the Hygglo start_date moves to the
      // negotiated day.
      const pickups = mergedReservations
        .filter((r) => displayPickupDate(r) === date)
        .map((r) => buildChip(r, "pickup"));

      // Exclude same-day rentals from returns (already counted in pickups above).
      const pickupIds = new Set(pickups.map((p) => p.reservationId));
      const returns = mergedReservations
        .filter((r) => effectiveReturnDate(r) === date && !pickupIds.has(r._id))
        .map((r) => buildChip(r, "return"));

      // "Away" — rental days strictly between pickup and return (V1 parity).
      // Uses effective pickup + return dates so AI-negotiated rentals stay
      // "away" between the negotiated days instead of the raw Hygglo dates.
      const dayIds = new Set([
        ...pickups.map((p) => p.reservationId),
        ...returns.map((r) => r.reservationId),
      ]);
      const away = mergedReservations
        .filter((r) => {
          const pick = displayPickupDate(r);
          if (!pick) return false;
          const ret = effectiveReturnDate(r);
          if (!ret) return false;
          return pick < date && ret > date && !dayIds.has(r._id);
        })
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
    // Pad the RAW-date scan so chat-shifted effective dates (±3-day extractor
    // tolerance) are always fetched, then bucketed by effective dates (FIX 4).
    const scanStart = shiftIsoDate(weekStartDate, -CALENDAR_FETCH_PAD_DAYS);
    const scanEnd = shiftIsoDate(weekEnd, CALENDAR_FETCH_PAD_DAYS);

    // Reservations starting within the (padded) week
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", scanStart))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= scanEnd
    );

    // Also include reservations that started before weekStart but end during/after it.
    // No end_date index, so use the unified 120-day start_date lookback (FIX 4 —
    // was 90d here, unbounded in the strip). Long rentals exceeding 120 days are
    // vanishingly rare on Hygglo; the bounded scan stays cheap.
    const overlapStart = shiftIsoDate(weekStartDate, -CALENDAR_LOOKBACK_DAYS);
    const priorRes = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) =>
        q.gte("start_date", overlapStart).lt("start_date", scanStart),
      )
      .collect();
    for (const r of priorRes) {
      if (
        r.end_date !== undefined &&
        r.end_date >= scanStart
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
      (reservations as ReservationRow[]).filter(
        (r) => isConfirmedWithDates(r),
      ),
    ) as typeof reservations;

    // Phase 7e (2026-05-24): cross-account path uses by_date indexed range
    // scan instead of full-table .collect().
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
      const rangeHolds = await ctx.db
        .query("calendar_holds")
        .withIndex("by_date", (q) => q.gte("date", weekStartDate).lte("date", weekEnd))
        .collect();
      holds.push(...rangeHolds);
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
          .filter((r) => {
            const pick = displayPickupDate(r);
            if (!pick) return false;
            const ret = effectiveReturnDate(r);
            if (!ret) return false;
            return pick <= date && ret >= date;
          })
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
            const effRet = effectiveReturnDate(r);
            const effPick = displayPickupDate(r);
            const isPickupDay = effPick === date;
            const isReturnDay = effRet === date && effPick !== date;
            const isAwayDay = effPick < date && (effRet ?? "") > date;
            return {
              reservationId: r._id,
              itemNames,
              items,
              accountSlug: r.account_slug,
              status: r.status,
              startDate: r.start_date,
              endDate: r.end_date,
              returnDate: (r as { return_date?: string | null }).return_date ?? r.end_date ?? null,
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
                effPick,
                effRet,
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
    // Resolve weekStart — default to the Monday of the current London-business
    // week so the Gantt anchors on the same calendar day as the Active tab /
    // strip (which now also use London). Date-string arithmetic off
    // londonToday() avoids UTC drift near London midnight.
    let weekStart = weekStartIso;
    if (!weekStart) {
      const todayLdn = londonToday(); // YYYY-MM-DD in Europe/London
      const anchor = new Date(`${todayLdn}T00:00:00Z`);
      const day = anchor.getUTCDay(); // 0 = Sun (UTC-parsed date-only string)
      const diffToMon = (day === 0 ? -6 : 1 - day);
      anchor.setUTCDate(anchor.getUTCDate() + diffToMon);
      weekStart = anchor.toISOString().slice(0, 10);
    }
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const weekEnd = dates[6];
    // Pad the RAW-date scan so chat-shifted effective dates (±3-day extractor
    // tolerance) are always fetched, then bucketed by effective dates (FIX 4).
    const scanStart = shiftIsoDate(weekStart!, -CALENDAR_FETCH_PAD_DAYS);
    const scanEnd = shiftIsoDate(weekEnd, CALENDAR_FETCH_PAD_DAYS);

    // --- Reservations overlapping the (padded) week ---
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", scanStart))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= scanEnd
    );
    // Reservations starting before weekStart but ending inside / after it.
    // Unified 120-day lookback (FIX 4 — see getCalendarStrip / getWeeklyCalendar).
    const overlapStart = shiftIsoDate(weekStart!, -CALENDAR_LOOKBACK_DAYS);
    const priorRes = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) =>
        q.gte("start_date", overlapStart).lt("start_date", scanStart),
      )
      .collect();
    for (const r of priorRes) {
      if (
        r.end_date !== undefined &&
        r.end_date >= scanStart
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
      (reservations as ReservationRow[]).filter(
        (r) => isConfirmedWithDates(r),
      ),
    ) as typeof reservations;

    // Logical-rental grouping: contiguous same-renter + same-item bookings share
    // one group_id so the frontend can render them as ONE continuous bar.
    const ganttGroupIds = logicalGroupIds(reservations as unknown as ReservationRow[]);

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
        // Treat a placeholder as a MISS so scanning continues to the next
        // matching reservation (a later row may carry a real hint/bank image).
        if (out.source !== "placeholder" && out.url) {
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
        if (out2.source !== "placeholder" && out2.url) {
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
        // Bar placement honors the negotiated pickup date (the frontend Gantt
        // positions the bar from start_date → end_date), so emit the effective
        // pickup as start_date. Hygglo raw start_date is retained for invoicing
        // elsewhere; this surface is display-only.
        const effPick = displayPickupDate(r);
        return {
          reservation_id: r._id,
          logical_group_id: ganttGroupIds.get(r._id) ?? r._id,
          start_date: effPick || r.start_date,
          end_date: r.end_date,
          return_date: (r as { return_date?: string | null }).return_date ?? r.end_date ?? null,
          renter_name: r.renter_id ? renterMap.get(r.renter_id as string) ?? "?" : "?",
          // Account comes from the RESERVATION (the items table doc has no
          // account_slug, so the item-row account_color is always blue). The
          // frontend groups by reservation and colours from this.
          account_slug: (r as { account_slug?: string | null }).account_slug ?? null,
          order_step: rType.order_step ?? null,
          pickup_time: rType.pickup_time ?? null,
          return_time: rType.return_time ?? null,
          pickup_method: rType.pickup_method ?? null,
          return_method: rType.return_method ?? null,
          progress_percent: chipProgress(
            effPick || r.start_date,
            effectiveReturnDate(r),
            rType.pickup_time,
            rType.return_time,
          ),
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

/**
 * W08 Gantt search — inventory-driven search + per-day availability.
 *
 * Called ONLY while a search is active (debounced). The reservation.items[]
 * names are raw Hygglo listing titles that don't reliably resolve to inventory
 * rows, so we search the canonical `items` table instead (name / slug / tag),
 * compute per-day free units from the single-source-of-truth primitive
 * isItemUnitAvailable, and map matched items → the rentals that touch them via
 * the calendar_holds ledger (holds carry item_id + reservation_id). The client
 * uses `reservationIds` to filter the Gantt bars to "rentals that relate".
 *
 * Reads scale with matched items only, so the default unsearched calendar pays
 * nothing.
 */
export const searchCalendarInventory = query({
  args: {
    query: v.string(),
    weekStartIso: v.optional(v.string()),
    accountSlug: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { query: rawQuery, weekStartIso, accountSlug }) => {
    const q = rawQuery.trim().toLowerCase();
    // Mirror getGanttWeek's week resolution EXACTLY so day-columns align.
    let weekStart = weekStartIso;
    if (!weekStart) {
      const todayLdn = londonToday();
      const anchor = new Date(`${todayLdn}T00:00:00Z`);
      const day = anchor.getUTCDay();
      const diffToMon = day === 0 ? -6 : 1 - day;
      anchor.setUTCDate(anchor.getUTCDate() + diffToMon);
      weekStart = anchor.toISOString().slice(0, 10);
    }
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const weekEnd = dates[6];
    if (!q) return { weekStart, dates, items: [], reservationIds: [] as string[] };

    // Search the canonical inventory by name / slug / tag (kind, sub_kind,
    // category) and aliases. Substring, case-insensitive.
    const allItems = await ctx.db.query("items").collect();
    // Units out on repair (open cases) reduce effective stock here too.
    const REPAIR_TERMINAL = new Set(["added_to_revenue", "denied"]);
    const repairByItem = new Map<string, number>();
    for (const c of await ctx.db.query("insurance_claims").collect()) {
      const cc = c as { stage?: string; status?: string; repair_item_ids?: string[] };
      const st = cc.stage ?? (cc.status === "denied" ? "denied" : cc.status === "settled" ? "added_to_revenue" : "case_opened");
      if (REPAIR_TERMINAL.has(st)) continue;
      for (const iid of (cc.repair_item_ids ?? [])) repairByItem.set(iid as string, (repairByItem.get(iid as string) ?? 0) + 1);
    }
    // Normalised, token-AND search: every query word must appear somewhere in
    // the item's searchable text, ignoring spaces/punctuation and treating
    // standalone roman numerals as arabic. So "blazar 45", "fx 3", "fx3",
    // "fx iii" and "fx III" all match "Blazar Remus 45mm" / "Sony FX3".
    const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
    const norm = (s: string): string =>
      s
        .toLowerCase()
        .replace(/\b(viii|vii|iii|ix|iv|vi|ii|v|x|i)\b/g, (m) => ROMAN[m] ?? m)
        .replace(/[^a-z0-9]+/g, "");
    const qTokens = q.split(/\s+/).map((t) => norm(t)).filter((t) => t.length > 0);
    // Forgiving relevance search: an item matches if ENOUGH of the query words
    // appear in its searchable text — not necessarily ALL — so "remus set" and
    // "remus lenses" still find the Remus lenses, and "dji rs3 pro" still finds
    // the gimbal. Longer (more distinctive) word matches rank higher. EVERY
    // catalogue item is searchable; ones not actually owned (marketing-only /
    // zero qty) are flagged below and carry no availability.
    const matchedScored = qTokens.length === 0
      ? []
      : allItems
          .map((it) => {
            const hay = norm(
              [it.name_canonical, it.name_input, it.slug, it.kind, it.sub_kind, it.category_v1, ...(it.aliases ?? [])]
                .filter((f): f is string => typeof f === "string")
                .join(" "),
            );
            let score = 0;
            for (const tok of qTokens) if (hay.includes(tok)) score += tok.length;
            return { it, score };
          })
          .filter((x) => x.score >= 2);
    // Keep only the most-relevant tier (best score) so extra/common words like
    // "set", "pro" or "lenses" do not drag in unrelated items.
    const maxScore = matchedScored.reduce((m, x) => Math.max(m, x.score), 0);
    const matched = matchedScored.filter((x) => x.score === maxScore).map((x) => x.it);

    if (matched.length === 0) return { weekStart, dates, items: [], reservationIds: [] as string[] };
    const matchedById = new Map(matched.map((it) => [String(it._id), it]));

    // --- Confirmed rentals overlapping the week (IDENTICAL scan to
    // getGanttWeek, so availability counts EXACTLY the rentals whose bars the
    // calendar draws). Booked UNITS come from expanded_items.qty via the same
    // commitment map the dashboard's double-booking detector uses — NOT the
    // calendar_holds ledger, which collapses to one row per (item, day) and so
    // can never represent >1 unit out (the bug: 3 FX3 booked showed as 1). ---
    const scanStart = shiftIsoDate(weekStart!, -CALENDAR_FETCH_PAD_DAYS);
    const scanEnd = shiftIsoDate(weekEnd, CALENDAR_FETCH_PAD_DAYS);
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (qb) => qb.gte("start_date", scanStart))
      .collect();
    reservations = reservations.filter(
      (r) => r.start_date !== undefined && r.start_date <= scanEnd,
    );
    const overlapStart = shiftIsoDate(weekStart!, -CALENDAR_LOOKBACK_DAYS);
    const priorRes = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (qb) =>
        qb.gte("start_date", overlapStart).lt("start_date", scanStart),
      )
      .collect();
    for (const r of priorRes) {
      if (
        r.end_date !== undefined &&
        r.end_date >= scanStart &&
        !reservations.find((x) => x._id === r._id)
      ) {
        reservations.push(r);
      }
    }
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    const confirmed = dedupByLogicalRental(
      (reservations as ReservationRow[]).filter((r) => isConfirmedWithDates(r)),
    ) as typeof reservations;

    // Units committed per item per date. Built from EFFECTIVE occupancy dates
    // (pickup → return_date ?? end_date) — the same dates the bars use — NOT the
    // raw start/end the shared buildCommitmentMap uses: Hygglo rows often carry
    // raw_end = pickup-day with a later negotiated return_date, so a raw-date
    // count drops the extension days (a unit out Thu via return_date but
    // raw_end=Wed went uncounted → "1 free" when fully booked). Prefer
    // expanded_items.qty (kit-decomposed) > resolved_items.qty; only matched
    // items are summed.
    const productIndex = buildProductIndexMap(await ctx.db.query("hygglo_product_index").collect());
    const overrideMap = buildOverrideMap(await ctx.db.query("listing_resolution_override").collect());
    const commit = new Map<string, number>();
    // Time-aware occupancy per (item, date): the clamped [a,b) "HH:MM" window the
    // unit is actually out on that date. Lets us tell the owner an item that
    // reads "0 free" by date is in fact free FROM a mid-day return time.
    const intervals = new Map<string, Array<{ a: string; b: string; qty: number }>>();
    for (const r of confirmed) {
      const effPick = displayPickupDate(r) || r.start_date;
      const effRet = (r.return_date ?? r.end_date) ?? effPick;
      if (!effPick || !effRet) continue;
      const pickT = ((r as { pickup_time?: string }).pickup_time) || "00:00";
      const retT = ((r as { return_time?: string }).return_time) || "23:59";
      const lines = Array.from(reservationItemUnits(r, productIndex, overrideMap))
        .filter(([id]) => matchedById.has(id))
        .map(([id, qty]) => ({ id, qty }));
      if (lines.length === 0) continue;
      for (const d of dates) {
        if (d < effPick || d > effRet) continue;
        const a = d === effPick ? pickT : "00:00";
        const b = d === effRet ? retT : "23:59";
        for (const ln of lines) {
          commit.set(`${ln.id}|${d}`, (commit.get(`${ln.id}|${d}`) ?? 0) + ln.qty);
          const key = `${ln.id}|${d}`;
          const arr = intervals.get(key);
          if (arr) arr.push({ a, b, qty: ln.qty });
          else intervals.set(key, [{ a, b, qty: ln.qty }]);
        }
      }
    }

    // Time-aware day availability. `free` = units free for the WHOLE day (total −
    // PEAK concurrent occupancy), so a same-day handover (one returns at 10:15,
    // the next is picked up at 12:40) no longer double-books the date — the naive
    // date-sum would report 0 free when a unit is genuinely free all day.
    // `free_from` = when free === 0 but a unit opens up for the REST of the day
    // (a late return), the "HH:MM" from which >=1 is available. Occupancy only
    // rises at pickups, so peak is found by sampling each start instant.
    const dayAvail = (
      ivs: Array<{ a: string; b: string; qty: number }> | undefined,
      total: number,
    ): { peak: number; free: number; free_from: string | null } => {
      if (!ivs || ivs.length === 0) return { peak: 0, free: total, free_from: null };
      const occAt = (t: string) =>
        ivs.reduce((s, iv) => s + (iv.a <= t && t < iv.b ? iv.qty : 0), 0);
      const starts = Array.from(new Set(["00:00", ...ivs.map((iv) => iv.a)]));
      let peak = 0;
      for (const t of starts) {
        const o = occAt(t);
        if (o > peak) peak = o;
      }
      const free = Math.max(0, total - peak);
      if (free >= 1) return { peak, free, free_from: null };
      // Fully booked at the peak — find the earliest boundary time from which it
      // stays free for the remainder of the day.
      const bounds = Array.from(new Set([...ivs.map((iv) => iv.a), ...ivs.map((iv) => iv.b)])).sort();
      for (const T of bounds) {
        const stillFree =
          total - occAt(T) >= 1 &&
          starts.filter((u) => u >= T).every((u) => total - occAt(u) >= 1);
        if (stillFree) return { peak, free, free_from: T };
      }
      return { peak, free, free_from: null };
    };

    // Reservations that touch a matched item this week → the bar-filter set.
    const reservationIds = new Set<string>();
    for (const r of confirmed) {
      if (!r.start_date) continue;
      const rangeEnd = (r.return_date ?? r.end_date) ?? r.start_date;
      if (r.start_date > weekEnd || rangeEnd < weekStart!) continue; // no overlap
      const heldIds = reservationItemUnits(r, productIndex, overrideMap);
      if (Array.from(heldIds.keys()).some((id) => matchedById.has(id))) {
        reservationIds.add(String(r._id));
      }
    }

    // Per matched item: per-day free = qty − committed units (owner blackout
    // ⇒ 0). Only surface items that actually have a rental in the visible week.
    const itemsRaw = await Promise.all(
      matched.map(async (it) => {
        const idStr = String(it._id);
        const owned = !it.is_marketing_only && (it.qty ?? 0) > 0;
        if (!owned) {
          // Listed in the catalogue but not actually owned (marketing-only /
          // zero qty). Surfaced so search finds everything, but it has no real
          // availability — the UI shows it as "not owned".
          return {
            item_id: idStr,
            name: it.name_canonical,
            kind: it.kind ?? null,
            qty: it.qty ?? 0,
            image_url: it.image_url ?? null,
            availability: [] as { date: string; free: number; total: number; booked: number; free_from: string | null }[],
            owned: false,
          };
        }
        const total = Math.max(0, (it.qty ?? 0) - (repairByItem.get(String(it._id)) ?? 0));
        const blackouts = await ctx.db
          .query("owner_unavailability")
          .withIndex("by_item_date", (qb) => qb.eq("item_id", it._id))
          .collect();
        const availability = dates.map((date) => {
          const black = blackouts.some((b) => b.start_date <= date && b.end_date >= date);
          const da = dayAvail(intervals.get(`${idStr}|${date}`), total);
          const free = black ? 0 : da.free;
          // Owner blackout always wins → no partial-time availability.
          // Suppress the 23:59 end-of-day artefact (a missing return_time
          // defaults there) — that is not a meaningful "free from" moment.
          const free_from =
            !black && da.free <= 0 && da.free_from && da.free_from < "23:59"
              ? da.free_from
              : null;
          return { date, free, total, booked: black ? total : da.peak, free_from };
        });
        return {
          item_id: idStr,
          name: it.name_canonical,
          kind: it.kind ?? null,
          qty: total,
          image_url: it.image_url ?? null,
          availability,
          owned: true,
        };
      }),
    );
    const items = itemsRaw.filter((x): x is NonNullable<typeof x> => x !== null);
    // Owned items first (real availability), preserving relevance order within.
    items.sort((a, b) => (a.owned === b.owned ? a.name.localeCompare(b.name) : a.owned ? -1 : 1));

    items.sort((a, b) => a.name.localeCompare(b.name));
    return { weekStart, dates, items, reservationIds: [...reservationIds] };
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
