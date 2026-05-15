import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  dedupByLogicalRental,
  effectiveDate,
  isConfirmedWithDates,
  isLive,
  isOngoing,
  isPaidWithV1Legacy,
  isPendingVerification,
  isUpcoming,
  netOf,
} from "./lib/reservations/predicates";
import {
  resolveImageForReservationItem,
  buildSharedImageBlacklist,
  type ImageHint,
} from "./lib/imageResolution";

// ─────────────────────────────────────────────────────────────────────────────
// Shared item-tile builder (Phase 9 / FIX-DESIGN §4.5)
// Lifted out of getStatsDrawerData / getNextRentals to eliminate the previous
// duplication. Routes every image through resolveImageForReservationItem so
// catalogue-level cross-pollination (Pass-1 root cause) cannot leak into
// dashboard widgets.
// ─────────────────────────────────────────────────────────────────────────────
type TileSourceItem = {
  item_id?: string | null;
  item_name_canonical: string;
  qty?: number;
};
type ResolvedItemEntry = {
  item_id?: string | null;
  item_name_canonical: string;
  qty?: number;
  confidence?: number;
};
export type ItemTile = {
  name: string;
  image_url: string | null;
  qty: number;
};

/**
 * Build the per-tile array for one reservation row using the
 * resolveImageForReservationItem resolver. Null/undefined item_ids are NOT
 * collapsed into a single bucket — they are emitted as separate placeholder
 * tiles keyed by `__null_<index>` so unresolved items render individually
 * rather than disappearing into one merged row.
 */
export function buildItemTilesShared(args: {
  reservation: {
    image_hints?: ImageHint[] | null;
    expanded_items?: Array<TileSourceItem> | null;
    resolved_items?: Array<ResolvedItemEntry> | null;
    photos_urls?: string[] | null;
  };
  itemImageById: Map<string, { name: string; image_url: string | null }>;
  sharedBlacklist: Set<string>;
}): ItemTile[] {
  const { reservation, itemImageById, sharedBlacklist } = args;
  const imageHints: ImageHint[] = reservation.image_hints ?? [];
  const resolved: ResolvedItemEntry[] = reservation.resolved_items ?? [];

  // PASS-5 fix (2026-05-15): The Pass-4 round-robin fallback CAUSED visual
  // duplication on the live dashboard. When a rental had M items but only
  // N<M product photos (e.g. Isiaq Adeyemi: 3 items, 1 photo → 3 identical
  // tiles; Christian Asante: 4 items, 1 photo → 4 identical tiles), every
  // unresolved item got assigned the SAME repeating photo from the round
  // robin. User reported "items duplicating multiple times" because tiles
  // looked identical even though `alt` text differed.
  //
  // We now keep `image_url = null` when the per-item resolver returns null.
  // The frontend (ActiveDrawer.tsx, CalendarStrip, etc.) already renders a
  // distinctive 3-letter abbreviation placeholder for null URLs, which is
  // unique per item name and avoids the duplicate-photo illusion. This is
  // closer to v1 behavior (v1 showed "Item × qty" text with no per-item
  // image; the abbrev tile is a strict UX improvement).
  //
  // photos_urls is still received in args for forward compat / debugging
  // but is intentionally NOT used to manufacture fallback tile images.
  // (referenced once for typecheck — the field is preserved in the API.)
  void reservation.photos_urls;

  // Confidence lookup keyed by item_id (only resolved entries have it).
  const confidenceById = new Map<string, number>();
  for (const ri of resolved) {
    if (ri.item_id != null && typeof ri.confidence === "number") {
      confidenceById.set(ri.item_id, ri.confidence);
    }
  }

  // Prefer expanded_items (bundle-decomposed). Fall back to resolved_items
  // when the resolver hasn't run yet on this reservation.
  const expanded: TileSourceItem[] = reservation.expanded_items ?? [];
  const source: TileSourceItem[] =
    expanded.length > 0
      ? expanded
      : resolved.map((x) => ({
          item_id: x.item_id ?? null,
          item_name_canonical: x.item_name_canonical,
          qty: x.qty ?? 1,
        }));

  // Dedup by item_id; null/undefined item_ids get a unique synthetic key per
  // row so they stay as distinct placeholder tiles instead of merging into
  // one bogus "undefined" bucket.
  const counts = new Map<string, ItemTile>();
  source.forEach((x, idx) => {
    const hasItemId = x.item_id != null && x.item_id !== "";
    const dedupKey = hasItemId ? (x.item_id as string) : `__null_${idx}`;
    const inv = hasItemId ? itemImageById.get(x.item_id as string) : undefined;
    const name = inv?.name ?? x.item_name_canonical;

    const itemsTableEntry = inv ? { image_url: inv.image_url } : undefined;
    const resolvedConfidence = hasItemId
      ? confidenceById.get(x.item_id as string)
      : undefined;

    const resolved = resolveImageForReservationItem({
      imageHints,
      itemName: name,
      itemsTableEntry,
      resolvedConfidence,
      sharedBlacklist,
    });

    // PASS-5 fix: no round-robin fallback. Null URLs render as per-item
    // abbreviation placeholders in the frontend, which are unique per item
    // name and never look duplicated.
    const finalUrl = resolved.url ?? null;

    const qty = x.qty ?? 1;
    const existing = counts.get(dedupKey);
    if (existing) {
      existing.qty += qty;
    } else {
      counts.set(dedupKey, { name, image_url: finalUrl, qty });
    }
  });
  return Array.from(counts.values());
}

// Local alias so existing call sites that name the helper *Str stay working.
const effectiveDateStr = effectiveDate;

const TODAY = () => new Date().toISOString().slice(0, 10);

const isoWeekBounds = () => {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { weekStart: mon.toISOString().slice(0, 10), weekEnd: sun.toISOString().slice(0, 10) };
};

const monthBounds = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { monthStart: start, monthEnd: end };
};

/**
 * W02 Stats Grid -- single query returning all stat-tile values.
 * Active rental segmentation matching v1 booking-stats logic:
 *   ongoing  = confirmed AND start_date <= today AND end_date >= today
 *   upcoming = confirmed AND start_date > today
 *   overdue  = confirmed AND end_date < today (stale -- not yet marked complete)
 * Revenue attribution uses effectiveDate = pickup_date ?? start_date (BF-06).
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

    // Indexed read — getSummary only references current-and-future
    // reservations + last-365d revenue. Drops ~1767 → ~250.
    const summaryCutoff = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 365);
      return d.toISOString().slice(0, 10);
    })();
    let allReservations = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", summaryCutoff))
      .collect();
    if (accountSlug) {
      allReservations = allReservations.filter((r) => r.account_slug === accountSlug);
    }

    // Active rental segmentation
    const confirmedWithDates = allReservations.filter(
      (r) => r.status === "confirmed" && r.start_date !== undefined && r.end_date !== undefined
    );
    const ongoingCount = confirmedWithDates.filter(
      (r) => (r.start_date as string) <= today && (r.end_date as string) >= today
    ).length;
    const upcomingCount = confirmedWithDates.filter(
      (r) => (r.start_date as string) > today
    ).length;
    const activeRentalsCount = ongoingCount + upcomingCount;
    const pendingReturns = confirmedWithDates.filter((r) => r.end_date === today).length;
    const overdueCount = confirmedWithDates.filter((r) => (r.end_date as string) < today).length;

    // Revenue: non-cancelled, effective date <= today (BF-06)
    const earnedRows = allReservations.filter((r) => {
      if (r.status === "cancelled" || r.status === "declined") return false;
      const d = effectiveDate(r);
      return d !== undefined && d <= today;
    });

    const todayRevenue = earnedRows.filter((r) => effectiveDate(r) === today)
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const todayRentalCount = earnedRows.filter((r) => effectiveDate(r) === today).length;
    const weeklyRevenue = earnedRows
      .filter((r) => { const d = effectiveDate(r) as string; return d >= weekStart && d <= weekEnd; })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const monthlyRevenue = earnedRows
      .filter((r) => { const d = effectiveDate(r) as string; return d >= monthStart && d <= monthEnd; })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const monthlyBookings = allReservations.filter((r) => {
      if (r.status === "cancelled" || r.status === "declined") return false;
      const d = effectiveDate(r);
      return d !== undefined && d >= monthStart && d <= monthEnd;
    }).length;

    // Month projection
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;
    const dailyAvgRevenue = daysElapsed > 0 ? monthlyRevenue / daysElapsed : 0;
    const bookedCurrentMonth = confirmedWithDates
      .filter((r) => { const d = r.start_date as string; return d > today && d >= monthStart && d <= monthEnd; })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const projectedMonthRevenue = Math.round(monthlyRevenue + bookedCurrentMonth + dailyAvgRevenue * daysRemaining);

    // Avg rental value last 30d
    const last30 = earnedRows.filter((r) => (effectiveDate(r) as string) >= thirtyDaysAgoStr);
    const avgRentalValue = last30.length > 0
      ? last30.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0) / last30.length : 0;

    // Items currently out (from ongoing rentals only)
    const itemNamesOut = new Set<string>();
    for (const r of confirmedWithDates.filter(
      (r) => (r.start_date as string) <= today && (r.end_date as string) >= today
    )) {
      for (const item of r.items ?? []) itemNamesOut.add(item.item_name);
    }
    const itemsOut = itemNamesOut.size;

    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const availableItems = activeItems.filter((i) => !itemNamesOut.has(i.name_canonical)).length;
    const totalAcquisitionCost = activeItems.reduce((s, i) => s + (i.acquisition_cost_gbp ?? 0), 0);

    // Denials (90d for denied revenue, 30d for denial rate)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const acct = await ctx.db.query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug as string)).first();
      if (acct) denials = denials.filter((d) => d.account_id === acct._id);
    }
    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]));
    let deniedRevenue = 0;
    const denials90 = denials.filter((d) => d.created_at >= ninetyDaysAgo.getTime());
    for (const d of denials90) {
      if (d.estimated_value) deniedRevenue += d.estimated_value;
      else if (d.item_name) deniedRevenue += (priceByName.get(d.item_name) ?? 0) * 2;
    }
    const recentDenials30 = denials.filter((d) => d.created_at >= thirtyDaysAgo.getTime()).length;
    const denialRate = monthlyBookings + recentDenials30 > 0
      ? recentDenials30 / (monthlyBookings + recentDenials30) : 0;

    // Out-of-stock (items fully booked in next 14 days)
    const fourteenDaysStr = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
    const holdCounts = new Map<string, number>();
    for (const r of confirmedWithDates.filter(
      (r) => (r.start_date as string) <= fourteenDaysStr && (r.end_date as string) >= today
    )) {
      for (const item of r.items ?? []) holdCounts.set(item.item_name, (holdCounts.get(item.item_name) ?? 0) + 1);
    }
    const outOfStockCount = activeItems.filter(
      (i) => (holdCounts.get(i.name_canonical) ?? 0) >= i.qty
    ).length;

    const settings = await ctx.db.query("settings").first();
    // Stage 2.5: read boostRate from settings (no hardcoded constant)
    const boostRate: number = (settings as unknown as Record<string, number>)?.ai_boost_rate ?? 0.33;
    const aiBoostAmount = Math.round(monthlyRevenue * boostRate / (1 + boostRate));

    return {
      activeRentalsCount, ongoingCount, upcomingCount,
      pendingReturns, overdueCount,
      todayRevenue: Math.round(todayRevenue * 100) / 100,
      todayRentalCount,
      weeklyRevenue: Math.round(weeklyRevenue * 100) / 100,
      monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
      monthlyBookings, projectedMonthRevenue, daysElapsed, daysRemaining,
      dailyAvgRevenue: Math.round(dailyAvgRevenue * 100) / 100,
      avgRentalValue: Math.round(avgRentalValue * 100) / 100,
      itemsOut, availableItems,
      totalAcquisitionCost: Math.round(totalAcquisitionCost),
      outOfStockCount,
      denialRate: Math.round(denialRate * 1000) / 1000,
      deniedRevenue: Math.round(deniedRevenue),
      deniedCount: denials90.length,
      aiBoostAmount, boostRate,
      hyggloSendEnabled: settings?.ALLOW_HYGGLO_SEND ?? false,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// W02 Stats Drawer — single reactive query powering all 16 stat-card drawers.
//
// Pre-fetch strategy: one query, 5 collect() calls total (reservations, items,
// denial_records, owner_unavailability, sync_state). All 16 card payloads are
// derived from these in-memory with zero extra round-trips.
//
// Cards with no real data source return placeholder zeros / empty arrays;
// each is marked TODO so callers can render empty-state gracefully.
// ─────────────────────────────────────────────────────────────────────────────

/** Order steps that represent a live paid/active booking (non-obsolete). */
const ACTIVE_ORDER_STEPS = new Set([
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
]);

export const getStatsDrawerData = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();

    // ── Week bounds ──────────────────────────────────────────────
    const dayOfWeek = now.getDay();
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monDate = new Date(now);
    monDate.setDate(now.getDate() + diffToMon);
    const weekStart = monDate.toISOString().slice(0, 10);
    const sunDate = new Date(monDate);
    sunDate.setDate(monDate.getDate() + 6);
    const weekEnd = sunDate.toISOString().slice(0, 10);

    // ── Month bounds ─────────────────────────────────────────────
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;

    // ── Next-30-day window for out-of-stock calc ─────────────────
    const next30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

    // ── COLLECT 1: reservations (indexed last 365d) ──────────────
    // Stat cards display current month + active + earnings (today/week/month).
    // YTD + lifetime-trend widgets pull their own MV/lifetime data; this
    // query never returns pre-365d totals. Indexed read drops ~1767 → ~250.
    const dashCutoff = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 365);
      return d.toISOString().slice(0, 10);
    })();
    const allResRaw = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", dashCutoff))
      .collect();
    // Account-scoped view for per-card numbers (active, earnings, monthly, etc.)
    let allRes = allResRaw;
    if (accountSlug) {
      allRes = allResRaw.filter((r) => r.account_slug === accountSlug);
    }
    // Cross-account view for double-booking detection.
    const allResCrossAccount = allResRaw;

    // ── COLLECT 2: items ─────────────────────────────────────────
    let allItems = await ctx.db.query("items").collect();
    if (accountSlug) {
      // items are cross-account; no slug filter needed for inventory_worth
      // but keep full list for out-of-stock which is also cross-account
    }
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // Phase 12.3: listing_images bank — product_id-keyed canonical photos.
    // Fetched once here, looked up per-rental in mapRental.useHygglo branch.
    const listingImagesRaw = await ctx.db.query("listing_images").collect();
    const bankByProduct = new Map<string, string>(); // key: `${account_slug}#${product_id}` → image_url
    for (const li of listingImagesRaw) {
      bankByProduct.set(`${li.account_slug}#${li.product_id}`, li.image_url);
    }

    // ── COLLECT 3: denial_records ────────────────────────────────
    let denialRows = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      // denial_records only have account_id; resolve via accounts if needed
      // (slug filter applied below per-card — keep full list here)
    }

    // ── COLLECT 4: owner_unavailability ─────────────────────────
    const unavailRows = await ctx.db.query("owner_unavailability").collect();

    // ── COLLECT 5: sync_state ─────────────────────────────────────
    const syncRow = await ctx.db
      .query("sync_state")
      .withIndex("by_source", (q) => q.eq("source", "hygglo_poller"))
      .first();

    // ── COLLECT 6: insurance_claims (account-scoped) ──────────────
    let claimRows = accountSlug
      ? await ctx.db
          .query("insurance_claims")
          .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
          .collect()
      : await ctx.db.query("insurance_claims").collect();
    claimRows = claimRows.slice().sort((a, b) => (a.claim_date < b.claim_date ? 1 : a.claim_date > b.claim_date ? -1 : 0));

    // ── COLLECT 7: conflict_dismissals (owner-resolved alerts) ────
    const dismissedKeys = new Set<string>(
      (await ctx.db.query("conflict_dismissals").collect()).map((d) => d.conflict_key),
    );

    // ────────────────────────────────────────────────────────────
    // Derived sets from reservations
    // ────────────────────────────────────────────────────────────

    // Confirmed (non-obsolete, non-cancelled) with dates
    const confirmedWithDates = allRes.filter(
      (r) =>
        r.status === "confirmed" &&
        !r.is_obsolete &&
        r.start_date !== undefined &&
        r.end_date !== undefined,
    );

    // Active = ongoing + upcoming (from confirmed set).
    // ongoing = gear is out today or overdue (start has happened); upcoming =
    // gear not yet picked up (start is future). We deliberately drop the
    // end>=today constraint on ongoing so DELIVERED rentals whose end_date
    // has passed but owner hasn't yet marked RETURNED still appear as
    // ongoing/overdue — mirrors Hygglo's filter=future bucket.
    type ResRow = typeof allRes[number];
    const dedupRes = <T extends ResRow>(arr: T[]): T[] => dedupByLogicalRental(arr);

    const ongoingRentals = allRes.filter((r) => isOngoing(r as ResRow, today));
    const upcomingRentals = allRes.filter((r) => isUpcoming(r as ResRow, today));

    // "Paid" = live (not cancelled/declined/obsolete). Revenue candidate pool.
    const paidRes = allRes.filter(
      (r) => r.status !== "cancelled" && r.status !== "declined" && !r.is_obsolete,
    );

    const ongoingUniq = dedupRes(ongoingRentals);
    const upcomingUniq = dedupRes(upcomingRentals);

    // Monthly confirmed bookings (deduped) — confirmed status only, used for the
    // "still going" segments (done-via-date / active / upcoming).
    const monthConfirmedRentals = dedupRes(
      confirmedWithDates.filter((r) => {
        const d = effectiveDateStr(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      }),
    );

    // Monthly booked rentals = everything non-cancelled (confirmed OR completed)
    // whose effective date falls in the month. v1 parity: a returned rental
    // still counts toward "Month Confirmed" revenue.
    const monthBookedRentals = dedupRes(
      allRes.filter((r) => {
        if (r.is_obsolete) return false;
        if (r.status !== "confirmed" && r.status !== "completed") return false;
        if (!r.start_date || !r.end_date) return false;
        const d = effectiveDateStr(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      }),
    );

    // Revenue slices — net_to_owner_gbp, deduped per rental
    const earnedPaid = dedupRes(
      paidRes.filter((r) => {
        const d = effectiveDateStr(r);
        return d !== undefined && d <= today;
      }),
    );
    const todayEarned = earnedPaid.filter((r) => effectiveDateStr(r) === today);
    const weekEarned = earnedPaid.filter((r) => {
      const d = effectiveDateStr(r) as string;
      return d >= weekStart && d <= weekEnd;
    });
    const monthEarned = earnedPaid.filter((r) => {
      const d = effectiveDateStr(r) as string;
      return d >= monthStart && d <= monthEnd;
    });

    // netOf imported from predicates.
    const todayTotal = todayEarned.reduce((s, r) => s + netOf(r), 0);
    const weekTotal = weekEarned.reduce((s, r) => s + netOf(r), 0);
    const monthTotal = monthEarned.reduce((s, r) => s + netOf(r), 0);

    // Per-account earnings breakdown (net)
    const accountSlugs = [...new Set(allRes.map((r) => r.account_slug).filter(Boolean))] as string[];
    const byAccount = accountSlugs.map((slug) => {
      const todayAcc = todayEarned
        .filter((r) => r.account_slug === slug)
        .reduce((s, r) => s + netOf(r), 0);
      const weekAcc = weekEarned
        .filter((r) => r.account_slug === slug)
        .reduce((s, r) => s + netOf(r), 0);
      return { account_slug: slug, today: Math.round(todayAcc * 100) / 100, week: Math.round(weekAcc * 100) / 100 };
    });

    // Month projection (net)
    const avgDailyRate = daysElapsed > 0 ? monthTotal / daysElapsed : 0;
    const bookedFutureUniq = dedupRes(
      confirmedWithDates.filter((r) => {
        const d = r.start_date as string;
        return d > today && d >= monthStart && d <= monthEnd;
      }),
    );
    const bookedFuture = bookedFutureUniq.reduce((s, r) => s + netOf(r), 0);
    const projected = Math.round(monthTotal + bookedFuture + avgDailyRate * daysRemaining);

    // ── card: active ─────────────────────────────────────────────
    // V1 PARITY: count unique rentals; expose ongoing/upcoming/pending split
    // for segmented bar visualisation.
    //
    // "Pending" = renter has paid (escrow funds reserved) AND is currently in
    // the ID/document verification stage. order_step represents the renter's
    // NEXT-TO-DO step. So:
    //   order_step === REQUEST          → owner needs to accept (renter waiting)  — not pending
    //   order_step === APPROVED         → renter needs to accept owner's terms     — not pending
    //   order_step === FUNDS_RESERVED   → renter needs to pay (not paid yet)        — not pending
    //   order_step === VERIFIED         → renter is currently verifying (paid ✓)    ← PENDING
    //   order_step === BOOKED_AFTER_VERIFIED → verified, awaiting handover          — confirmed
    //   later steps → already booked / out / done
    const pendingRes = allRes.filter((r) => isPendingVerification(r as ResRow));
    const pendingUniq = dedupRes(pendingRes);
    const pendingCount = pendingUniq.length;
    const pendingValueGbp = pendingUniq.reduce((s, r) => s + netOf(r), 0);
    const activeTotal = ongoingUniq.length + upcomingUniq.length;
    // ── UNTRACKED ITEM DETECTION (LLM-resolved) ────────────────
    // A reservation is "untracked" when its LLM-resolved items list is empty
    // OR resolution hasn't run yet AND items[] is non-empty. This replaces
    // the previous fuzzy substring matcher which conflated A7 II / A7 III
    // (any model-number disambiguation). Resolution is owned by the action
    // `item_resolver:resolveReservation` (see convex/item_resolver.ts) which
    // calls Grok 4.3 with strict instructions to respect II/III/Mk2/Mk3 etc.
    type ExpandedItem = { item_id: string; item_name_canonical: string; qty: number; via_bundle?: string };
    type ResolvedItem = { item_id: string; item_name_canonical: string; confidence: number; qty?: number };
    /** Expanded-items map for conflict / untracked / sell-reco. Falls back to
     *  resolved_items when bundle expansion hasn't run yet (the resolver
     *  cron will populate expanded_items shortly after a new poll). */
    function expandedIdsOf(r: ResRow): Map<string, number> {
      const expanded = ((r as { expanded_items?: ExpandedItem[] }).expanded_items) ?? [];
      if (expanded.length > 0) {
        const m = new Map<string, number>();
        for (const x of expanded) m.set(x.item_id, (m.get(x.item_id) ?? 0) + x.qty);
        return m;
      }
      const resolved = ((r as { resolved_items?: ResolvedItem[] }).resolved_items) ?? [];
      const m = new Map<string, number>();
      for (const x of resolved) m.set(x.item_id, (m.get(x.item_id) ?? 0) + (x.qty ?? 1));
      return m;
    }
    function resolvedIdsOf(r: ResRow): Set<string> {
      return new Set(expandedIdsOf(r).keys());
    }
    function isResolved(r: ResRow): boolean {
      return (r as { resolved_items?: ResolvedItem[] }).resolved_items !== undefined;
    }
    function isTracked(r: ResRow): boolean {
      const ids = resolvedIdsOf(r);
      if (ids.size === 0) return false;
      // ids must reference an active item we currently have.
      for (const id of ids) {
        if (activeItemIds.has(id)) return true;
      }
      return false;
    }
    const activeItemIds = new Set<string>(activeItems.map((i) => i._id as string));
    const pendingTracked: typeof pendingUniq = [];
    const pendingUntracked: typeof pendingUniq = [];
    const pendingUnresolved: typeof pendingUniq = []; // resolver hasn't run yet — count as tracked-by-default to avoid scaring the owner
    for (const r of pendingUniq) {
      if (!isResolved(r as ResRow)) pendingUnresolved.push(r);
      else if (isTracked(r as ResRow)) pendingTracked.push(r);
      else pendingUntracked.push(r);
    }
    // Pending that are unresolved are counted as tracked optimistically — the
    // resolver cron will reclassify them shortly. This keeps the headline
    // pending number stable until the LLM has caught up.
    pendingTracked.push(...pendingUnresolved);
    const untrackedPayload = {
      count: pendingUntracked.length,
      total_value_gbp: Math.round(pendingUntracked.reduce((s, r) => s + netOf(r), 0) * 100) / 100,
      reservations: pendingUntracked.slice(0, 10).map((r) => ({
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        account_slug: r.account_slug ?? "",
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        items: (r.items ?? []).map((i) => i.item_name),
        net_gbp: r.net_to_owner_gbp ?? null,
      })),
    };

    // ── DOUBLE-BOOKING DETECTION ────────────────────────────────
    // For each active item with qty>=1, scan ongoing+upcoming+pending(tracked)
    // reservations covering the next 90 days. If overlapping reservations on
    // ANY day exceed qty, surface a conflict. The first overlapping date is
    // reported; the full conflicting reservation set is included.
    type ResWithItems = ResRow;
    const conflictHorizonDays = 90;
    const horizonEnd = new Date(Date.now() + conflictHorizonDays * 86400000).toISOString().slice(0, 10);

    // Cross-account active reservations for conflict detection. Includes ALL
    // accounts (not just the scoped one) so an A7 III booked by DB Cinema
    // and an A7 III booked by Leo on the same day surface as ONE conflict
    // on either dashboard page.
    const ongoingCross = (allResCrossAccount as ResRow[]).filter((r) => isOngoing(r as ResRow, today));
    const upcomingCross = (allResCrossAccount as ResRow[]).filter((r) => isUpcoming(r as ResRow, today));
    const pendingCross = (allResCrossAccount as ResRow[]).filter((r) => isPendingVerification(r as ResRow));
    const dedupCross = <T extends ResRow>(arr: T[]): T[] => dedupByLogicalRental(arr);
    const ongoingCrossUniq = dedupCross(ongoingCross);
    const upcomingCrossUniq = dedupCross(upcomingCross);
    const pendingCrossUniq = dedupCross(pendingCross);
    // Pending-tracked equivalent for cross-account (filter to those whose
    // resolved_items point at active inventory).
    const pendingCrossTracked = pendingCrossUniq.filter((r) => {
      const ids = expandedIdsOf(r as ResRow);
      for (const id of ids.keys()) if (activeItemIds.has(id)) return true;
      return false;
    });
    const activeForConflicts: ResWithItems[] = [
      ...ongoingCrossUniq,
      ...upcomingCrossUniq,
      ...pendingCrossTracked,
    ];
    interface Conflict {
      conflict_key: string;
      item_id: string;
      item_canonical: string;
      item_image_url: string | null;
      qty: number;
      conflict_start: string;
      conflict_end: string;
      overlap_count: number;
      reservations: Array<{
        reservation_id: string;
        kind: "ongoing" | "upcoming" | "pending";
        renter_name: string | null;
        account_slug: string;
        start_date: string;
        end_date: string;
      }>;
    }
    const conflicts: Conflict[] = [];
    for (const item of activeItems) {
      if (item.qty < 1) continue;
      const matchingRes: Array<{ r: ResWithItems; kind: "ongoing" | "upcoming" | "pending" }> = [];
      const seenIds = new Set<string>();
      const tag = (r: ResWithItems): "ongoing" | "upcoming" | "pending" =>
        upcomingCrossUniq.includes(r) ? "upcoming"
        : ongoingCrossUniq.includes(r) ? "ongoing"
        : "pending";
      const itemIdStr = item._id as string;
      for (const r of activeForConflicts) {
        if (!r.start_date || !r.end_date) continue;
        if ((r.start_date as string) > horizonEnd) continue;
        // Strict match via LLM-resolved item IDs — no substring fuzzy.
        const idsToQty = expandedIdsOf(r as ResRow);
        const q = idsToQty.get(itemIdStr);
        if (!q || q < 1) continue;
        if (seenIds.has(r._id)) continue;
        seenIds.add(r._id);
        matchingRes.push({ r, kind: tag(r) });
      }
      // Concurrent qty SUM is what matters. A reservation holding 2× of the item
      // counts as 2 toward overlap.
      const sumQty = (rows: typeof matchingRes): number => {
        let total = 0;
        for (const { r } of rows) total += expandedIdsOf(r as ResRow).get(itemIdStr) ?? 0;
        return total;
      };
      if (sumQty(matchingRes) <= item.qty) continue;

      // Sweep dates within horizon, count concurrency per day.
      const todayIso = today;
      let worstStart = "";
      let worstCount = 0;
      let worstEnd = "";
      const scanFrom = todayIso;
      const scanTo = horizonEnd;
      const startDates = matchingRes.map((m) => m.r.start_date as string);
      const endDates = matchingRes.map((m) => m.r.end_date as string);
      const candidates = Array.from(
        new Set<string>([scanFrom, ...startDates, ...endDates].filter((d) => d >= scanFrom && d <= scanTo)),
      ).sort();
      for (const d of candidates) {
        const overlapping = matchingRes.filter(
          (m) => (m.r.start_date as string) <= d && (m.r.end_date as string) >= d,
        );
        const qtySum = overlapping.reduce(
          (s, m) => s + (expandedIdsOf(m.r as ResRow).get(itemIdStr) ?? 0),
          0,
        );
        if (qtySum > worstCount) {
          worstCount = qtySum;
          worstStart = d;
          worstEnd = d;
        }
      }
      if (worstCount > item.qty && worstStart) {
        // Compute the inclusive range these reservations all share
        const overlappingSet = matchingRes.filter(
          (m) => (m.r.start_date as string) <= worstStart && (m.r.end_date as string) >= worstStart,
        );
        const earliestEnd = overlappingSet
          .map((m) => m.r.end_date as string)
          .sort()[0];
        // Stable conflict identity: item_id + sorted reservation IDs.
        // If any reservation set member changes, the key changes too — a
        // dismissal of the OLD shape does not suppress a NEW shape.
        const conflictReservationIds = overlappingSet
          .map(({ r }) => (r.v1_rental_id ?? r.hygglo_order_id ?? (r._id as string)))
          .sort();
        const conflictKey = (item._id as string) + "|" + conflictReservationIds.join(",");
        if (dismissedKeys.has(conflictKey)) continue;
        // Per-account view: only surface conflicts that involve at least one
        // reservation in the scoped account. On 'All' (accountSlug=null) every
        // conflict shows.
        if (accountSlug) {
          const involves = overlappingSet.some(({ r }) => r.account_slug === accountSlug);
          if (!involves) continue;
        }

        conflicts.push({
          conflict_key: conflictKey,
          item_id: item._id as string,
          item_canonical: item.name_canonical,
          item_image_url: (item as any).image_url ?? null,
          qty: item.qty,
          conflict_start: worstStart,
          conflict_end: earliestEnd,
          overlap_count: worstCount,
          reservations: overlappingSet.map(({ r, kind }) => ({
            reservation_id: (r.v1_rental_id ?? r.hygglo_order_id ?? r._id) as string,
            kind,
            renter_name: r.renter_name ?? null,
            account_slug: r.account_slug ?? "",
            start_date: r.start_date as string,
            end_date: r.end_date as string,
          })),
        });
      }
    }
    // Sort conflicts: earliest start first (most urgent at top)
    conflicts.sort((a, b) => a.conflict_start.localeCompare(b.conflict_start));

    // Update pending count to exclude untracked rows so the headline number
    // reflects actionable pending verifications only.
    const pendingTrackedCount = pendingTracked.length;
    const pendingTrackedValue = pendingTracked.reduce((s, r) => s + netOf(r), 0);


    const daysBetween = (a: string, b: string): number => {
      const ms = Date.parse(b) - Date.parse(a);
      return Math.max(1, Math.round(ms / 86400000) + 1);
    };

    // Inventory image lookup for the multi-tile item row in Active Rentals.
    // Match strictly via resolved_items[].item_id — no fuzzy substring matching.
    // Phase 11.2: historical hygglo_items[].image_url=null rows are now patched
    // by the backfill_hygglo_images mutation, so no name-based fallback needed.
    const itemImageById = new Map<string, { name: string; image_url: string | null }>();
    for (const it of activeItems) {
      itemImageById.set(it._id as string, {
        name: it.name_canonical,
        image_url: (it as { image_url?: string }).image_url ?? null,
      });
    }
    // Phase 9 / FIX-DESIGN §4.5: build the shared-image blacklist once for
    // the whole query so the resolver can guard the items_table fallback
    // against globally-aliased URLs (Pass-1 root cause).
    const sharedBlacklist = buildSharedImageBlacklist(
      allItems.map((it) => ({ image_url: (it as { image_url?: string | null }).image_url ?? null })),
    );
    const buildItemTiles = (r: ResRow): ItemTile[] =>
      buildItemTilesShared({
        reservation: r as Parameters<typeof buildItemTilesShared>[0]["reservation"],
        itemImageById,
        sharedBlacklist,
      });

    const mapRental = (r: ResRow, kind: "ongoing" | "upcoming" | "pending") => {
      // PASS-9 (2026-05-15): raw Hygglo per-rental items[] are AUTHORITATIVE.
      // The poller writes detail.items[] verbatim into r.hygglo_items. We use
      // that directly — never cross-match against the global items table —
      // to fix Michelle's Atomos showing a GM 24-70 Bundle image.
      const hyggloItemsRaw = (r as any).hygglo_items as
        | Array<{
            name: string;
            image_url: string | null;
            type: string;
            qty?: number;
            product_id?: number;
          }>
        | undefined;
      const useHygglo = Array.isArray(hyggloItemsRaw) && hyggloItemsRaw.length > 0;
      if (useHygglo) {
        // INSURANCE already filtered at poll time but defensive-filter here too.
        const hItems = hyggloItemsRaw!.filter(
          (h) => h?.name && h.type !== "INSURANCE",
        );
        type HygTile = {
          image_url: string;
          name: string;
          names_in_group: string[];
          qty: number;
        };
        const tilesByImage = new Map<string, HygTile>();
        const tileOrderH: string[] = [];
        const noImage: string[] = [];
        for (const h of hItems) {
          const q = typeof h.qty === "number" && h.qty > 0 ? h.qty : 1;
          // Phase 12.3 (revised 2026-05-15 23:15): correctness > coverage.
          // Previous name-substring fallback aliased the wrong listing image
          // for kit rentals. Removed entirely — only the bank and the per-row
          // hygglo image_url are trusted now. Missing images stay missing
          // until the poller refreshes the row with product_id.
          //   1. listing_images bank (account_slug, product_id) — trusted.
          //   2. hygglo_items[i].image_url — per-row poller snapshot.
          //   3. null → noImage[] pill.
          const bankUrl = h.product_id
            ? bankByProduct.get(`${r.account_slug}#${h.product_id}`)
            : undefined;
          const url: string | null = bankUrl ?? h.image_url ?? null;
          if (url) {
            const ex = tilesByImage.get(url);
            if (ex) {
              ex.qty += q;
              ex.names_in_group.push(h.name);
              if (h.name.length < ex.name.length) ex.name = h.name;
            } else {
              tilesByImage.set(url, {
                image_url: url,
                name: h.name,
                names_in_group: [h.name],
                qty: q,
              });
              tileOrderH.push(url);
            }
          } else {
            noImage.push(h.name);
          }
        }
        const item_image_tiles_h = tileOrderH.map(
          (u) => tilesByImage.get(u) as HygTile,
        );
        const master_image_url_h = item_image_tiles_h[0]?.image_url ?? null;
        const item_names_summary_h = hItems
          .map((i) => (i.qty && i.qty > 1 ? `${i.name} \u00d7${i.qty}` : i.name))
          .join(", ");

        return {
          reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
          renter_name: r.renter_name ?? null,
          account_slug: r.account_slug ?? "",
          start_date: r.start_date ?? null,
          end_date: r.end_date ?? null,
          pickup_date: r.pickup_date ?? r.start_date ?? null,
          pickup_time: r.pickup_time ?? null,
          return_date: (r as any).return_date ?? r.end_date ?? null,
          return_time: r.return_time ?? null,
          pickup_method: r.pickup_method ?? null,
          return_method: r.return_method ?? null,
          items: hItems.map((i) => i.name),
          photo_url: master_image_url_h,
          master_image_url: master_image_url_h,
          item_names_summary: item_names_summary_h.length > 0 ? item_names_summary_h : "(no item)",
          item_image_tiles: item_image_tiles_h,
          extra_text_items: noImage,
          duration_days:
            r.duration_days ??
            (r.start_date && r.end_date
              ? daysBetween(r.start_date as string, r.end_date as string)
              : null),
          net_gbp: r.net_to_owner_gbp ?? null,
          order_step: r.order_step ?? null,
          item_tiles: item_image_tiles_h.map((t) => ({
            name: t.name,
            qty: t.qty,
            image_url: t.image_url,
          })),
          kind,
          is_ongoing: kind === "ongoing",
        };
      }
      // ── Fallback path: no hygglo_items[] ──
      // Phase 12.3: REMOVED the items.image_url cross-match block (Pass-8/9
      // root cause — global-aliased URLs leaked into dashboard tiles, e.g.
      // Michelle's Atomos pulling a GM 24-70 Bundle image). The product_id
      // bank populated by the poller is the new source of truth. Rentals
      // without hygglo_items[] (legacy v1 imports) emit no tiles — names
      // go into the text-pill fallback (extra_text_items) and the bank
      // fills in over time as the poller re-touches them.
      const isInsurance = (n: string) =>
        /insurance/i.test(n) || /\binsur\b/i.test(n);
      const fallbackNames = (r.items ?? [])
        .map((i) => i.item_name)
        .filter((n) => n && !isInsurance(n));
      const itemNamesSummary = fallbackNames.length > 0
        ? fallbackNames.join(", ")
        : "(no item)";

      return {
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        account_slug: r.account_slug ?? "",
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        pickup_date: r.pickup_date ?? r.start_date ?? null,
        pickup_time: r.pickup_time ?? null,
        return_date: (r as any).return_date ?? r.end_date ?? null,
        return_time: r.return_time ?? null,
        pickup_method: r.pickup_method ?? null,
        return_method: r.return_method ?? null,
        items: (r.items ?? []).map((i) => i.item_name),
        photo_url: null,
        master_image_url: null,
        item_names_summary: itemNamesSummary,
        item_image_tiles: [] as Array<{ image_url: string; name: string; names_in_group: string[]; qty: number }>,
        extra_text_items: fallbackNames,
        duration_days:
          r.duration_days ??
          (r.start_date && r.end_date ? daysBetween(r.start_date as string, r.end_date as string) : null),
        net_gbp: r.net_to_owner_gbp ?? null,
        order_step: r.order_step ?? null,
        item_tiles: [] as Array<{ name: string; qty: number; image_url: string | null }>,
        kind,
        is_ongoing: kind === "ongoing",
      };
    };

    const activeRentals = [
      ...ongoingUniq.map((r) => mapRental(r, "ongoing")),
      ...upcomingUniq.map((r) => mapRental(r, "upcoming")),
      ...pendingTracked.map((r) => mapRental(r, "pending")),
    ]
      .sort((a, b) => {
        const ad = a.start_date ?? "";
        const bd = b.start_date ?? "";
        if (ad !== bd) return ad.localeCompare(bd);
        return (a.pickup_time ?? "99:99").localeCompare(b.pickup_time ?? "99:99");
      })
      .slice(0, 30);

    // ── card: earnings ───────────────────────────────────────────
    const earnings = {
      today: Math.round(todayTotal * 100) / 100,
      week: Math.round(weekTotal * 100) / 100,
      by_account: byAccount,
    };

    // Month revenue = all non-cancelled (confirmed + completed) net for the month.
    // v1 parity: "Month Confirmed £X" is total booked, NOT just earned-by-today.
    const monthBookedRevenue = monthBookedRentals.reduce((s, r) => s + netOf(r), 0);

    // ── card: monthly ────────────────────────────────────────────
    // Target = projected (current trend's end-of-month run-rate).
    const monthlyTarget = projected;
    const monthlyPct = monthlyTarget > 0
      ? Math.round((monthBookedRevenue / monthlyTarget) * 100)
      : 0;
    const monthly = {
      current_earnings: Math.round(monthTotal * 100) / 100,
      confirmed_revenue: Math.round(monthBookedRevenue * 100) / 100,
      projected,
      target_gbp: monthlyTarget,
      pct_of_target: Math.min(100, monthlyPct),
      days_remaining: daysRemaining,
      days_in_month: daysInMonth,
      days_elapsed: daysElapsed,
      avg_daily_rate: Math.round(avgDailyRate * 100) / 100,
    };

    // ── card: confirmed ──────────────────────────────────────────
    // Split this-month booked rentals into done / active / upcoming for the v1
    // 4-segment breakdown bar. A "completed" status row counts as done even if
    // end_date is in the future (unlikely but possible).
    // Month Confirmed split into done / active / upcoming. Composed from the
    // canonical isConfirmedWithDates/isUpcoming predicates so the count moves
    // in lockstep with the Active Rentals card when semantics shift. "active"
    // here is stricter than isOngoing — Month Confirmed only highlights
    // strictly current rentals (end >= today), whereas isOngoing also keeps
    // overdue/never-returned rows visible.
    const monthDone = monthBookedRentals.filter(
      (r) => r.status === "completed" || (r.end_date as string) < today,
    );
    const monthActive = monthBookedRentals.filter(
      (r) =>
        isConfirmedWithDates(r as ResRow) &&
        (r.start_date as string) <= today &&
        (r.end_date as string) >= today,
    );
    const monthUpcoming = monthBookedRentals.filter((r) =>
      isUpcoming(r as ResRow, today),
    );
    const monthPending = dedupRes(
      pendingRes.filter((r) => {
        const d = effectiveDateStr(r);
        return d !== undefined && d >= monthStart && d <= monthEnd;
      }),
    );
    const monthPendingValue = monthPending.reduce((s, r) => s + netOf(r), 0);
    // Daily buckets keyed by YYYY-MM-DD for the current month. Used by the
    // ConfirmedDrawer chart. Each rental contributes to exactly one bucket
    // based on effectiveDateStr (pickup_date ?? start_date); revenue is netOf.
    const lastDay = parseInt(monthEnd.slice(8, 10), 10);
    type DailyBucket = { date: string; day: number; done: number; active: number; upcoming: number; pending: number; revenue: number };
    const daily: DailyBucket[] = [];
    const yyyymm = monthStart.slice(0, 8);
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = yyyymm + String(d).padStart(2, "0");
      daily.push({ date: dateStr, day: d, done: 0, active: 0, upcoming: 0, pending: 0, revenue: 0 });
    }
    const idxOf = (dateStr: string | undefined): number => {
      if (!dateStr || dateStr < monthStart || dateStr > monthEnd) return -1;
      return parseInt(dateStr.slice(8, 10), 10) - 1;
    };
    const bumpBucket = (r: ResRow, key: "done" | "active" | "upcoming" | "pending") => {
      const i = idxOf(effectiveDateStr(r));
      if (i < 0) return;
      daily[i][key] += 1;
      daily[i].revenue += netOf(r);
    };
    for (const r of monthDone) bumpBucket(r as ResRow, "done");
    for (const r of monthActive) bumpBucket(r as ResRow, "active");
    for (const r of monthUpcoming) bumpBucket(r as ResRow, "upcoming");
    for (const r of monthPending) bumpBucket(r as ResRow, "pending");
    for (const b of daily) b.revenue = Math.round(b.revenue * 100) / 100;

    const todayDay = parseInt(today.slice(8, 10), 10);
    const confirmed = {
      month_count: monthBookedRentals.length,
      month_revenue: Math.round(monthBookedRevenue * 100) / 100,
      done_count: monthDone.length,
      active_count: monthActive.length,
      upcoming_count: monthUpcoming.length,
      pending_count: monthPending.length,
      pending_value_gbp: Math.round(monthPendingValue * 100) / 100,
      total_rentals: monthDone.length + monthActive.length + monthUpcoming.length + monthPending.length,
      today_day: today >= monthStart && today <= monthEnd ? todayDay : null,
      month_label: monthStart,
      daily_breakdown: daily,
      rentals: monthBookedRentals.slice(0, 15).map((r) => ({
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        gross: r.gross_paid_gbp ?? null,
      })),
    };

    // ── card: ongoing ─────────────────────────────────────────────
    const ongoingCard = {
      count: ongoingUniq.length,
      rentals: ongoingUniq.slice(0, 15).map((r) => {
        const daysLeft = r.end_date
          ? Math.max(0, Math.round((Date.parse(r.end_date) - Date.now()) / 86400000))
          : null;
        return {
          ...mapRental(r, "ongoing"),
          days_left: daysLeft,
        };
      }),
    };

    // ── card: upcoming ────────────────────────────────────────────
    const upcomingCard = {
      count: upcomingUniq.length,
      rentals: upcomingUniq.slice(0, 15).map((r) => {
        const daysUntil = r.start_date
          ? Math.max(0, Math.round((Date.parse(r.start_date) - Date.now()) / 86400000))
          : null;
        return {
          ...mapRental(r, "upcoming"),
          days_until: daysUntil,
        };
      }),
    };

    // ── card: insurance_claims (W22 — pinned to-do list of cases) ─
    // "Open" cases need owner action; "settled" or "denied" are terminal.
    // Sums by status surface both pending workload (open count + amount) and
    // outcomes (settled total YTD).
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    let openCount = 0;
    let openAmount = 0;
    let settledCountYTD = 0;
    let settledAmountYTD = 0;
    let deniedCountYTD = 0;
    for (const c of claimRows) {
      if (c.status === "open") { openCount++; openAmount += c.amount_gbp; continue; }
      if (c.claim_date >= yearStart) {
        if (c.status === "settled") { settledCountYTD++; settledAmountYTD += c.amount_gbp; }
        else if (c.status === "denied") { deniedCountYTD++; }
      }
    }
    const insurance = {
      open_count: openCount,
      open_amount_gbp: Math.round(openAmount * 100) / 100,
      settled_count_ytd: settledCountYTD,
      settled_amount_ytd_gbp: Math.round(settledAmountYTD * 100) / 100,
      denied_count_ytd: deniedCountYTD,
      total_count: claimRows.length,
      claims: claimRows.slice(0, 50).map((c) => ({
        id: c._id as string,
        accountSlug: c.account_slug ?? null,
        itemNameCanonical: c.item_name_canonical ?? null,
        amountGbp: c.amount_gbp,
        claimDate: c.claim_date,
        description: c.description ?? null,
        status: c.status,
        createdAt: c.created_at,
      })),
    };

    // ── card: scanner ─────────────────────────────────────────────
    const scanner = {
      last_scan_at: syncRow?.lastRunAt ?? null,
      last_run_succeeded: syncRow?.lastRunSucceeded ?? null,
      rows_upserted_last: syncRow?.rowsUpserted?.reservations ?? 0,
    };

    // ── card: denied_revenue ──────────────────────────────────────
    // denial_records: no reservation_id or renter_name; best-effort mapping
    const ninetyDaysAgo = Date.now() - 90 * 86400000;
    const recentDenials = denialRows.filter((d) => d.created_at >= ninetyDaysAgo);
    const deniedRevenueTotal = recentDenials.reduce((s, d) => s + (d.estimated_value ?? 0), 0);
    const denied_revenue = {
      total_gbp: Math.round(deniedRevenueTotal * 100) / 100,
      items: recentDenials.slice(0, 15).map((d) => ({
        reservation_id: d._id as string,
        renter_name: null as string | null,
        gross: d.estimated_value ?? null,
        reason: d.reason ?? null,
      })),
    };

    // ── card: missed_revenue ──────────────────────────────────────
    // Maps denial_type "timeout" and "unmatched" from denial_records as
    // "missed" revenue (distinct from owner_denied).
    // denial_records.reason holds the denial type string (e.g. "timeout", "unmatched", "owner_denied")
    const missedTypes = new Set(["timeout", "unmatched"]);
    const missedDenials = denialRows.filter(
      (d) => d.created_at >= ninetyDaysAgo && missedTypes.has(d.reason ?? ""),
    );
    const missedRevenueTotal = missedDenials.reduce((s, d) => s + (d.estimated_value ?? 0), 0);
    const missed_revenue = {
      total_gbp: Math.round(missedRevenueTotal * 100) / 100,
      items: missedDenials.slice(0, 15).map((d) => ({
        reservation_id: d._id as string,
        renter_name: null as string | null,
        gross: d.estimated_value ?? null,
        reason: d.reason ?? null,
      })),
    };

    // ── card: ai_boost ────────────────────────────────────────────
    // Count accepted ai_decisions in last 90d; estimate uplift via boostRate.
    const drawerSettings = await ctx.db.query("settings").first();
    const boostRateVal: number = (drawerSettings as unknown as Record<string, number>)?.ai_boost_rate ?? 0.24;
    const recentAccepted = await ctx.db
      .query("ai_decision")
      .withIndex("by_status", (idx) => idx.eq("status", "approved"))
      .collect()
      .then((rows) =>
        rows.filter(
          (r) => (r.generatedAt ?? 0) >= ninetyDaysAgo &&
            (!accountSlug || r.account_slug === accountSlug),
        ),
      );
    const aiAcceptedCount = recentAccepted.length;
    const aiUpliftGbp = Math.round(monthTotal * boostRateVal * 100) / 100;
    const ai_boost = {
      total_uplift_gbp: aiUpliftGbp,
      breakdown: [
        { source: `Accepted decisions (90d): ${aiAcceptedCount}`, amount: aiUpliftGbp },
      ] as Array<{ source: string; amount: number }>,
    };

    // ── card: out_of_stock ────────────────────────────────────────
    // Items where confirmed bookings in next 30d cover all their qty.
    const holdCountsByItem = new Map<string, number>();
    for (const r of confirmedWithDates) {
      if ((r.start_date as string) <= next30 && (r.end_date as string) >= today) {
        for (const it of r.items ?? []) {
          holdCountsByItem.set(it.item_name, (holdCountsByItem.get(it.item_name) ?? 0) + 1);
        }
      }
    }
    const oosItems = activeItems
      .filter((i) => (holdCountsByItem.get(i.name_canonical) ?? 0) >= i.qty)
      .slice(0, 15)
      .map((i) => {
        // count how many of the next 30 days have holds
        let blockedDays = 0;
        const itemHolds = confirmedWithDates.filter((r) =>
          (r.items ?? []).some((it) => it.item_name === i.name_canonical) &&
          (r.start_date as string) <= next30 &&
          (r.end_date as string) >= today,
        );
        // simple day-count: iterate each hold span
        for (const r of itemHolds) {
          const s = new Date(Math.max(Date.parse(r.start_date as string), Date.now()));
          const e = new Date(Math.min(Date.parse(r.end_date as string), Date.now() + 30 * 86400000));
          blockedDays += Math.max(0, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
        }
        return {
          item_id: i._id as string,
          name: i.name_canonical,
          blocked_days_next_30: Math.min(30, blockedDays),
        };
      });
    const out_of_stock = {
      count: oosItems.length,
      items: oosItems,
    };

    // ── card: vacation ────────────────────────────────────────────
    // owner_unavailability joined with items for name
    const itemNameById = new Map(allItems.map((i) => [i._id as string, i.name_canonical]));
    const activeBlocks = unavailRows
      .filter((u) => u.end_date >= today)
      .slice(0, 20)
      .map((u) => ({
        item_name: itemNameById.get(u.item_id as string) ?? u.item_id,
        start: u.start_date,
        end: u.end_date,
        reason: u.reason ?? null,
      }));
    const vacation = { active_blocks: activeBlocks };

    // ── card: sell_reco ───────────────────────────────────────────
    // items.getSellRecommendations logic inlined: low-utilization or high-age items.
    const SELL_LOOKBACK_DAYS = 90;
    const SELL_UTIL_THRESHOLD = 0.25;
    const sellCutoffStr = new Date(Date.now() - SELL_LOOKBACK_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    let sellReservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", sellCutoffStr))
      .collect();
    if (accountSlug) {
      sellReservations = sellReservations.filter((r) => r.account_slug === accountSlug);
    }
    const sellRentalDays = new Map<string, number>();
    for (const r of sellReservations) {
      for (const it of r.items ?? []) {
        const n = it.item_name ?? "";
        if (!n) continue;
        const s = new Date(r.start_date as string).getTime();
        const e = new Date(r.end_date as string).getTime();
        const days = Math.max(1, Math.round((e - s) / 86400000) + 1);
        sellRentalDays.set(n, (sellRentalDays.get(n) ?? 0) + days);
      }
    }
    const sellReco: Array<{ item_name: string; reason: string; suggested_price_gbp: number | null }> = [];
    for (const i of activeItems) {
      const rentalDays = sellRentalDays.get(i.name_canonical) ?? 0;
      const utilizationPct = rentalDays / SELL_LOOKBACK_DAYS;
      const ageMonths = (Date.now() - i.created_at) / (1000 * 60 * 60 * 24 * 30);
      if (utilizationPct > SELL_UTIL_THRESHOLD && ageMonths < 24) continue;
      const priceRow = await ctx.db
        .query("pricing_catalog")
        .withIndex("by_name", (q) => q.eq("item_name_canonical", i.name_canonical))
        .first();
      const suggested = priceRow ? Math.round(priceRow.daily_price_min * 30) : null;
      const reason = utilizationPct <= SELL_UTIL_THRESHOLD ? "Low demand" : "High age";
      sellReco.push({ item_name: i.name_canonical, reason, suggested_price_gbp: suggested });
      if (sellReco.length >= 15) break;
    }
    const sell_reco = { recommendations: sellReco };

    // ── card: inventory_worth ─────────────────────────────────────
    const worthByKind = new Map<string, number>();
    for (const i of activeItems) {
      const cost = i.acquisition_cost_gbp ?? 0;
      worthByKind.set(i.kind, (worthByKind.get(i.kind) ?? 0) + cost);
    }
    const totalWorth = activeItems.reduce((s, i) => s + (i.acquisition_cost_gbp ?? 0), 0);
    const inventory_worth = {
      total_gbp: Math.round(totalWorth),
      by_category: Array.from(worthByKind.entries())
        .sort(([, a], [, b]) => b - a)
        .map(([kind, value]) => ({ kind, value: Math.round(value) })),
    };

    // ── card: tax ─────────────────────────────────────────────────
    // Aggregate historical_revenue by calendar year + estimate tax at 20% flat.
    // Also folds in current-year earnings from reservations.
    const histRows = await ctx.db.query("historical_revenue").collect();
    const taxByYear = new Map<number, number>();
    for (const h of histRows) {
      const yr = parseInt(h.month.slice(0, 4), 10);
      if (!isNaN(yr)) {
        taxByYear.set(yr, (taxByYear.get(yr) ?? 0) + (h.total_overall_made_gbp ?? 0));
      }
    }
    // Add current-year live earnings from reservations
    const currentYear = new Date().getFullYear();
    const currentYearEarnings = allRes
      .filter((r) => {
        const yr = parseInt((r.start_date as string ?? "").slice(0, 4), 10);
        return yr === currentYear && (r.status === "confirmed" || r.status === "completed");
      })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    if (currentYearEarnings > 0) {
      taxByYear.set(currentYear, (taxByYear.get(currentYear) ?? 0) + currentYearEarnings);
    }
    const TAX_RATE = 0.20;
    const tax = {
      years: Array.from(taxByYear.entries())
        .sort(([a], [b]) => b - a)
        .slice(0, 5)
        .map(([year, gross]) => ({
          year,
          gross: Math.round(gross),
          estimated_tax: Math.round(gross * TAX_RATE),
        })),
    };

    // ── card: business_intel ──────────────────────────────────────
    // Compose KPI badges from purchase_signals + churn_risk MVs.
    const [psRow, crRow] = await Promise.all([
      ctx.db
        .query("purchase_signals")
        .withIndex("by_account", (q) => q.eq("account", accountSlug ?? "all"))
        .first(),
      ctx.db
        .query("churn_risk_renters")
        .withIndex("by_account", (q) => q.eq("account", accountSlug ?? "all"))
        .first(),
    ]);
    type KpiBadge = "strong" | "moderate" | "watch";
    const kpis: Array<{ label: string; value: string; badge: KpiBadge }> = [];
    // Purchase signals KPI
    const psSignals: Array<{ itemRequested: string; requestCount30d: number; projectedAnnualGbp: number }> =
      (psRow as { signals?: Array<{ itemRequested: string; requestCount30d: number; projectedAnnualGbp: number }> } | null)?.signals ?? [];
    if (psSignals.length > 0) {
      const top = psSignals[0];
      kpis.push({
        label: "Top unmet demand",
        value: `${top.itemRequested} (${top.requestCount30d} req/30d, £${top.projectedAnnualGbp}/yr)`,
        badge: top.projectedAnnualGbp >= 500 ? "strong" : top.projectedAnnualGbp >= 150 ? "moderate" : "watch",
      });
    } else {
      kpis.push({ label: "Unmet demand", value: "No signals", badge: "watch" });
    }
    // Churn risk KPI
    const crRows: Array<{ risk: string; renterName: string; lifetimeGbp: number }> =
      (crRow as { rows?: Array<{ risk: string; renterName: string; lifetimeGbp: number }> } | null)?.rows ?? [];
    const highRisk = crRows.filter((r) => r.risk === "high");
    if (highRisk.length === 0) {
      kpis.push({ label: "Renter churn risk", value: "No high-risk renters", badge: "strong" });
    } else {
      kpis.push({
        label: "Renter churn risk",
        value: `${highRisk.length} high-risk renter${highRisk.length > 1 ? "s" : ""}`,
        badge: highRisk.length >= 3 ? "watch" : "moderate",
      });
    }
    // AI decision acceptance rate KPI
    const totalDecisions = await ctx.db.query("ai_decision").collect()
      .then((rows) => rows.filter((r) => (!accountSlug || r.account_slug === accountSlug)));
    const acceptedCount = totalDecisions.filter((r) => r.status === "approved").length;
    const acceptRate = totalDecisions.length > 0
      ? Math.round((acceptedCount / totalDecisions.length) * 100)
      : null;
    if (acceptRate !== null) {
      kpis.push({
        label: "AI accept rate",
        value: `${acceptRate}% (${acceptedCount}/${totalDecisions.length})`,
        badge: acceptRate >= 70 ? "strong" : acceptRate >= 40 ? "moderate" : "watch",
      });
    }
    const business_intel = { kpis };

    return {
      active: {
        total: activeTotal,
        ongoing_count: ongoingUniq.length,
        upcoming_count: upcomingUniq.length,
        pending_count: pendingTrackedCount,
        pending_value_gbp: Math.round(pendingTrackedValue * 100) / 100,
        rentals: activeRentals,
      },
      // Pinned critical alerts — surfaced at the top of the dashboard.
      // conflicts: item has qty < concurrent reservations in next 90d.
      // untracked: paid+verifying rows whose items aren't in master inventory.
      conflicts,
      untracked: untrackedPayload,
      earnings,
      monthly,
      confirmed,
      ongoing: ongoingCard,
      upcoming: upcomingCard,
      scanner,
      insurance,
      denied_revenue,
      missed_revenue,
      ai_boost,
      out_of_stock,
      vacation,
      sell_reco,
      inventory_worth,
      tax,
      business_intel,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Next Rentals widget query - pickups + returns for a target day.
// Phase 9 / FIX-DESIGN §4.5: now uses the shared `buildItemTilesShared`
// helper (top of file) instead of the previously-duplicated
// `buildItemTilesLocal`. Single source of truth eliminates drift.
// ─────────────────────────────────────────────────────────────────────────────
export const getNextRentals = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    day: v.union(v.literal("today"), v.literal("tomorrow")),
  },
  handler: async (ctx, { accountSlug, day }) => {
    const now = new Date();
    const baseToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = day === "today" ? baseToday : new Date(baseToday.getTime() + 86400000);
    const targetDate = target.toISOString().slice(0, 10);

    // Indexed read — only need rows whose start_date is within ~30 days
    // of target. Drops ~1767 → ~30.
    const nextCutoff = (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      return d.toISOString().slice(0, 10);
    })();
    let rows = await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", nextCutoff))
      .collect();
    if (accountSlug) rows = rows.filter((r) => r.account_slug === accountSlug);
    const confirmed = rows.filter(
      (r) =>
        r.status === "confirmed" &&
        !r.is_obsolete &&
        r.start_date !== undefined &&
        r.end_date !== undefined,
    );

    // Build item-image lookup + shared-image blacklist once for this query.
    // Both feed the shared `buildItemTilesShared` helper (top of file).
    const items = await ctx.db.query("items").collect();
    const itemImageById = new Map<string, { name: string; image_url: string | null }>();
    for (const it of items) {
      const id = (it as { item_id?: string }).item_id ?? (it._id as unknown as string);
      itemImageById.set(id, {
        name: (it as { name?: string }).name ?? "",
        image_url: ((it as { image_url?: string | null }).image_url) ?? null,
      });
    }
    const sharedBlacklist = buildSharedImageBlacklist(
      items.map((it) => ({ image_url: (it as { image_url?: string | null }).image_url ?? null })),
    );

    const buildItemTilesLocal = (r: any): ItemTile[] =>
      buildItemTilesShared({
        reservation: r as Parameters<typeof buildItemTilesShared>[0]["reservation"],
        itemImageById,
        sharedBlacklist,
      });

    const mapForWire = (r: any, role: "pickup" | "return") => ({
      reservation_id: r.hygglo_order_id ?? r.v1_rental_id ?? (r._id as string),
      renter_name: r.renter_name ?? null,
      account_slug: r.account_slug,
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      pickup_date: r.pickup_date ?? r.start_date ?? null,
      pickup_time: r.pickup_time ?? null,
      return_date: r.return_date ?? r.end_date ?? null,
      return_time: r.return_time ?? null,
      pickup_method: r.pickup_method ?? null,
      return_method: r.return_method ?? null,
      items: (r.items ?? []).map((i: any) => i.item_name),
      photo_url: (r.photos_urls ?? [])[0] ?? null,
      net_gbp: r.net_to_owner_gbp ?? null,
      duration_days: r.duration_days ?? null,
      role,
      item_tiles: buildItemTilesLocal(r),
    });

    const pickups = confirmed
      .filter((r) => (r.pickup_date ?? r.start_date) === targetDate)
      .map((r) => mapForWire(r, "pickup"))
      .sort((a, b) =>
        (a.pickup_time ?? "99:99").localeCompare(b.pickup_time ?? "99:99"),
      );

    const returns = confirmed
      .filter((r) => ((r as any).return_date ?? r.end_date) === targetDate)
      .map((r) => mapForWire(r, "return"))
      .sort((a, b) =>
        (a.return_time ?? "99:99").localeCompare(b.return_time ?? "99:99"),
      );

    // For each pickup, find returns within ±60min on the same target day.
    const timeToMin = (t: string | null): number | null => {
      if (!t || t.length < 5) return null;
      const h = parseInt(t.slice(0, 2), 10);
      const m = parseInt(t.slice(3, 5), 10);
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    };

    const pickupsWithReturns = pickups.map((p) => {
      const pt = timeToMin(p.pickup_time);
      if (pt === null) return { ...p, concurrent_returns: [] as typeof returns };
      const matched = returns.filter((rt) => {
        const rtm = timeToMin(rt.return_time);
        return rtm !== null && Math.abs(rtm - pt) <= 60;
      });
      return { ...p, concurrent_returns: matched };
    });

    const pairedReturnIds = new Set(
      pickupsWithReturns.flatMap((p) =>
        p.concurrent_returns.map((r) => r.reservation_id),
      ),
    );
    const unpairedReturns = returns.filter(
      (r) => !pairedReturnIds.has(r.reservation_id),
    );

    return {
      targetDate,
      pickups: pickupsWithReturns,
      unpairedReturns,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Category Rental-Volume Pie widget — this-month deduped confirmed reservations
// grouped by item.kind. Returns both count and revenue per kind. Top 6 + Other.
// Reuses isConfirmedWithDates / isPaidWithV1Legacy / inDateRange / netOf /
// dedupByLogicalRental from predicates. Revenue split across resolver items
// weighted by (pricing_catalog daily_price_min * qty); equal split fallback.
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  camera: "Cameras", lens: "Lenses", drone: "Drones", audio: "Audio",
  lighting: "Lighting", grip: "Grip", gimbal: "Gimbals", monitor: "Monitors",
  transmission: "Transmission", accessory: "Accessories", smoke_fx: "Smoke/FX",
  dj_audio: "DJ Audio", power: "Power", storage_card: "Storage", support: "Support",
  motion: "Motion", stabilizer: "Stabilizers", video: "Video", effects: "Effects",
  bundle: "Bundles", unknown: "Unknown", other: "Other",
};
const labelFor = (k: string): string =>
  KIND_LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1));

const CATEGORY_PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee"];
const OTHER_COLOR = "#cbd5e1";

type ResolverItem = { item_id: string; item_name_canonical: string; qty: number };

/** Prefer expanded_items (bundle-decomposed); fall back to resolved_items. */
function readResolverItems(r: {
  expanded_items?: Array<{ item_id: string; item_name_canonical: string; qty: number }>;
  resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
}): ResolverItem[] {
  const expanded = r.expanded_items ?? [];
  if (expanded.length > 0) {
    return expanded.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty,
    }));
  }
  const resolved = r.resolved_items ?? [];
  return resolved.map((x) => ({
    item_id: x.item_id,
    item_name_canonical: x.item_name_canonical,
    qty: x.qty ?? 1,
  }));
}

export const getRentalVolumeByCategory = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days }) => {
    // Rolling window matching getItemRevenueRanking (convex/items.ts:31-89).
    // Gross-based, pricing_catalog-weighted split across resolved_items.
    // PASS-5: `days` made optional (frontend was not passing it, which
    // crashed the entire Stats Grid via error boundary and hid the
    // Active Drawer).
    const effectiveDays = typeof days === "number" ? days : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - effectiveDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    // Match revenue.ts semantics: drop cancelled/declined/obsolete, then
    // collapse v1/Hygglo duplicates, then restrict to effectiveDate window.
    reservations = reservations.filter(isLive);
    reservations = dedupByLogicalRental(reservations);
    const todayStr = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= cutoffStr && d <= todayStr;
    });

    // Pricing catalog for revenue split weights (canonical → daily_price_min).
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    // Item kind lookup (_id → kind).
    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, string>();
    for (const it of items) kindById.set(it._id as string, it.kind);

    const countByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();

    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      const gross = r.gross_paid_gbp ?? 0;
      const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
      const priceSum = prices.reduce((a, b) => a + b, 0);
      resolved.forEach((x, idx) => {
        const share =
          priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
        const k = kindById.get(x.item_id) ?? "unknown";
        countByKind.set(k, (countByKind.get(k) ?? 0) + (x.qty ?? 1));
        revenueByKind.set(k, (revenueByKind.get(k) ?? 0) + share);
      });
    }

    // Assemble entries (any kind with count>0 OR revenue>0).
    const kinds = new Set<string>([...countByKind.keys(), ...revenueByKind.keys()]);
    const entries = Array.from(kinds)
      .map((k) => ({
        kind: k,
        label: labelFor(k),
        count: countByKind.get(k) ?? 0,
        revenue: revenueByKind.get(k) ?? 0,
      }))
      .filter((e) => e.count > 0 || e.revenue > 0)
      .sort((a, b) => b.count - a.count);

    // Pre-truncation totals.
    const totals = {
      count: entries.reduce((s, e) => s + e.count, 0),
      revenue: Math.round(entries.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
    };

    // Top 6 + Other.
    const top = entries.slice(0, 6);
    const rest = entries.slice(6);
    const slices: Array<{
      kind: string;
      label: string;
      count: number;
      revenue: number;
      color: string;
    }> = top.map((e, i) => ({
      kind: e.kind,
      label: e.label,
      count: e.count,
      revenue: Math.round(e.revenue * 100) / 100,
      color: CATEGORY_PALETTE[i] ?? OTHER_COLOR,
    }));
    if (rest.length > 0) {
      const otherCount = rest.reduce((s, e) => s + e.count, 0);
      const otherRevenue = rest.reduce((s, e) => s + e.revenue, 0);
      if (otherCount > 0) {
        slices.push({
          kind: "other",
          label: "Other",
          count: otherCount,
          revenue: Math.round(otherRevenue * 100) / 100,
          color: OTHER_COLOR,
        });
      }
    }

    return {
      days: effectiveDays,
      periodStart: cutoffStr,
      slices,
      totals,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down: items within a kind (or items in the "other" merged bucket)
// for the same period/account as getRentalVolumeByCategory. Single-level.
// ─────────────────────────────────────────────────────────────────────────────

export const getRentalVolumeKindBreakdown = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
    kind: v.string(),
  },
  handler: async (ctx, { accountSlug, days, kind }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(isLive);
    reservations = dedupByLogicalRental(reservations);
    const todayStr = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= cutoffStr && d <= todayStr;
    });

    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, { kind: string; name: string }>();
    for (const it of items) {
      kindById.set(it._id as string, {
        kind: it.kind,
        name: (it as { name_canonical?: string }).name_canonical ?? it.kind,
      });
    }

    // First pass: count by kind to determine the top-6/other split, mirroring
    // the main query so "other" drill-down resolves to the same set.
    const countByKind = new Map<string, number>();
    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      for (const x of resolved) {
        const k = kindById.get(x.item_id)?.kind ?? "unknown";
        countByKind.set(k, (countByKind.get(k) ?? 0) + (x.qty ?? 1));
      }
    }
    const rankedKinds = Array.from(countByKind.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    const topKinds = new Set(rankedKinds.slice(0, 6));
    const otherKinds = new Set(rankedKinds.slice(6));

    const isInTargetSet = (k: string): boolean => {
      if (kind === "other") return otherKinds.has(k);
      return k === kind;
    };

    // Second pass: split each row's gross across ALL resolved items (to keep
    // attribution math identical to the main query), then keep only the
    // in-target items.
    const itemCount = new Map<string, number>();
    const itemRevenue = new Map<string, number>();
    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      const gross = r.gross_paid_gbp ?? 0;
      const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
      const priceSum = prices.reduce((a, b) => a + b, 0);
      resolved.forEach((x, idx) => {
        const k = kindById.get(x.item_id)?.kind ?? "unknown";
        if (!isInTargetSet(k)) return;
        const share =
          priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
        itemCount.set(x.item_id, (itemCount.get(x.item_id) ?? 0) + (x.qty ?? 1));
        itemRevenue.set(x.item_id, (itemRevenue.get(x.item_id) ?? 0) + share);
      });
    }

    type ItemSlice = { itemId: string; name: string; count: number; revenue: number; color: string };
    const allIds = new Set<string>([...itemCount.keys(), ...itemRevenue.keys()]);
    const entries: ItemSlice[] = Array.from(allIds)
      .map((id) => ({
        itemId: id,
        name: kindById.get(id)?.name ?? id,
        count: itemCount.get(id) ?? 0,
        revenue: Math.round((itemRevenue.get(id) ?? 0) * 100) / 100,
        color: "",
      }))
      .filter((e) => e.count > 0 || e.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);

    const PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee"];
    // Show each item individually (no "Other items" bucket). Cap at top-15 by
    // revenue to keep middle-ring labels readable.
    const items_out: ItemSlice[] = entries.slice(0, 15).map((e, i) => ({
      ...e,
      color: PALETTE[i % PALETTE.length],
    }));

    const totals = {
      count: items_out.reduce((s, e) => s + e.count, 0),
      revenue: Math.round(items_out.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
    };

    return {
      days,
      periodStart: cutoffStr,
      kind,
      kindLabel: labelFor(kind),
      items: items_out,
      totals,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-kinds of the "Other" bucket: rolls the same dataset as
// getRentalVolumeByCategory but only over the kinds that were NOT in the top-6.
// Same isLive/dedup/effectiveDate filters so totals reconcile.
// ─────────────────────────────────────────────────────────────────────────────

export const getRentalVolumeOtherSubKinds = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const effectiveDays = typeof days === "number" ? days : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - effectiveDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(isLive);
    reservations = dedupByLogicalRental(reservations);
    const todayStr = new Date().toISOString().slice(0, 10);
    reservations = reservations.filter((r) => {
      const d = effectiveDate(r);
      return d !== undefined && d >= cutoffStr && d <= todayStr;
    });

    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByCanonical = new Map<string, number>(
      pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    const items = await ctx.db.query("items").collect();
    const kindById = new Map<string, string>();
    for (const it of items) kindById.set(it._id as string, it.kind);

    const countByKind = new Map<string, number>();
    const revenueByKind = new Map<string, number>();

    for (const r of reservations) {
      const resolved =
        (r as {
          resolved_items?: Array<{ item_id: string; item_name_canonical: string; qty?: number }>;
        }).resolved_items ?? [];
      if (resolved.length === 0) continue;
      const gross = r.gross_paid_gbp ?? 0;
      const prices = resolved.map((x) => priceByCanonical.get(x.item_name_canonical) ?? 0);
      const priceSum = prices.reduce((a, b) => a + b, 0);
      resolved.forEach((x, idx) => {
        const share =
          priceSum > 0 ? gross * (prices[idx] / priceSum) : gross / resolved.length;
        const k = kindById.get(x.item_id) ?? "unknown";
        countByKind.set(k, (countByKind.get(k) ?? 0) + (x.qty ?? 1));
        revenueByKind.set(k, (revenueByKind.get(k) ?? 0) + share);
      });
    }

    const kinds = new Set<string>([...countByKind.keys(), ...revenueByKind.keys()]);
    const entries = Array.from(kinds)
      .map((k) => ({
        kind: k,
        label: labelFor(k),
        count: countByKind.get(k) ?? 0,
        revenue: revenueByKind.get(k) ?? 0,
      }))
      .filter((e) => e.count > 0 || e.revenue > 0)
      .sort((a, b) => b.count - a.count);

    // Same split as main query: top 6 stay top, rest = "Other".
    const rest = entries.slice(6);
    const PALETTE = ["#60a5fa", "#34d399", "#a78bfa", "#fbbf24", "#f87171", "#22d3ee", "#ec4899", "#14b8a6", "#eab308", "#8b5cf6", "#f97316", "#10b981", "#3b82f6", "#d946ef", "#84cc16", "#cbd5e1"];
    const slices = rest.map((e, i) => ({
      kind: e.kind,
      label: e.label,
      count: e.count,
      revenue: Math.round(e.revenue * 100) / 100,
      color: PALETTE[i % PALETTE.length],
    }));

    const totals = {
      count: slices.reduce((s, e) => s + e.count, 0),
      revenue: Math.round(slices.reduce((s, e) => s + e.revenue, 0) * 100) / 100,
    };

    return {
      days: effectiveDays,
      periodStart: cutoffStr,
      slices,
      totals,
    };
  },
});
