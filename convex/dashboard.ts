import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  dedupByLogicalRental,
  effectiveDate,
  isConfirmedWithDates,
  isOngoing,
  isPendingVerification,
  isUpcoming,
  netOf,
} from "./lib/reservations/predicates";

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

    let allReservations = await ctx.db.query("reservations").collect();
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

    // ── COLLECT 1: reservations ──────────────────────────────────
    let allRes = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      allRes = allRes.filter((r) => r.account_slug === accountSlug);
    }

    // ── COLLECT 2: items ─────────────────────────────────────────
    let allItems = await ctx.db.query("items").collect();
    if (accountSlug) {
      // items are cross-account; no slug filter needed for inventory_worth
      // but keep full list for out-of-stock which is also cross-account
    }
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

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

    const daysBetween = (a: string, b: string): number => {
      const ms = Date.parse(b) - Date.parse(a);
      return Math.max(1, Math.round(ms / 86400000) + 1);
    };

    const mapRental = (r: ResRow, kind: "ongoing" | "upcoming" | "pending") => ({
      reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
      renter_name: r.renter_name ?? null,
      account_slug: r.account_slug ?? "",
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      pickup_date: r.pickup_date ?? r.start_date ?? null,
      pickup_time: r.pickup_time ?? null,
      return_time: r.return_time ?? null,
      items: (r.items ?? []).map((i) => i.item_name),
      photo_url: (r.photos_urls ?? [])[0] ?? null,
      duration_days:
        r.duration_days ??
        (r.start_date && r.end_date ? daysBetween(r.start_date as string, r.end_date as string) : null),
      net_gbp: r.net_to_owner_gbp ?? null,
      order_step: r.order_step ?? null,
      kind,
      is_ongoing: kind === "ongoing",
    });

    const activeRentals = [
      ...ongoingUniq.map((r) => mapRental(r, "ongoing")),
      ...upcomingUniq.map((r) => mapRental(r, "upcoming")),
      ...pendingUniq.map((r) => mapRental(r, "pending")),
    ].slice(0, 30);

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
    const confirmed = {
      month_count: monthBookedRentals.length,
      month_revenue: Math.round(monthBookedRevenue * 100) / 100,
      done_count: monthDone.length,
      active_count: monthActive.length,
      upcoming_count: monthUpcoming.length,
      pending_count: monthPending.length,
      pending_value_gbp: Math.round(monthPendingValue * 100) / 100,
      total_rentals: monthDone.length + monthActive.length + monthUpcoming.length + monthPending.length,
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
        stage: ((c as any).stage as string | undefined) ?? null,
        payoutAmountGbp: ((c as any).payout_amount_gbp as number | undefined) ?? null,
        creditedToMonth: ((c as any).credited_to_month as string | undefined) ?? null,
        creditedAt: ((c as any).credited_at as number | undefined) ?? null,
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
        pending_count: pendingCount,
        pending_value_gbp: Math.round(pendingValueGbp * 100) / 100,
        rentals: activeRentals,
      },
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
