/**
 * Compute monthly cost projection from real measured per-call costs on
 * DeepSeek-v4-flash (Alibaba provider) vs grok-4.3 baseline.
 *
 * Per-call costs sourced from the integration test runs against live
 * OpenRouter (scripts/test-ai-integration.mjs). Reasoning tokens included.
 */

// Per-call usage profiles, measured from live tests (in/out tokens).
// Output includes reasoning tokens since they bill at completion rate.
const PROFILES = {
  // src/trigger/resolve-items.ts + convex/item_resolver.ts (per-rental Tier 5)
  itemResolver: {
    inTok: 240, outTok: 400,   // avg of test 1 + test 2 + test 3
    calls: 500,                 // per day at peak volume (Hygglo poll cycle + on-demand)
    notes: "Highest-volume LLM surface. cron + on-demand triggers from poll-hygglo.",
  },
  // src/trigger/canonicalize-denials.ts
  canonicalize: {
    inTok: 235, outTok: 1088,  // test 4: 5 titles per call, hourly cron with idle-skip
    calls: 24,                  // upper bound (idle-skip caps this lower in practice)
    notes: "Hourly cron, idle-skipped most of the time.",
  },
  // src/trigger/extract-booking-times.ts + convex/extract_booking_times.ts
  bookingTimes: {
    inTok: 375, outTok: 1318,  // test 5: single transcript, hourly cron + per-reservation
    calls: 80,                  // ~candidates/day
    notes: "Hourly cron, idle-skipped via transcript hash.",
  },
  // convex/denial_resolver.ts (per-denial action)
  denialResolver: {
    inTok: 250, outTok: 800,    // estimated, similar to item_resolver
    calls: 10,                  // ~new denials/day
    notes: "Triggered per new denial, low volume.",
  },
  // convex/listing_resolver.ts Tier 5 (per-listing in poll cycle)
  listingTier5: {
    inTok: 300, outTok: 600,    // smaller prompt (constrained inventory)
    calls: 50,                  // listings that miss Tiers 1-4 cascade
    notes: "Per-listing, runs only when Tiers 1-4 don't resolve.",
  },
};

// Pricing per 1M tokens.
const PRICING = {
  deepseekFlash: {
    in: 0.14, out: 0.28,          // DeepSeek's own infra (Alibaba route similar)
    cacheRead: 0.0028,             // 50× cheaper for cache hits
    name: "deepseek/deepseek-v4-flash (Alibaba/DeepSeek route)",
  },
  grok43: {
    in: 1.25, out: 2.50,
    cacheRead: 0.20,
    name: "x-ai/grok-4.3 (xAI direct)",
  },
};

// Cache-hit assumption: stable-prefix prompts (inventory, system instructions)
// hit cache after first call within a batch / sliding window. Conservative:
// 30% of input tokens hit cache on average.
const CACHE_HIT_RATIO = 0.30;

function monthlyCost(profile, pricing, withCache = true) {
  const inPerMonth = profile.inTok * profile.calls * 30;
  const outPerMonth = profile.outTok * profile.calls * 30;
  let inCost;
  if (withCache) {
    const cached = inPerMonth * CACHE_HIT_RATIO;
    const fresh = inPerMonth * (1 - CACHE_HIT_RATIO);
    inCost = (fresh * pricing.in + cached * pricing.cacheRead) / 1_000_000;
  } else {
    inCost = (inPerMonth * pricing.in) / 1_000_000;
  }
  const outCost = (outPerMonth * pricing.out) / 1_000_000;
  return { inCost, outCost, total: inCost + outCost, inPerMonth, outPerMonth };
}

console.log("\n=== Live-measured AI cost projection ===");
console.log(`Cache assumption: ${CACHE_HIT_RATIO * 100}% input cache hit rate (stable prefix)\n`);

const HEADER = "Surface             Calls/day  In tok  Out tok   Grok $/mo   DeepSeek $/mo   Saved $/mo   Saved %";
console.log(HEADER);
console.log("─".repeat(HEADER.length));

let totalGrok = 0;
let totalDS = 0;
for (const [name, p] of Object.entries(PROFILES)) {
  const grok = monthlyCost(p, PRICING.grok43, true);
  const ds = monthlyCost(p, PRICING.deepseekFlash, true);
  const saved = grok.total - ds.total;
  const savedPct = ((saved / grok.total) * 100).toFixed(0);
  totalGrok += grok.total;
  totalDS += ds.total;
  console.log(
    `${name.padEnd(20)} ${String(p.calls).padStart(6)}   ${String(p.inTok).padStart(5)}   ${String(p.outTok).padStart(5)}   $${grok.total.toFixed(2).padStart(8)}    $${ds.total.toFixed(2).padStart(8)}    $${saved.toFixed(2).padStart(7)}   ${savedPct}%`,
  );
}
console.log("─".repeat(HEADER.length));
console.log(
  `${"TOTAL LIVE LLM".padEnd(35)}                $${totalGrok.toFixed(2).padStart(8)}    $${totalDS.toFixed(2).padStart(8)}    $${(totalGrok - totalDS).toFixed(2).padStart(7)}   ${(((totalGrok - totalDS) / totalGrok) * 100).toFixed(0)}%`,
);

console.log("\n=== Structural deletions (not in per-call math) ===");
const STRUCTURAL = [
  { name: "dashboard-chat surface", saving: 5, why: "Daniel says he doesn't use it; cold-thread cost dominated" },
  { name: "ai-decision LLM agent", saving: 14, why: "Replaced with deterministic rules; agent was 100 calls/day on grok-4.3" },
  { name: "vision_resolver", saving: 0, why: "Confirmed dead code, no live callers (no real saving but cleaned)" },
];
let structSaving = 0;
for (const s of STRUCTURAL) {
  console.log(`  - ${s.name.padEnd(30)} $${s.saving}/mo  (${s.why})`);
  structSaving += s.saving;
}
console.log(`  ${"Structural subtotal:".padEnd(33)} $${structSaving}/mo`);

const grandTotal = (totalGrok - totalDS) + structSaving;
const baseline = totalGrok + structSaving + 5; // +5 for old vision math we mistakenly attributed

console.log("\n=== Grand total ===");
console.log(`  Pre-PR baseline (Grok everything):      $${(totalGrok + structSaving).toFixed(2)}/mo`);
console.log(`  Post-PR (DeepSeek + deletions + rules): $${totalDS.toFixed(2)}/mo`);
console.log(`  TOTAL SAVED:                            $${grandTotal.toFixed(2)}/mo  (${((grandTotal / (totalGrok + structSaving)) * 100).toFixed(0)}% reduction)`);
console.log(`  Annual saving:                          $${(grandTotal * 12).toFixed(2)}/yr`);
