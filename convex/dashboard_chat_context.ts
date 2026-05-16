import { v } from "convex/values";
import { query } from "./_generated/server";
import { effectiveDate, isConfirmedWithDates, isUpcoming } from "./lib/reservations/predicates";

const TODAY = () => new Date().toISOString().slice(0, 10);

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthBounds(offsetMonths: number) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + offsetMonths;
  const start = new Date(y, m, 1).toISOString().slice(0, 10);
  const end = new Date(y, m + 1, 0).toISOString().slice(0, 10);
  return { start, end };
}

export type TodayScheduleEntry = {
  type: "pickup" | "return" | "same_day";
  items: string[];
  renterName: string;
  accountSlug: string | undefined;
  orderId: string;
};

export type UpcomingBooking = {
  date: string;
  accountSlug: string | undefined;
  items: string[];
  renterName: string;
  gross: number;
  durationDays: number | undefined;
};

export type ItemEarning = {
  name: string;
  totalRevenue: number;
  rentalCount: number;
};

export type MonthRevenue = {
  month: string;
  revenue: number;
};

export type BundlePricingEntry = {
  name: string;
  daily_min: number;
  daily_max: number;
};

// ── Snapshot input shape (passed in from Next.js layer that CAN read R2) ─
// Convex queries run in V8 isolate — no S3 SDK / no R2 reads.
// Callers (chat route) hydrate snapshots via HydrationLayer.loadSnapshot()
// and pass them through. Missing/null → legacy 5-scan fallback path.
export type ContextBundleSnapshots = {
  daily_briefing?: {
    todayEarningsGbp?: number;
    activeRentalsCount?: number;
    pendingRequestsCount?: number;
    overdueReturnsCount?: number;
    topItemsToday?: Array<{ name: string; gbp: number; count: number }>;
    summary?: string;
  } | null;
  inventory_overview?: {
    totalItems?: number;
    totalQty?: number;
    items?: Array<{ name_canonical: string; qty: number }>;
  } | null;
  top_renters?: {
    lookbackDays?: number;
    rows?: Array<{
      renterId?: string;
      renterName?: string;
      grossGbp?: number;
      rentalCount?: number;
    }>;
  } | null;
  // Per-month aggregate from R2 `by_month` index (lifetime + last 6 mo).
  by_month?: Array<{ month: string; revenue: number }> | null;
};

export type ContextBundle = {
  _source: "snapshots" | "legacy" | "hybrid";
  _caveats: string[];
  todaySchedule: {
    date: string;
    entries: TodayScheduleEntry[];
  };
  blacklist: {
    count: number;
    names: string[];
  };
  upcomingBookings14d: UpcomingBooking[];
  revenueIntelligence: {
    thisMonth: number;
    lastMonth: number;
    ytd: number;
    projectedThisMonth: number;
    deniedRevenue90d: number;
  };
  businessIntelligence: {
    underutilized: string[];
    demandSignals: Array<{ name: string; signal: string }>;
  };
  currentRevenue: {
    today: number;
    week: number;
    month: number;
    projected: number;
  };
  itemEarnings: ItemEarning[];
  monthlyIncome: {
    lifetime: number;
    last6Months: MonthRevenue[];
  };
  bundlePricing: BundlePricingEntry[];
  criticalAlerts: {
    conflictCount: number;
    untrackedCount: number;
    conflicts: Array<{
      item_canonical: string;
      qty: number;
      overlap_count: number;
      conflict_start: string;
      renters: string[];
    }>;
  };
};

// ── Snapshot validator (optional, pass-through-typed) ──────────────────
// Convex's v.any() keeps the wire shape flexible; field-level use is
// guarded by runtime checks before consumption.
const snapshotsValidator = v.optional(
  v.object({
    daily_briefing: v.optional(v.union(v.null(), v.any())),
    inventory_overview: v.optional(v.union(v.null(), v.any())),
    top_renters: v.optional(v.union(v.null(), v.any())),
    by_month: v.optional(v.union(v.null(), v.any())),
  }),
);

export const getContextBundle = query({
  args: { snapshots: snapshotsValidator },
  handler: async (ctx, args): Promise<ContextBundle> => {
    const today = TODAY();
    const in14d = addDays(today, 14);

    // ── Snapshot-first branch ────────────────────────────────────────
    // If caller passed all required snapshots, derive parts of the bundle
    // from those + skip the corresponding heavy collect() scans. Missing
    // snapshots fall back to the original 5-scan path below (preserved).
    const snaps = (args.snapshots ?? {}) as ContextBundleSnapshots;
    const snapshotCaveats: string[] = [];
    const haveBriefing = snaps.daily_briefing !== undefined && snaps.daily_briefing !== null;
    const haveInventory = snaps.inventory_overview !== undefined && snaps.inventory_overview !== null;
    const haveTopRenters = snaps.top_renters !== undefined && snaps.top_renters !== null;
    const haveByMonth = snaps.by_month !== undefined && snaps.by_month !== null;
    const allSnapshotsPresent = haveBriefing && haveInventory && haveTopRenters && haveByMonth;
    if (!haveBriefing) snapshotCaveats.push("snapshot_unavailable_daily_briefing");
    if (!haveInventory) snapshotCaveats.push("snapshot_unavailable_inventory_overview");
    if (!haveTopRenters) snapshotCaveats.push("snapshot_unavailable_top_renters");
    if (!haveByMonth) snapshotCaveats.push("snapshot_unavailable_by_month");

    // load raw data in parallel
    const [allReservations, allRenters, bundleRows, pricingRows, histRevRows] =
      await Promise.all([
        ctx.db.query("reservations").collect(),
        ctx.db.query("renters").collect(),
        ctx.db.query("bundles").collect(),
        ctx.db.query("pricing_catalog").collect(),
        ctx.db.query("historical_revenue").collect(),
      ]);

    const renterNameById = new Map<string, string>();
    for (const r of allRenters) {
      renterNameById.set(r._id, r.display_name ?? "Unknown");
    }

    // effectiveDate imported from predicates

    // 1. TODAY'S SCHEDULE
    const todayEntries: TodayScheduleEntry[] = [];
    for (const r of allReservations) {
      if (r.status === "cancelled" || r.status === "declined") continue;
      const renterName = r.renter_id
        ? (renterNameById.get(r.renter_id as string) ?? "?")
        : "?";
      const items = (r.items ?? []).map((i) => i.item_name);
      const orderId: string = (r.hygglo_order_id as string | undefined) ?? (r._id as string);
      if (r.start_date === today && r.end_date === today) {
        todayEntries.push({ type: "same_day", items, renterName, accountSlug: r.account_slug, orderId });
      } else if (r.start_date === today) {
        todayEntries.push({ type: "pickup", items, renterName, accountSlug: r.account_slug, orderId });
      } else if (r.end_date === today) {
        todayEntries.push({ type: "return", items, renterName, accountSlug: r.account_slug, orderId });
      }
    }

    // 2. BLACKLIST
    const blacklisted = allRenters.filter(
      (r) => r.blacklisted === true || r.blacklist === true
    );
    const blacklistNames = blacklisted.map((r) => {
      const name = r.display_name ?? r.email ?? "Unknown";
      return r.blacklist_reason ? name + " (" + r.blacklist_reason + ")" : name;
    });

    // 3. UPCOMING 14d BOOKINGS
    const upcoming: UpcomingBooking[] = [];
    for (const r of allReservations) {
      if (r.status === "cancelled" || r.status === "declined") continue;
      const sd = r.start_date;
      if (!sd || sd <= today || sd > in14d) continue;
      upcoming.push({
        date: sd,
        accountSlug: r.account_slug,
        items: (r.items ?? []).map((i) => i.item_name),
        renterName: r.renter_id
          ? (renterNameById.get(r.renter_id as string) ?? "?")
          : "?",
        gross: r.gross_paid_gbp ?? 0,
        durationDays: r.duration_days,
      });
    }
    upcoming.sort((a, b) => a.date.localeCompare(b.date));

    // 4. REVENUE INTELLIGENCE
    const thisMonth = monthBounds(0);
    const lastMonth = monthBounds(-1);
    const yearStart = new Date().getFullYear() + "-01-01";

    let thisMonthRev = 0;
    let lastMonthRev = 0;
    let ytdRev = 0;
    for (const r of allReservations) {
      if (r.status === "cancelled" || r.status === "declined") continue;
      const d = effectiveDate(r);
      if (!d) continue;
      const gross = r.gross_paid_gbp ?? 0;
      if (d >= thisMonth.start && d <= thisMonth.end) thisMonthRev += gross;
      if (d >= lastMonth.start && d <= lastMonth.end) lastMonthRev += gross;
      if (d >= yearStart && d <= today) ytdRev += gross;
    }

    // denial-based missed revenue (90d)
    const cutoff90 = new Date();
    cutoff90.setDate(cutoff90.getDate() - 90);
    const denials = await ctx.db.query("denial_records").collect();
    const priceByName = new Map(
      pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min])
    );
    let deniedRevenue90d = 0;
    for (const d of denials) {
      if (d.created_at < cutoff90.getTime()) continue;
      deniedRevenue90d +=
        d.estimated_value ??
        (d.item_name ? (priceByName.get(d.item_name) ?? 0) * 2 : 0);
    }

    // month projection
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const dailyAvg = daysElapsed > 0 ? thisMonthRev / daysElapsed : 0;
    // Use canonical isUpcoming predicate; window-clamp afterwards.
    const confirmedFuture = allReservations
      .filter(
        (r) =>
          isUpcoming(r as any, today) &&
          (r.start_date as string) >= thisMonth.start &&
          (r.start_date as string) <= thisMonth.end,
      )
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const projectedThisMonth = Math.round(
      thisMonthRev + confirmedFuture + dailyAvg * (daysInMonth - daysElapsed)
    );

    // 5. BUSINESS INTELLIGENCE
    const cutoff90Str = cutoff90.toISOString().slice(0, 10);
    const cutoff30Str = new Date(Date.now() - 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const recent90 = allReservations.filter(
      (r) => r.start_date !== undefined && r.start_date >= cutoff90Str
    );
    const rentalDays90 = new Map<string, number>();
    for (const r of recent90) {
      for (const item of r.items ?? []) {
        rentalDays90.set(
          item.item_name,
          (rentalDays90.get(item.item_name) ?? 0) + (r.duration_days ?? 0)
        );
      }
    }
    // underutilised: items rented but < 20% of 90 days
    const underutilized: string[] = [];
    for (const [name, days] of rentalDays90.entries()) {
      if (days / 90 < 0.2) underutilized.push(name);
    }
    underutilized.sort();

    // demand signals: 3+ bookings in last 30d
    const freq30 = new Map<string, number>();
    for (const r of allReservations) {
      if (!r.start_date || r.start_date < cutoff30Str) continue;
      for (const item of r.items ?? []) {
        freq30.set(item.item_name, (freq30.get(item.item_name) ?? 0) + 1);
      }
    }
    const demandSignals: Array<{ name: string; signal: string }> = [];
    for (const [name, count] of freq30.entries()) {
      if (count >= 3) demandSignals.push({ name, signal: count + " bookings in 30d" });
    }
    demandSignals.sort((a, b) => b.signal.localeCompare(a.signal));

    // 6. CURRENT REVENUE
    const weekStart = (() => {
      const d = new Date();
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0, 10);
    })();
    const weekEnd = addDays(weekStart, 6);

    let todayRev = 0;
    let weekRev = 0;
    let monthRev2 = 0;
    for (const r of allReservations) {
      if (r.status === "cancelled" || r.status === "declined") continue;
      const d = effectiveDate(r);
      if (!d || d > today) continue;
      const gross = r.gross_paid_gbp ?? 0;
      if (d === today) todayRev += gross;
      if (d >= weekStart && d <= weekEnd) weekRev += gross;
      if (d >= thisMonth.start && d <= thisMonth.end) monthRev2 += gross;
    }

    // 7. ITEM EARNINGS top 20 all-time
    const itemRevMap = new Map<string, { totalRevenue: number; rentalCount: number }>();
    for (const r of allReservations) {
      if (r.status === "cancelled" || r.status === "declined") continue;
      const items = r.items ?? [];
      if (items.length === 0) continue;
      const gross = r.gross_paid_gbp ?? 0;
      for (const item of items) {
        const existing = itemRevMap.get(item.item_name) ?? {
          totalRevenue: 0,
          rentalCount: 0,
        };
        existing.totalRevenue += gross / items.length;
        existing.rentalCount += 1;
        itemRevMap.set(item.item_name, existing);
      }
    }
    const itemEarnings: ItemEarning[] = Array.from(itemRevMap.entries())
      .map(([name, s]) => ({
        name,
        totalRevenue: Math.round(s.totalRevenue * 100) / 100,
        rentalCount: s.rentalCount,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, 20);

    // 8. MONTHLY INCOME (lifetime + last 6)
    const monthRevMap = new Map<string, number>();
    for (const r of allReservations) {
      if (r.status === "cancelled" || r.status === "declined") continue;
      const d = effectiveDate(r);
      if (!d) continue;
      const mo = d.slice(0, 7);
      monthRevMap.set(mo, (monthRevMap.get(mo) ?? 0) + (r.gross_paid_gbp ?? 0));
    }
    // overlay historical revenue for pre-import months
    for (const h of histRevRows) {
      if (!monthRevMap.has(h.month) && h.total_revenue_gbp > 0) {
        monthRevMap.set(h.month, h.total_revenue_gbp);
      }
    }
    const lifetimeTotal = Array.from(monthRevMap.values()).reduce(
      (s, v) => s + v,
      0
    );
    const currentMonthKey = now.toISOString().slice(0, 7);
    const last6: MonthRevenue[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mo = d.toISOString().slice(0, 7);
      if (mo > currentMonthKey) continue;
      last6.push({
        month: mo,
        revenue: Math.round((monthRevMap.get(mo) ?? 0) * 100) / 100,
      });
    }

    // 9. BUNDLE PRICING
    const bundlePricing: BundlePricingEntry[] = bundleRows
      .filter((b) => (b.daily_price_min ?? 0) > 0 || (b.daily_price_max ?? 0) > 0)
      .map((b) => ({
        name: b.bundle_name,
        daily_min: b.daily_price_min ?? 0,
        daily_max: b.daily_price_max ?? 0,
      }))
      .sort((a, b) => b.daily_max - a.daily_max);

    // ── CRITICAL ALERTS ─────────────────────────────────────
    // Mirrors dashboard.getStatsDrawerData.conflicts but inline so the bot
    // gets fresh double-booking signal in every briefing turn. resolved_items
    // is set by item_resolver; rows without resolution are skipped.
    const allItemsCtx = await ctx.db.query("items").collect();
    const activeItemsCtx = allItemsCtx.filter((i) => i.status === "active" && !i.is_marketing_only);
    const horizonEndCtx = addDays(today, 90);
    type Rwi = { _id: string; start_date?: string; end_date?: string; resolved_items?: Array<{ item_id: string }>; renter_name?: string; status?: string; is_obsolete?: boolean };
    const activeRes = (allReservations as Rwi[]).filter((r) =>
      !r.is_obsolete &&
      r.start_date !== undefined && r.end_date !== undefined &&
      (r.status === "confirmed" || r.status === "pending_review")
    );
    const conflictsCtx: ContextBundle["criticalAlerts"]["conflicts"] = [];
    for (const item of activeItemsCtx) {
      if (item.qty < 1) continue;
      const idStr = item._id as string;
      const matches = activeRes.filter((r) => {
        if ((r.start_date as string) > horizonEndCtx) return false;
        return (r.resolved_items ?? []).some((x) => x.item_id === idStr);
      });
      if (matches.length <= item.qty) continue;
      // sweep dates
      const startDates = matches.map((m) => m.start_date as string);
      const candidates = Array.from(new Set([today, ...startDates].filter((d) => d >= today && d <= horizonEndCtx))).sort();
      let worst = 0;
      let worstD = "";
      for (const d of candidates) {
        const c = matches.filter((m) => (m.start_date as string) <= d && (m.end_date as string) >= d).length;
        if (c > worst) { worst = c; worstD = d; }
      }
      if (worst > item.qty && worstD) {
        const overlapping = matches.filter((m) => (m.start_date as string) <= worstD && (m.end_date as string) >= worstD);
        conflictsCtx.push({
          item_canonical: item.name_canonical,
          qty: item.qty,
          overlap_count: worst,
          conflict_start: worstD,
          renters: overlapping.map((m) => m.renter_name ?? "Unknown"),
        });
      }
    }
    conflictsCtx.sort((a, b) => a.conflict_start.localeCompare(b.conflict_start));

    // Untracked = pending_review reservations whose resolved_items is empty or non-inventory.
    const activeItemIdSet = new Set<string>(activeItemsCtx.map((i) => i._id as string));
    let untrackedCount = 0;
    for (const r of allReservations) {
      if (r.is_obsolete) continue;
      if (r.status !== "pending_review") continue;
      const resolved = (r as { resolved_items?: Array<{ item_id: string }> }).resolved_items;
      if (resolved === undefined) continue; // resolver hasn't run — skip
      const tracked = resolved.some((x) => activeItemIdSet.has(x.item_id));
      if (!tracked) untrackedCount++;
    }

    // ── Snapshot overrides (additive — replaces values when snapshot present) ─
    // Critical fields are kept identical in shape; only the SOURCE differs.
    // Legacy values are computed above and remain the fallback baseline.
    let finalRevenueIntelligence = {
      thisMonth: Math.round(thisMonthRev * 100) / 100,
      lastMonth: Math.round(lastMonthRev * 100) / 100,
      ytd: Math.round(ytdRev * 100) / 100,
      projectedThisMonth,
      deniedRevenue90d: Math.round(deniedRevenue90d * 100) / 100,
    };
    let finalCurrentRevenue = {
      today: Math.round(todayRev * 100) / 100,
      week: Math.round(weekRev * 100) / 100,
      month: Math.round(monthRev2 * 100) / 100,
      projected: projectedThisMonth,
    };
    let finalMonthlyIncome: { lifetime: number; last6Months: MonthRevenue[] } = {
      lifetime: Math.round(lifetimeTotal * 100) / 100,
      last6Months: last6,
    };
    if (allSnapshotsPresent) {
      // Override `today` revenue from the MV-backed briefing snapshot.
      const briefing = snaps.daily_briefing!;
      if (typeof briefing.todayEarningsGbp === "number") {
        finalCurrentRevenue = {
          ...finalCurrentRevenue,
          today: Math.round(briefing.todayEarningsGbp * 100) / 100,
        };
      }
      // Override lifetime + last6Months from the by_month aggregate snapshot.
      const byMonth = snaps.by_month!;
      if (Array.isArray(byMonth) && byMonth.length > 0) {
        const snapMonthMap = new Map<string, number>();
        for (const m of byMonth) {
          if (typeof m.month === "string" && typeof m.revenue === "number") {
            snapMonthMap.set(m.month, m.revenue);
          }
        }
        const snapLifetime = Array.from(snapMonthMap.values()).reduce((s, v2) => s + v2, 0);
        const currentMonthKey2 = now.toISOString().slice(0, 7);
        const snapLast6: MonthRevenue[] = [];
        for (let i = 5; i >= 0; i--) {
          const d2 = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const mo2 = d2.toISOString().slice(0, 7);
          if (mo2 > currentMonthKey2) continue;
          snapLast6.push({
            month: mo2,
            revenue: Math.round((snapMonthMap.get(mo2) ?? 0) * 100) / 100,
          });
        }
        finalMonthlyIncome = {
          lifetime: Math.round(snapLifetime * 100) / 100,
          last6Months: snapLast6,
        };
      }
    }
    const sourceLabel: ContextBundle["_source"] = allSnapshotsPresent
      ? "snapshots"
      : (haveBriefing || haveInventory || haveTopRenters || haveByMonth)
        ? "hybrid"
        : "legacy";

    return {
      _source: sourceLabel,
      _caveats: snapshotCaveats,
      todaySchedule: { date: today, entries: todayEntries },
      blacklist: { count: blacklisted.length, names: blacklistNames },
      upcomingBookings14d: upcoming,
      revenueIntelligence: finalRevenueIntelligence,
      businessIntelligence: {
        underutilized: underutilized.slice(0, 10),
        demandSignals: demandSignals.slice(0, 10),
      },
      currentRevenue: finalCurrentRevenue,
      itemEarnings,
      monthlyIncome: finalMonthlyIncome,
      bundlePricing,
      criticalAlerts: {
        conflictCount: conflictsCtx.length,
        untrackedCount,
        conflicts: conflictsCtx.slice(0, 5),
      },
    };
  },
});
