import { query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  FAST_WIDGET_MAX_AGE_MS,
  readWidgetMv,
  widgetSlugKey,
} from "./lib/widget_mv";

export type HealthIssue = {
  severity: "error" | "warning";
  type: string;
  description: string;
  entityId: string;
};

/**
 * 2026-07-12 cost audit: the data-quality scan (items + listing_photos +
 * pricing_catalog full collects + a 365d reservations window) is extracted
 * into this pure function so the hourly mv/widgets refresher computes all
 * 5 account scopes from ONE set of collects. Previously the live query
 * subscribed to account_state — which the poller stamps EVERY cycle — so
 * every open tab re-ran all four scans every ~15 min for an unchanged
 * timestamp.
 *
 * `reservations` must be confirmed-status rows already bounded to the 365d
 * window; the slug filter happens here (order commutes with the original's
 * filter-then-status flow).
 */
export function computeHealthIssues(opts: {
  items: Array<Doc<"items">>;
  photos: Array<Doc<"listing_photos">>;
  pricing: Array<Doc<"pricing_catalog">>;
  reservations: Array<Doc<"reservations">>;
  accountSlug: string | null;
}): HealthIssue[] {
  const { items, photos, pricing, accountSlug } = opts;
  const issues: HealthIssue[] = [];

  // --- Item scan ---
  const activeItems = items.filter((i) => i.status === "active" && !i.is_marketing_only);

  // Hoisted listing_photos load: previously fetched inside the per-item loop
  // (N×M reads). One collect + Set lookup is O(rows + items).
  const photoNames = new Set<string>();
  for (const p of photos) {
    for (const it of p.items ?? []) photoNames.add(it.item_name);
  }

  // Pass 11g (2026-05-25): mirror the listing_photos hoist for pricing.
  const pricingNames = new Set<string>();
  for (const p of pricing) pricingNames.add(p.item_name_canonical);

  for (const item of activeItems) {
    if (!pricingNames.has(item.name_canonical)) {
      issues.push({
        severity: "warning",
        type: "missing_pricing",
        description: `No pricing entry for "${item.name_canonical}"`,
        entityId: item._id,
      });
    }
    if (!photoNames.has(item.name_canonical)) {
      issues.push({
        severity: "warning",
        type: "missing_photo",
        description: `No listing photo for "${item.name_canonical}"`,
        entityId: item._id,
      });
    }
  }

  // --- Reservation scan (confirmed, recent) ---
  let reservations = opts.reservations;
  if (accountSlug) {
    reservations = reservations.filter((r) => r.account_slug === accountSlug);
  }
  for (const r of reservations) {
    if (!r.renter_id) {
      issues.push({
        severity: "warning",
        type: "missing_renter",
        description: `Reservation ${r._id} has no renter link`,
        entityId: r._id,
      });
    }
    if (!r.end_date) {
      issues.push({
        severity: "error",
        type: "missing_end_date",
        description: `Confirmed reservation ${r._id} has no end date`,
        entityId: r._id,
      });
    }
  }

  return issues;
}

/**
 * W20 Health & Scanner - system health + data quality issues
 *
 * 2026-07-12 cost audit: split into a cached issue scan + a live freshness
 * badge. The badge (account_state + settings — 4 tiny docs) stays live so
 * the "Hygglo Sync" pill is real-time; the expensive scans serve from the
 * hourly mv_widgets row. A poller heartbeat now re-reads ~4 small docs +
 * one MV row instead of items+photos+pricing+365d reservations per tab.
 */
export const getHealthReport = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const settings = await ctx.db.query("settings").first();

    // Poller freshness — the "Hygglo Sync" badge must reflect whether the poller
    // is actually INGESTING, not whether outbound writes are enabled. Was derived
    // from ALLOW_HYGGLO_SEND (a send-permission flag), so a dead poller still
    // showed "Live". account_state.lastSuccessfulPollAt is stamped every real
    // poll cycle; the freshest across all accounts tells us the poller is alive.
    const accountStates = await ctx.db.query("account_state").collect();
    const freshestPollAt = accountStates.reduce(
      (mx, a) => Math.max(mx, a.lastSuccessfulPollAt ?? 0),
      0,
    );
    const pollAgeMinutes =
      freshestPollAt > 0 ? Math.floor((Date.now() - freshestPollAt) / 60000) : null;
    const pollerLive = pollAgeMinutes !== null && pollAgeMinutes < 60;

    const badge = {
      // Poller-ingest freshness (live = a successful poll in the last hour).
      syncStatus: pollerLive ? "live" : "stale",
      pollAgeMinutes,
      // Outbound-write permission, kept separate from ingest health.
      sendMode: settings?.ALLOW_HYGGLO_SEND ? "live" : "read_only",
      readOnlyMode: settings?.read_only_mode ?? true,
      pollingIntervalMs: settings?.polling_interval_ms ?? null,
    };

    // MV fast path — issues refresh hourly (data quality moves slowly).
    const cached = (await readWidgetMv(
      ctx,
      `health:${widgetSlugKey(accountSlug)}`,
      FAST_WIDGET_MAX_AGE_MS,
    )) as { issues: HealthIssue[] } | null;
    if (cached !== null) {
      return { ...badge, issues: cached.issues };
    }

    // Cold/stale-cache fallback — original live scan.
    const items = await ctx.db.query("items").collect();
    const photos = await ctx.db.query("listing_photos").collect();
    const pricing = await ctx.db.query("pricing_catalog").collect();
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const reservations = await ctx.db
      .query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();
    const recentConfirmed = reservations.filter(
      (r) => (r.start_date ?? "") >= cutoff,
    );
    const issues = computeHealthIssues({
      items,
      photos,
      pricing,
      reservations: recentConfirmed,
      accountSlug,
    });

    return { ...badge, issues };
  },
});
