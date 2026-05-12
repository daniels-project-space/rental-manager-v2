import { query } from "./_generated/server";

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

export type ContextBundle = {
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
};

export const getContextBundle = query({
  args: {},
  handler: async (ctx): Promise<ContextBundle> => {
    const today = TODAY();
    const in14d = addDays(today, 14);

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

    // effectiveDate helper
    const effectiveDate = (r: { pickup_date?: string; start_date?: string }) =>
      r.pickup_date ?? r.start_date;

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
    const confirmedFuture = allReservations
      .filter(
        (r) =>
          r.status === "confirmed" &&
          r.start_date &&
          r.start_date > today &&
          r.start_date >= thisMonth.start &&
          r.start_date <= thisMonth.end
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

    return {
      todaySchedule: { date: today, entries: todayEntries },
      blacklist: { count: blacklisted.length, names: blacklistNames },
      upcomingBookings14d: upcoming,
      revenueIntelligence: {
        thisMonth: Math.round(thisMonthRev * 100) / 100,
        lastMonth: Math.round(lastMonthRev * 100) / 100,
        ytd: Math.round(ytdRev * 100) / 100,
        projectedThisMonth,
        deniedRevenue90d: Math.round(deniedRevenue90d * 100) / 100,
      },
      businessIntelligence: {
        underutilized: underutilized.slice(0, 10),
        demandSignals: demandSignals.slice(0, 10),
      },
      currentRevenue: {
        today: Math.round(todayRev * 100) / 100,
        week: Math.round(weekRev * 100) / 100,
        month: Math.round(monthRev2 * 100) / 100,
        projected: projectedThisMonth,
      },
      itemEarnings,
      monthlyIncome: {
        lifetime: Math.round(lifetimeTotal * 100) / 100,
        last6Months: last6,
      },
      bundlePricing,
    };
  },
});
