import type { ContextBundle } from "../../convex/dashboard_chat_context";
import type { SyncStateDoc } from "./lib/tool-envelope";

type SyncState = SyncStateDoc | null;

/**
 * Converts the live ContextBundle into a system-prompt string.
 * Mirrors the section structure from v1 app.controller.ts:706-810.
 * Null / empty sections are omitted entirely.
 * Target: 800-1200 tokens (trim longest sections first if oversized).
 *
 * opts.syncState — pass the sync_state row for the hygglo_poller source.
 * opts.generatedAt — ms epoch when this snapshot was taken (default Date.now()).
 */
export function formatContext(
  ctx: ContextBundle,
  opts?: { syncState?: SyncState | null; generatedAt?: number }
): string {
  const parts: string[] = [];
  const generatedAt = opts?.generatedAt ?? Date.now();
  const syncState = opts?.syncState ?? null;

  // ── Freshness header ─────────────────────────────────────────
  const generatedIso = new Date(generatedAt).toISOString();
  let syncInfo: string;
  if (syncState?.lastRunAt) {
    const syncIso = new Date(syncState.lastRunAt).toISOString();
    const staleMin = Math.round((generatedAt - syncState.lastRunAt) / 60_000);
    syncInfo = `${syncIso} (${staleMin} min ago)`;
  } else {
    syncInfo = "unknown";
  }
  parts.push(
    `--- LIVE BUSINESS CONTEXT (SNAPSHOT) ---\n` +
      `Generated: ${generatedIso}; last Hygglo sync: ${syncInfo}.\n` +
      `This block is a snapshot. For authoritative facts (pricing, availability, pending rentals, top earners) you MUST call the corresponding tool.`
  );

  // ── CRITICAL ALERTS — removed W2a (2026-05-15) ────────────────
  // Conflicts / untracked claims / pending shadow actions / model-upgrade
  // advisories used to ship inline every turn (~600 tok). The agent now
  // pulls them on demand via the `query_alerts` tool — see SYSTEM_PROMPT
  // note in src/mastra/agents/dashboard-chat.ts. The `criticalAlerts`
  // field is still produced by getContextBundle for backward compat with
  // non-prompt consumers; it is just no longer stringified here.

    // ── TODAY'S SCHEDULE — grouped by orderId ───────────────────
  if (ctx.todaySchedule.entries.length > 0) {
    // Group entries by orderId
    const orderMap = new Map<
      string,
      { renterName: string; accountSlug?: string; type: string; items: string[] }
    >();
    for (const e of ctx.todaySchedule.entries) {
      const key = e.orderId ?? `${e.renterName}:${e.type}`;
      const existing = orderMap.get(key);
      if (existing) {
        // Merge items (deduplicate)
        for (const item of e.items) {
          if (!existing.items.includes(item)) existing.items.push(item);
        }
        // If one leg is pickup and another is return for same order, mark same_day
        if (existing.type !== e.type) existing.type = "same_day";
      } else {
        orderMap.set(key, {
          renterName: e.renterName,
          accountSlug: e.accountSlug,
          type: e.type,
          items: [...e.items],
        });
      }
    }

    const lines: string[] = [];
    for (const [, order] of orderMap) {
      const itemStr =
        order.items.slice(0, 3).join(", ") +
        (order.items.length > 3 ? ` +${order.items.length - 3} more` : "");
      const tag = order.accountSlug ? ` [${order.accountSlug}]` : "";
      let typeLabel: string;
      if (order.type === "same_day") {
        typeLabel = "Pickup & Return today";
      } else {
        typeLabel = order.type.toUpperCase();
      }
      lines.push(`- ${typeLabel}: ${itemStr} — ${order.renterName}${tag}`);
    }
    parts.push(
      "TODAY'S SCHEDULE (" + ctx.todaySchedule.date + "):\n" + lines.join("\n")
    );
  }

  // ── BLACKLIST (≤3 lines) ─────────────────────────────────────
  if (ctx.blacklist.count > 0) {
    const shown = ctx.blacklist.names.slice(0, 3);
    const more =
      ctx.blacklist.count > 3 ? ` (+${ctx.blacklist.count - 3} more)` : "";
    parts.push(
      `BLACKLIST: ${ctx.blacklist.count} renter${ctx.blacklist.count !== 1 ? "s" : ""} — ${shown.join(", ")}${more}`
    );
  }

  // ── UPCOMING BOOKINGS (14d) — capped at 5 for snapshot ──────
  if (ctx.upcomingBookings14d.length > 0) {
    const capped = ctx.upcomingBookings14d.slice(0, 5);
    const lines = capped.map((b) => {
      const itemStr =
        b.items.slice(0, 2).join(", ") +
        (b.items.length > 2 ? ` +${b.items.length - 2} more` : "");
      const dur = b.durationDays ? `, ${b.durationDays}d` : "";
      const gross = b.gross > 0 ? `, £${b.gross.toFixed(0)}` : "";
      const acct = b.accountSlug ? ` [${b.accountSlug}]` : "";
      return `- ${b.date}: ${itemStr}${dur}${gross} — ${b.renterName}${acct}`;
    });
    const more =
      ctx.upcomingBookings14d.length > 5
        ? `\n  (+ ${ctx.upcomingBookings14d.length - 5} more bookings)`
        : "";
    parts.push(
      "UPCOMING BOOKINGS (next 14 days):\n" + lines.join("\n") + more
    );
  }

  // ── CURRENT REVENUE (with sync annotation) ──────────────────
  const syncAnnotation =
    syncState?.lastRunAt
      ? ` (${Math.round((generatedAt - syncState.lastRunAt) / 60_000)} min ago)`
      : "";
  parts.push(
    "CURRENT REVENUE:\n" +
      `Today: £${ctx.currentRevenue.today.toFixed(2)}\n` +
      `This week: £${ctx.currentRevenue.week.toFixed(2)}\n` +
      `This month: £${ctx.currentRevenue.month.toFixed(2)}${syncAnnotation}`
  );

  // ── REVENUE INTELLIGENCE (≤3 lines) ─────────────────────────
  const ri = ctx.revenueIntelligence;
  if (ri.thisMonth > 0 || ri.lastMonth > 0) {
    const lines = [
      `This month: £${ri.thisMonth.toFixed(2)}`,
      `Last month: £${ri.lastMonth.toFixed(2)}`,
      `YTD: £${ri.ytd.toFixed(2)}`,
    ];
    parts.push(
      "REVENUE INTELLIGENCE:\n" + lines.map((l) => "- " + l).join("\n")
    );
  }

  // ── BUSINESS INTELLIGENCE (≤3 lines) ────────────────────────
  const bi = ctx.businessIntelligence;
  const hasBI = bi.underutilized.length > 0 || bi.demandSignals.length > 0;
  if (hasBI) {
    const biLines: string[] = [];
    if (bi.demandSignals.length > 0) {
      biLines.push(
        "High demand: " +
          bi.demandSignals
            .slice(0, 3)
            .map((d) => d.name + " (" + d.signal + ")")
            .join(", ")
      );
    }
    if (bi.underutilized.length > 0) {
      biLines.push(
        "Underutilised: " + bi.underutilized.slice(0, 3).join(", ")
      );
    }
    parts.push(
      "BUSINESS INTELLIGENCE:\n" + biLines.map((l) => "- " + l).join("\n")
    );
  }

  // ── ITEM EARNINGS — top 5 for snapshot ──────────────────────
  if (ctx.itemEarnings.length > 0) {
    const lines = ctx.itemEarnings.slice(0, 5).map(
      (e) =>
        `- ${e.name}: £${e.totalRevenue.toFixed(0)} (${e.rentalCount} rental${e.rentalCount !== 1 ? "s" : ""})`
    );
    const more =
      ctx.itemEarnings.length > 5
        ? `\n  (+ ${ctx.itemEarnings.length - 5} more items tracked)`
        : "";
    parts.push(
      "ITEM EARNINGS (all-time, top earners):\n" + lines.join("\n") + more
    );
  }

  // ── MONTHLY INCOME (≤3 lines) ────────────────────────────────
  const mi = ctx.monthlyIncome;
  if (mi.lifetime > 0) {
    const recentMonths = mi.last6Months
      .filter((m) => m.revenue > 0)
      .slice(0, 2)
      .map((m) => `${m.month}: £${m.revenue.toFixed(0)}`)
      .join(", ");
    const section =
      `Lifetime: £${mi.lifetime.toFixed(0)}` +
      (recentMonths ? `; recent — ${recentMonths}` : "");
    parts.push("MONTHLY INCOME: " + section);
  }

  // ── BUNDLE PRICING (≤3 lines) ────────────────────────────────
  if (ctx.bundlePricing.length > 0) {
    const lines = ctx.bundlePricing
      .slice(0, 3)
      .map((b) => `- ${b.name}: £${b.daily_min}–£${b.daily_max}/day`);
    parts.push("BUNDLE PRICING:\n" + lines.join("\n"));
  }

  return parts.join("\n\n");
}
