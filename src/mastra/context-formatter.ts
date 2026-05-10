import type { ContextBundle } from "../../convex/dashboard_chat_context";

/**
 * Converts the live ContextBundle into a system-prompt string.
 * Mirrors the section structure from v1 app.controller.ts:706-810.
 * Null / empty sections are omitted entirely.
 * Target: 800-1200 tokens (trim longest sections first if oversized).
 */
export function formatContext(ctx: ContextBundle): string {
  const parts: string[] = [];

  // TODAY'S SCHEDULE
  if (ctx.todaySchedule.entries.length > 0) {
    const lines = ctx.todaySchedule.entries.map((e) => {
      const itemStr = e.items.slice(0, 3).join(", ") +
        (e.items.length > 3 ? ` +${e.items.length - 3} more` : "");
      const tag = e.accountSlug ? ` [${e.accountSlug}]` : "";
      return `- ${e.type.toUpperCase()}: ${itemStr} — ${e.renterName}${tag}`;
    });
    parts.push("TODAY'S SCHEDULE (" + ctx.todaySchedule.date + "):\n" + lines.join("\n"));
  }

  // BLACKLIST
  if (ctx.blacklist.count > 0) {
    const lines = ctx.blacklist.names.slice(0, 10).map((n) => "- " + n);
    parts.push(
      "BLACKLIST: " + ctx.blacklist.count + " renter" + (ctx.blacklist.count !== 1 ? "s" : "") + "\n" +
        lines.join("\n")
    );
  }

  // UPCOMING BOOKINGS (14d) — capped at 15 entries to control token count
  if (ctx.upcomingBookings14d.length > 0) {
    const capped = ctx.upcomingBookings14d.slice(0, 15);
    const lines = capped.map((b) => {
      const itemStr = b.items.slice(0, 2).join(", ") +
        (b.items.length > 2 ? ` +${b.items.length - 2} more` : "");
      const dur = b.durationDays ? `, ${b.durationDays}d` : "";
      const gross = b.gross > 0 ? `, £${b.gross.toFixed(0)}` : "";
      const acct = b.accountSlug ? ` [${b.accountSlug}]` : "";
      return `- ${b.date}: ${itemStr}${dur}${gross} — ${b.renterName}${acct}`;
    });
    const more =
      ctx.upcomingBookings14d.length > 15
        ? `\n  (+ ${ctx.upcomingBookings14d.length - 15} more bookings)`
        : "";
    parts.push("UPCOMING BOOKINGS (next 14 days):\n" + lines.join("\n") + more);
  }

  // CURRENT REVENUE
  parts.push(
    "CURRENT REVENUE:\n" +
      `Today: £${ctx.currentRevenue.today.toFixed(2)}\n` +
      `This week: £${ctx.currentRevenue.week.toFixed(2)}\n` +
      `This month: £${ctx.currentRevenue.month.toFixed(2)}\n` +
      `Projected month: £${ctx.currentRevenue.projected}`
  );

  // REVENUE INTELLIGENCE
  const ri = ctx.revenueIntelligence;
  if (ri.thisMonth > 0 || ri.lastMonth > 0) {
    const lines = [
      `This month: £${ri.thisMonth.toFixed(2)}`,
      `Last month: £${ri.lastMonth.toFixed(2)}`,
      `YTD: £${ri.ytd.toFixed(2)}`,
      `Projected (this month): £${ri.projectedThisMonth}`,
    ];
    if (ri.deniedRevenue90d > 0) {
      lines.push(`Denied/missed revenue (90d): £${ri.deniedRevenue90d.toFixed(2)}`);
    }
    parts.push("REVENUE INTELLIGENCE:\n" + lines.map((l) => "- " + l).join("\n"));
  }

  // BUSINESS INTELLIGENCE
  const bi = ctx.businessIntelligence;
  const hasBI = bi.underutilized.length > 0 || bi.demandSignals.length > 0;
  if (hasBI) {
    const biLines: string[] = [];
    if (bi.demandSignals.length > 0) {
      biLines.push(
        "High demand: " +
          bi.demandSignals
            .slice(0, 5)
            .map((d) => d.name + " (" + d.signal + ")")
            .join(", ")
      );
    }
    if (bi.underutilized.length > 0) {
      biLines.push(
        "Underutilised items: " + bi.underutilized.slice(0, 5).join(", ")
      );
    }
    parts.push("BUSINESS INTELLIGENCE:\n" + biLines.map((l) => "- " + l).join("\n"));
  }

  // ITEM EARNINGS (top 10 shown inline; top 20 available in full context)
  if (ctx.itemEarnings.length > 0) {
    const lines = ctx.itemEarnings.slice(0, 10).map(
      (e) =>
        `- ${e.name}: £${e.totalRevenue.toFixed(0)} (${e.rentalCount} rental${e.rentalCount !== 1 ? "s" : ""})`
    );
    const more =
      ctx.itemEarnings.length > 10
        ? `\n  (+ ${ctx.itemEarnings.length - 10} more items tracked)`
        : "";
    parts.push("ITEM EARNINGS (all-time, top earners):\n" + lines.join("\n") + more);
  }

  // MONTHLY INCOME
  const mi = ctx.monthlyIncome;
  if (mi.lifetime > 0) {
    const monthLines = mi.last6Months
      .filter((m) => m.revenue > 0)
      .map((m) => `- ${m.month}: £${m.revenue.toFixed(0)}`);
    const section =
      `Lifetime total: £${mi.lifetime.toFixed(0)}` +
      (monthLines.length > 0 ? "\nLast 6 months:\n" + monthLines.join("\n") : "");
    parts.push("MONTHLY INCOME:\n" + section);
  }

  // BUNDLE PRICING
  if (ctx.bundlePricing.length > 0) {
    const lines = ctx.bundlePricing
      .slice(0, 8)
      .map(
        (b) =>
          `- ${b.name}: £${b.daily_min}–£${b.daily_max}/day`
      );
    parts.push("BUNDLE PRICING:\n" + lines.join("\n"));
  }

  // competitorIntelligence: always null in this phase — section omitted

  return parts.join("\n\n");
}
