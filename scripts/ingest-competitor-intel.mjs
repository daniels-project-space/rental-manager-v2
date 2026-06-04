/**
 * One-time competitor-intel ingest (run via tsx so the TS core imports work):
 *
 *     npx tsx scripts/ingest-competitor-intel.mjs
 *
 * Pulls a LIMITED sample (exactly 100 reviews each, $limit=100&$skip=0) of two
 * competitor vendors' public rental history + their current listings, builds
 * PII-SAFE per-item aggregates (item / date / rating / price only — NEVER
 * reviewer names or text), and writes them to Convex via the public
 * `competitor_intel:replaceAll` mutation. Then reads `getTopItems` back and
 * prints the top 10 (PII-safe).
 *
 * Auth: a Convex deploy key (vault service `convex`, key
 * `CONVEX_DEPLOY_KEY_RMV2`) is resolved and attached when present so the call
 * is authenticated; it is NEVER printed. The mutation is a public function, so
 * the call also succeeds unauthenticated (matching scripts/run-poll-once.mjs).
 *
 * Read-only against Hygglo (public endpoints, no Bearer). NOT on the poll path.
 */
import { ConvexHttpClient } from "convex/browser";
// `convex/_generated/api.js` is `export const api = anyApi`; importing it under
// tsx's ESM loader is flaky, so reference functions via `anyApi` directly
// (identical runtime object — string-path function references).
import { anyApi } from "convex/server";
const api = anyApi;

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL = "https://hearty-oyster-600.convex.cloud";

// The two competitor vendors (from reference_hygglo_competitor_intel).
const VENDOR_IDS = ["7199499054", "9651445"];
const REVIEW_LIMIT = 100;

async function vaultListByService(service) {
  const r = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!r.ok) throw new Error(`vault ${service} -> ${r.status}`);
  const d = await r.json();
  const out = {};
  for (const s of d.value ?? []) out[s.keyName] = s.value;
  return out;
}

async function main() {
  // Resolve the Convex deploy key (never printed). Best-effort — the public
  // mutation also works unauthenticated.
  let deployKey;
  try {
    const convexSecrets = await vaultListByService("convex");
    deployKey =
      convexSecrets.CONVEX_DEPLOY_KEY_RMV2 ?? convexSecrets.CONVEX_DEPLOY_KEY;
  } catch (e) {
    console.warn(`[ingest] vault convex lookup failed (continuing): ${e.message}`);
  }
  console.log(`[ingest] convex deploy key resolved: ${deployKey ? "yes" : "no"}`);

  // Import the PII-firewalled core (TS — requires tsx).
  const { createClient } = await import(
    "/home/ubuntu/rental-manager-v2/src/hygglo-core/client.ts"
  );
  const { getVendorReviews, getVendorListings, getListingPrice } = await import(
    "/home/ubuntu/rental-manager-v2/src/hygglo-core/competitors.ts"
  );
  const { aggregateCompetitorIntel } = await import(
    "/home/ubuntu/rental-manager-v2/src/hygglo-core/competitor-aggregate.ts"
  );

  // Public reads — bind a client to leo (country GB); getPublicJson sends no Bearer.
  const client = createClient("leo");

  const reviewsByVendor = [];
  const listingsByVendor = [];
  for (const vendorId of VENDOR_IDS) {
    const reviews = await getVendorReviews(client, vendorId, {
      limit: REVIEW_LIMIT,
      skip: 0,
    });
    // Prices: the public vendor/owner LISTINGS SEARCH returns 0 rows for these
    // vendors (verified 2026-06-04), so resolve prices from the PUBLIC LISTING
    // DETAIL for each distinct listing id seen in the reviews instead.
    const searchListings = await getVendorListings(client, vendorId).catch(
      () => [],
    );
    const ids = [
      ...new Set(
        reviews
          .map((r) => r.listingId)
          .filter((x) => typeof x === "number"),
      ),
    ];
    const detailListings = [];
    for (const id of ids) {
      const fact = await getListingPrice(client, id);
      if (fact) detailListings.push(fact);
    }
    const listings = [...searchListings, ...detailListings];
    const priced = listings.filter((l) => typeof l.dailyPrice === "number");
    console.log(
      `[ingest] vendor ${vendorId}: ${reviews.length} reviews, ` +
        `${ids.length} distinct listings, ${priced.length} priced`,
    );
    reviewsByVendor.push({ vendorId, reviews });
    listingsByVendor.push({ vendorId, listings });
  }

  const agg = aggregateCompetitorIntel(reviewsByVendor, listingsByVendor);
  console.log(
    `[ingest] aggregated ${agg.items.length} distinct items from ${agg.reviewsSampled} reviews; ${agg.unmatchedPriceCount} items without a matched price`,
  );

  // Write to Convex (public mutation).
  const convex = new ConvexHttpClient(CONVEX_URL);
  if (deployKey && typeof convex.setAdminAuth === "function") {
    try {
      convex.setAdminAuth(deployKey);
    } catch {
      /* fall back to unauthenticated public-mutation call */
    }
  }

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
  console.log(`[ingest] replaceAll ->`, JSON.stringify(result));

  // Read back + print top 10 (PII-safe).
  const top = await convex.query(api.competitor_intel.getTopItems, { limit: 10 });
  console.log(
    `\n[ingest] === competitor_intel:getTopItems (top 10, PII-safe) ===`,
  );
  console.log(
    `total est. revenue £${top.totalEstRevenueGbp.toFixed(2)} · ` +
      `${top.totalRentalsSampled} rentals sampled · ${top.itemCount} items · ` +
      `${top.reviewsSampled} reviews/${top.vendorsCount} vendors`,
  );
  top.items.forEach((it, i) => {
    const price =
      typeof it.dailyPriceGbp === "number"
        ? `£${it.dailyPriceGbp.toFixed(2)}/day`
        : "no price";
    const rating =
      typeof it.avgRating === "number" ? `★${it.avgRating.toFixed(2)}` : "★—";
    console.log(
      `${String(i + 1).padStart(2)}. ${it.itemName} — ${it.rentalCount} rentals · ` +
        `est £${it.estRevenueGbp.toFixed(2)} · ${price} · ${rating}`,
    );
  });
}

main().catch((e) => {
  console.error("[ingest] FAILED:", e?.message ?? e);
  process.exit(1);
});
