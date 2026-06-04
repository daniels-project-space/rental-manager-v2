/**
 * competitor-intel-sync — scheduled activation of the (already built) PII-safe
 * competitor-intel aggregate path.
 *
 * Mirrors the structure of `catalog-sync.ts`: a shared core routine driven by
 * a weekly off-peak schedule plus an on-demand entry point (with dryRun).
 *
 * What it does, end to end:
 *   1. Pull a BOUNDED sample of each competitor vendor's PUBLIC rental history
 *      (`getVendorReviews`, $limit=100) + resolve current list prices from the
 *      public listing detail of each distinct listing id seen.
 *   2. Run the pure `aggregateCompetitorIntel` rollup (one row per item name,
 *      merged across vendors). PII firewall lives in `competitors.ts` — only
 *      item / date / rating / price aggregates ever leave the fetch boundary;
 *      NEVER reviewer names or text.
 *   3. Persist wholesale via the public `competitor_intel:replaceAll` mutation
 *      (clear + insert; idempotent) so the dashboard widget shows live data
 *      instead of the stale one-time sample.
 *
 * READ-ONLY against Hygglo: only PUBLIC v2 GETs (no Bearer); the only writes
 * are to Convex. Cadence is WEEKLY — these are slow-moving, PII-safe market
 * aggregates and we must not hammer Hygglo. This is the ONLY scheduled writer
 * for `competitor_intel`; the previous writer was the one-time
 * `scripts/ingest-competitor-intel.mjs`.
 *
 * Auth: `createClient(slug)` resolves credentials via the SAME vault path the
 * order poller + catalog sync use. No secrets are handled in this file. (The
 * vendor-review/listing endpoints are public and need no Bearer, but binding a
 * client keeps host/country resolution identical to the rest of the stack.)
 */

import { schedules, task, logger } from "@trigger.dev/sdk/v3";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { createClient } from "../hygglo-core/client";
import {
  getVendorReviews,
  getListingPrice,
  getVendorListings,
} from "../hygglo-core/competitors";
import type {
  CompetitorReviewFact,
  CompetitorListingFact,
} from "../hygglo-core/competitors";
import { aggregateCompetitorIntel } from "../hygglo-core/competitor-aggregate";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// Competitor vendors to sample (from reference_hygglo_competitor_intel). Public
// rental-review history is pulled per vendor; aggregates only, PII-safe.
const VENDOR_IDS: ReadonlyArray<string> = ["7199499054", "9651445"];

// Bounded sample per vendor — matches the one-time ingest script. Keeps the
// load on Hygglo small (one reviews call + a handful of listing-detail GETs).
const REVIEW_LIMIT = 100;

// The account slug whose (public) client we bind for the public reads. `leo`
// matches the ingest script; no Bearer is sent for these public endpoints.
const CLIENT_SLUG = "leo";

interface SyncResult {
  itemCount: number;
  reviewsSampled: number;
  vendorsCount: number;
  unmatchedPriceCount: number;
  totalEstRevenueGbp: number;
  totalRentalsSampled: number;
  durationMs: number;
  dryRun: boolean;
}

interface SyncOptions {
  /** When true, fetch + aggregate but do NOT write competitor_intel. */
  dryRun?: boolean;
}

async function runCompetitorIntelSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const dryRun = opts.dryRun === true;
  const runStart = Date.now();
  const client = createClient(CLIENT_SLUG);

  const reviewsByVendor: Array<{
    vendorId: string;
    reviews: CompetitorReviewFact[];
  }> = [];
  const listingsByVendor: Array<{
    vendorId: string;
    listings: CompetitorListingFact[];
  }> = [];

  for (const vendorId of VENDOR_IDS) {
    const reviews = await getVendorReviews(client, vendorId, {
      limit: REVIEW_LIMIT,
      skip: 0,
    });

    // The public listings-search returns 0 rows for these vendors, so resolve
    // prices from the PUBLIC listing detail for each distinct listing id seen
    // in the reviews (same strategy as the ingest script).
    const searchListings = await getVendorListings(client, vendorId).catch(
      () => [] as CompetitorListingFact[],
    );
    const ids = [
      ...new Set(
        reviews
          .map((r) => r.listingId)
          .filter((x): x is number => typeof x === "number"),
      ),
    ];
    const detailListings: CompetitorListingFact[] = [];
    for (const id of ids) {
      const fact = await getListingPrice(client, id);
      if (fact) detailListings.push(fact);
    }
    const listings = [...searchListings, ...detailListings];

    logger.info("[competitor-intel] vendor sampled", {
      vendorId,
      reviews: reviews.length,
      distinctListings: ids.length,
      priced: listings.filter((l) => typeof l.dailyPrice === "number").length,
    });

    reviewsByVendor.push({ vendorId, reviews });
    listingsByVendor.push({ vendorId, listings });
  }

  const agg = aggregateCompetitorIntel(reviewsByVendor, listingsByVendor);
  logger.info("[competitor-intel] aggregated", {
    items: agg.items.length,
    reviewsSampled: agg.reviewsSampled,
    vendorsCount: agg.vendorsCount,
    unmatchedPriceCount: agg.unmatchedPriceCount,
    dryRun,
  });

  const convex = new ConvexHttpClient(CONVEX_URL);
  let itemCount = agg.items.length;
  let totalEstRevenueGbp = 0;
  let totalRentalsSampled = 0;

  if (!dryRun) {
    const result = await convex.mutation(api.competitor_intel.replaceAll, {
      items: agg.items.map((it) => ({
        itemName: it.itemName,
        vendorIds: it.vendorIds,
        rentalCount: it.rentalCount,
        lastRentedAt: it.lastRentedAt,
        ...(typeof it.avgRating === "number" ? { avgRating: it.avgRating } : {}),
        ...(typeof it.dailyPriceGbp === "number"
          ? { dailyPriceGbp: it.dailyPriceGbp }
          : {}),
        estRevenueGbp: it.estRevenueGbp,
      })),
      meta: {
        reviewsSampled: agg.reviewsSampled,
        vendorsCount: agg.vendorsCount,
        unmatchedPriceCount: agg.unmatchedPriceCount,
      },
    });
    itemCount = result.itemCount;
    totalEstRevenueGbp = result.totalEstRevenueGbp;
    totalRentalsSampled = result.totalRentalsSampled;
  }

  const durationMs = Date.now() - runStart;

  // Record a sync_state run under a distinct source so it never collides with
  // the poller / catalog rows.
  try {
    await convex.mutation(api.sync_state.recordSyncRun, {
      source: "hygglo_competitor_intel",
      succeeded: true,
      durationMs,
    });
  } catch (syncErr) {
    logger.error("[competitor-intel] recordSyncRun failed", {
      err: String(syncErr),
    });
  }

  return {
    itemCount,
    reviewsSampled: agg.reviewsSampled,
    vendorsCount: agg.vendorsCount,
    unmatchedPriceCount: agg.unmatchedPriceCount,
    totalEstRevenueGbp,
    totalRentalsSampled,
    durationMs,
    dryRun,
  };
}

// ── Tasks ────────────────────────────────────────────────────────────────────

/**
 * Weekly off-peak competitor-intel refresh. Sunday 05:13 UTC — a low-traffic
 * UK window (early Sunday morning), deliberately offset from the daily catalog
 * sync ("37 4 * * *") so the two never overlap.
 */
export const competitorIntelSyncTask = schedules.task({
  id: "competitor-intel-sync",
  cron: "13 5 * * 0",
  maxDuration: 300,
  retry: { maxAttempts: 2 },
  run: async () => {
    const result = await runCompetitorIntelSync({ dryRun: false });
    return { ...result, ts: Date.now() };
  },
});

/**
 * On-demand competitor-intel sync. Accepts `{ dryRun }` so an operator can
 * validate the read-only fetch+aggregate (no Convex write) before a live run.
 */
export const competitorIntelSyncOnDemandTask = task({
  id: "competitor-intel-sync-on-demand",
  maxDuration: 300,
  run: async (payload: { dryRun?: boolean } = {}) => {
    const result = await runCompetitorIntelSync({
      dryRun: payload.dryRun === true,
    });
    return { ...result, ts: Date.now() };
  },
});
